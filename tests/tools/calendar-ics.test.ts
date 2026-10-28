import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCalendarExportRequest, writeObservedCalendarIcs } from '../../src/tools/calendar-ics.js';

const options = { startDate: '2026-11-01', endDate: '2026-11-30', timeZone: 'America/Phoenix' };
const native = { id: 101, type: 'EVENT', title: 'Synthetic event', allDay: false,
  startDate: { dateTime: '2026-11-12T08:30:00' },
  endDate: { dateTime: '2026-11-12T09:30:00' } };

const roots: string[] = [];
const originalRoot = process.env.OFW_CALENDAR_EXPORT_DIR;
const originalCacheDir = process.env.OFW_CACHE_DIR;
const originalIdentity = process.env.OFW_CACHE_IDENTITY;
const originalHome = process.env.HOME;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.OFW_CALENDAR_EXPORT_DIR;
  else process.env.OFW_CALENDAR_EXPORT_DIR = originalRoot;
  if (originalCacheDir === undefined) delete process.env.OFW_CACHE_DIR;
  else process.env.OFW_CACHE_DIR = originalCacheDir;
  if (originalIdentity === undefined) delete process.env.OFW_CACHE_IDENTITY;
  else process.env.OFW_CACHE_IDENTITY = originalIdentity;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function setExportRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ofw-calendar-ics-test-'));
  roots.push(root);
  process.env.OFW_CALENDAR_EXPORT_DIR = join(root, 'export');
  return root;
}

async function exportData(data: unknown, opts = options) {
  setExportRoot();
  const receipt = await writeObservedCalendarIcs(data, opts);
  const ics = readFileSync(receipt.path as string, 'utf8');
  const manifest = JSON.parse(readFileSync(receipt.manifestPath as string, 'utf8'));
  return { receipt, ics, manifest };
}

async function exportRows(rows: unknown[], opts = options) {
  return exportData({ calendarItems: rows }, opts);
}

describe('observed calendar export edge cases', () => {
  it('uses a private default directory when no output override is set', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ofw-ics-home-'));
    roots.push(home);
    process.env.HOME = home;
    delete process.env.OFW_CALENDAR_EXPORT_DIR;
    const receipt = await writeObservedCalendarIcs({ calendarItems: [] }, options);
    expect(receipt.path).toMatch(/^\/tmp\/ofw-ics-home-[^/]+\/Downloads\/ofw-mcp\/calendar\//);
    expect(statSync(join(home, 'Downloads', 'ofw-mcp', 'calendar')).mode & 0o077).toBe(0);
  });

  it('omits rows without an explicit timed-event flag', async () => {
    const { receipt, ics, manifest } = await exportRows([
      { ...native, allDay: undefined },
      { ...native, id: 102, allDay: 'false' },
    ]);
    expect(receipt.includedCount).toBe(0);
    expect(receipt.omittedCount).toBe(2);
    expect(manifest.omissions.map((row: { reason: string }) => row.reason))
      .toEqual(['all_day_semantics_unverified', 'all_day_semantics_unverified']);
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('refuses an oversized rendered snapshot before creating files', async () => {
    const large = '🟠'.repeat(2000);
    const rows = Array.from({ length: 350 }, (_, index) => ({ ...native, id: index + 1,
      title: large, location: large,
      startDate: { dateTime: '2026-11-12T15:30:00Z' },
      endDate: { dateTime: '2026-11-12T16:30:00Z' } }));
    await expect(writeObservedCalendarIcs({ calendarItems: rows }, options))
      .rejects.toThrow('CALENDAR_EXPORT_TOO_LARGE');
  });

  it('accounts for an identical duplicate source row without a second VEVENT', async () => {
    const { receipt, ics, manifest } = await exportRows([native, native]);
    expect(receipt.rawRows).toBe(2);
    expect(receipt.includedCount).toBe(1);
    expect(receipt.omittedCount).toBe(1);
    expect(manifest.omissions).toEqual([
      { rowIndex: 1, sourceId: 'EVENT:101', reason: 'duplicate_identical_source_row' },
    ]);
    expect((ics.match(/BEGIN:VEVENT/g) ?? [])).toHaveLength(1);
  });

  it('omits a source interval that mixes offset-bearing and local wall clocks', async () => {
    const { receipt, ics, manifest } = await exportRows([{ ...native,
      startDate: { dateTime: '2026-11-12T08:30:00-07:00' } }]);
    expect(receipt.includedCount).toBe(0);
    expect(receipt.omittedCount).toBe(1);
    expect(manifest.omissions[0].reason).toBe('mixed_source_clock_basis');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('omits unsafe control characters from a source title', async () => {
    const { receipt, manifest } = await exportRows([{ ...native, title: 'Synthetic\u0000event' }]);
    expect(receipt.includedCount).toBe(0);
    expect(manifest.omissions[0].reason).toBe('invalid_text');
  });

  it('omits an offset-bearing date that JavaScript normalizes to a different day', async () => {
    const { receipt, manifest } = await exportRows([{ ...native,
      startDate: { dateTime: '2026-02-30T08:30:00-07:00' },
      endDate: { dateTime: '2026-02-30T09:30:00-07:00' } }]);
    expect(receipt.includedCount).toBe(0);
    expect(manifest.omissions[0].reason).toBe('missing_invalid_or_ambiguous_interval');
  });

  it('describes a private static snapshot without an iTIP publish method', async () => {
    const { ics, manifest } = await exportRows([native]);
    expect(ics).not.toContain('METHOD:PUBLISH');
    expect(manifest.staticSnapshot).toBe(true);
    expect(manifest.sourceCoverageComplete).toBe(false);
  });

  it('rejects invalid request dates, reversed or oversized windows, and unknown zones', () => {
    const badRanges: Array<[string, string]> = [
      ['2026/11/01', '2026-11-30'], ['2026-11-01', '2026/11/30'],
      ['2026-13-01', '2026-11-30'], ['2026-11-01', '2026-13-30'],
      ['2026-02-30', '2026-03-01'], ['2026-02-01', '2026-02-30'],
      ['2026-11-30', '2026-11-01'], ['2026-11-01', '2026-12-02'],
    ];
    for (const [start, end] of badRanges) {
      expect(() => validateCalendarExportRequest(start, end, options.timeZone))
        .toThrow('INVALID_CALENDAR_RANGE');
    }
    expect(() => validateCalendarExportRequest(options.startDate, options.endDate, 'Not/A_Zone'))
      .toThrow('INVALID_CALENDAR_TIMEZONE');
  });

  it('accepts documented list and data wrappers, and rejects unknown or oversized responses', async () => {
    for (const data of [[native], { data: [native] }, { calendarItems: { data: [native] } }]) {
      expect((await exportData(data)).receipt.includedCount).toBe(1);
    }
    for (const data of [null, { calendarItems: {} }, { calendarItems: Array(501).fill(native) },
      { calendarItems: [null] }, { calendarItems: [1] }, { calendarItems: [[]] }]) {
      await expect(writeObservedCalendarIcs(data, options)).rejects.toThrow('CALENDAR_RESPONSE_UNSUPPORTED');
    }
  });

  it('omits unqualified identities and accepts the recurrence ID alias', async () => {
    const invalid = [
      { ...native, type: 'UNKNOWN', id: 201 },
      { ...native, id: undefined },
      { ...native, id: 0 },
      { ...native, id: 1.5 },
      { ...native, id: 204, eventRecurrenceId: 205 },
      { ...native, id: 206, type: 'CONNECTED_EVENT', connectedCalendarSubscriptionId: {} },
      { ...native, id: 207, type: 'CONNECTED_EVENT', connectedCalendarSubscriptionId: 'not-a-number' },
    ];
    const valid = { ...native, id: undefined, eventRecurrenceId: 208 };
    const { receipt, manifest } = await exportRows([...invalid, valid]);
    expect(receipt.includedCount).toBe(1);
    expect(receipt.omittedCount).toBe(invalid.length);
    expect(manifest.selectedSourceIds[0].sourceId).toBe('EVENT:208');
  });

  it('fails closed on conflicting duplicate source identities', async () => {
    await expect(writeObservedCalendarIcs({ calendarItems: [native, { ...native, title: 'Different' }] }, options))
      .rejects.toThrow('CALENDAR_SOURCE_ID_COLLISION');
  });

  it('omits all-day, malformed, missing, reversed, and ambiguous local intervals', async () => {
    const rows = [
      { ...native, id: 301, allDay: true },
      { ...native, id: 302, startDate: undefined },
      { ...native, id: 303, startDate: [] },
      { ...native, id: 304, startDate: { dateTime: 123 } },
      { ...native, id: 305, startDate: { dateTime: '2026-11-12T08:30:00.123' } },
      { ...native, id: 306, startDate: { dateTime: '2026-13-12T08:30:00' } },
      { ...native, id: 307, startDate: { dateTime: '2026-02-30T08:30:00' } },
      { ...native, id: 308, endDate: { dateTime: '2026-11-12T08:00:00' } },
      { ...native, id: 309, endDate: { dateTime: '2026-11-12T08:30:00' } },
      { ...native, id: 310, startDate: { dateTime: '2026-11-12T08:30:00+25:00' },
        endDate: { dateTime: '2026-11-12T09:30:00+25:00' } },
    ];
    const { receipt, manifest } = await exportRows(rows);
    expect(receipt.includedCount).toBe(0);
    expect(receipt.omittedCount).toBe(rows.length);
    expect(manifest.omissions[0].reason).toBe('all_day_semantics_unverified');
    expect(manifest.omissions.slice(1).every((x: { reason: string }) =>
      x.reason === 'missing_invalid_or_ambiguous_interval')).toBe(true);

    const ny = { ...options, timeZone: 'America/New_York' };
    const dstRows = [
      { ...native, id: 311, startDate: { dateTime: '2026-03-08T02:30:00' },
        endDate: { dateTime: '2026-03-08T03:30:00' } },
      { ...native, id: 312, startDate: { dateTime: '2026-11-01T01:30:00' },
        endDate: { dateTime: '2026-11-01T02:30:00' } },
    ];
    expect((await exportRows(dstRows, ny)).receipt.omittedCount).toBe(2);
  });

  it('accepts explicit Z and offsets, escapes text, and folds UTF-8 at 75 octets', async () => {
    const longTitle = 'Synthetic ' + '🟠'.repeat(35) + ';comma,back\\slash\nnext';
    const { ics, receipt } = await exportRows([
      { ...native, id: 401, title: longTitle, location: 'Gym, Room; A',
        startDate: { dateTime: '2026-11-12T15:30:00Z' },
        endDate: { dateTime: '2026-11-12T16:30:00Z' } },
      { ...native, id: 402, startDate: { dateTime: '2026-11-12T08:30:00-07:00' },
        endDate: { dateTime: '2026-11-12T09:30:00-07:00' } },
    ]);
    expect(receipt.includedCount).toBe(2);
    expect(ics.replace(/\r\n /g, '')).toContain('SUMMARY:Synthetic ' + '🟠'.repeat(35)
      + '\\;comma\\,back\\\\slash\\nnext');
    expect(ics).toContain('LOCATION:Gym\\, Room\\; A');
    expect((ics.match(/DTSTART:20261112T153000Z/g) ?? [])).toHaveLength(2);
    expect(ics.split('\r\n').filter(Boolean).every((line) => Buffer.byteLength(line, 'utf8') <= 75)).toBe(true);
    expect(ics.endsWith('\r\n')).toBe(true);
  });

  it('omits invalid title and location text', async () => {
    const rows = [
      { ...native, id: 501, title: '' },
      { ...native, id: 502, title: 'x'.repeat(4001) },
      { ...native, id: 503, location: 7 },
      { ...native, id: 504, location: 'x'.repeat(4001) },
      { ...native, id: 505, location: 'Gym\u0001' },
    ];
    const { receipt, manifest } = await exportRows(rows);
    expect(receipt.omittedCount).toBe(rows.length);
    expect(manifest.omissions.every((x: { reason: string }) => x.reason === 'invalid_text')).toBe(true);
  });

  it('keeps opaque UIDs stable when the cache directory moves', async () => {
    process.env.OFW_CACHE_IDENTITY = 'synthetic-identity';
    process.env.OFW_CACHE_DIR = '/tmp/synthetic-cache-a';
    const first = await exportRows([native]);
    process.env.OFW_CACHE_DIR = '/tmp/synthetic-cache-b';
    const second = await exportRows([native]);
    const uid = (ics: string) => ics.replace(/\r\n /g, '').match(/UID:([^\r\n]+)/)?.[1];
    expect(uid(first.ics)).toBe(uid(second.ics));
  });

  it('rejects a relative output root or a symlink root', async () => {
    process.env.OFW_CALENDAR_EXPORT_DIR = 'relative/calendar';
    await expect(writeObservedCalendarIcs([], options)).rejects.toThrow('CALENDAR_EXPORT_DIR_MUST_BE_ABSOLUTE');
    const root = setExportRoot();
    const link = join(root, 'link');
    symlinkSync(root, link);
    process.env.OFW_CALENDAR_EXPORT_DIR = link;
    await expect(writeObservedCalendarIcs([], options)).rejects.toThrow('CALENDAR_EXPORT_DIR_UNSAFE');
  });

  it('refuses an existing shared output directory without changing its permissions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ofw-calendar-shared-test-'));
    roots.push(root);
    chmodSync(root, 0o755);
    process.env.OFW_CALENDAR_EXPORT_DIR = root;
    await expect(writeObservedCalendarIcs({ calendarItems: [native] }, options))
      .rejects.toThrow('CALENDAR_EXPORT_DIR_NOT_PRIVATE');
    expect(statSync(root).mode & 0o777).toBe(0o755);
  });

  it('refuses a symlinked output ancestor before creating its child directory', async () => {
    const root = setExportRoot();
    const actual = join(root, 'actual');
    mkdirSync(actual, { mode: 0o700 });
    const alias = join(root, 'alias');
    symlinkSync(actual, alias);
    process.env.OFW_CALENDAR_EXPORT_DIR = join(alias, 'new-child');
    await expect(writeObservedCalendarIcs({ calendarItems: [native] }, options))
      .rejects.toThrow('CALENDAR_EXPORT_DIR_UNSAFE');
    expect(existsSync(join(actual, 'new-child'))).toBe(false);
  });
});
