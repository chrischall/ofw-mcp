import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DISPLAY_TZ,
  displayTimeZone,
  formatInstant,
  isNaiveTimestamp,
  normalizeTimestampsInValue,
  parseTimestampValue,
} from '../src/timestamps.js';

const ET = 'America/New_York';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('displayTimeZone', () => {
  it('defaults to this deployment’s zone', () => {
    expect(displayTimeZone()).toBe(DEFAULT_DISPLAY_TZ);
  });

  it('honours DISPLAY_TZ', () => {
    vi.stubEnv('DISPLAY_TZ', 'America/Los_Angeles');
    expect(displayTimeZone()).toBe('America/Los_Angeles');
  });

  it('falls back when DISPLAY_TZ is not a real IANA zone', () => {
    vi.stubEnv('DISPLAY_TZ', 'Mars/Olympus_Mons');
    expect(displayTimeZone()).toBe(DEFAULT_DISPLAY_TZ);
  });
});

describe('formatInstant', () => {
  // DST comes from the IANA database, not a fixed offset.
  it('renders -05:00 in January and -04:00 in July', () => {
    expect(formatInstant(new Date('2026-01-15T17:00:00Z'), ET).iso).toBe('2026-01-15T12:00:00-05:00');
    expect(formatInstant(new Date('2026-07-15T17:00:00Z'), ET).iso).toBe('2026-07-15T13:00:00-04:00');
  });

  it('renders a positive offset east of UTC, +00:00 at UTC, and half-hour zones', () => {
    expect(formatInstant(new Date('2026-07-15T17:00:00Z'), 'Asia/Tokyo').iso).toBe('2026-07-16T02:00:00+09:00');
    expect(formatInstant(new Date('2026-07-15T17:00:00Z'), 'UTC').iso).toBe('2026-07-15T17:00:00+00:00');
    expect(formatInstant(new Date('2026-07-15T00:00:00Z'), 'Asia/Kolkata').iso).toBe('2026-07-15T05:30:00+05:30');
  });

  it('pins midnight to hour 00 rather than 24', () => {
    expect(formatInstant(new Date('2026-07-15T04:00:00Z'), ET).iso).toBe('2026-07-15T00:00:00-04:00');
  });

  it('includes the weekday, which is what makes a date-boundary error visible', () => {
    const { display } = formatInstant(new Date('2026-07-28T03:36:00Z'), ET);
    expect(display).toContain('Mon');
    expect(display).toContain('Jul 27');
  });
});

describe('parseTimestampValue', () => {
  it('interprets OFW’s naive local value in the configured zone', () => {
    expect(parseTimestampValue('sentAt', '2026-07-27T23:31:09', ET)?.toISOString())
      .toBe('2026-07-28T03:31:09.000Z');
  });

  it('trusts an offset the source already carries', () => {
    expect(parseTimestampValue('fetchedBodyAt', '2026-07-28T12:11:19.106Z', ET)?.toISOString())
      .toBe('2026-07-28T12:11:19.106Z');
  });

  it('leaves a date-only value alone', () => {
    expect(parseTimestampValue('date', '2026-07-28', ET)).toBeNull();
  });

  it('preserves sub-second precision on a naive value', () => {
    expect(parseTimestampValue('fetchedBodyAt', '2026-07-28T12:11:19.106', ET)?.toISOString())
      .toBe('2026-07-28T16:11:19.106Z');
  });

  it('ignores non-timestamp and non-string values', () => {
    expect(parseTimestampValue('sentAt', 'sometime last week', ET)).toBeNull();
    expect(parseTimestampValue('sentAt', 12345, ET)).toBeNull();
    expect(parseTimestampValue('sentAt', null, ET)).toBeNull();
    expect(parseTimestampValue('sentAt', '', ET)).toBeNull();
  });

  it('rejects a well-shaped but impossible date', () => {
    expect(parseTimestampValue('sentAt', '2026-99-01T00:00:00Z', ET)).toBeNull();
  });
});

describe('normalizeTimestampsInValue', () => {
  // The reported defect: one object mixing naive-local and UTC values.
  it('normalizes the naive/UTC mix into a single zone', () => {
    const out = normalizeTimestampsInValue({
      sentAt: '2026-07-27T23:31:09',
      viewedAt: '2026-07-28T09:37:11',
      modifiedAt: '2026-07-27T23:31:09',
      fetchedBodyAt: '2026-07-28T12:11:19.106Z',
      freshness: { asOf: '2026-07-28T20:27:11.426Z' },
    }, ET);
    expect(out.sentAt).toBe('2026-07-27T23:31:09-04:00');
    expect(out.viewedAt).toBe('2026-07-28T09:37:11-04:00');
    expect(out.modifiedAt).toBe('2026-07-27T23:31:09-04:00');
    expect(out.fetchedBodyAt).toBe('2026-07-28T08:11:19.106-04:00');
    expect(out.freshness.asOf).toBe('2026-07-28T16:27:11.426-04:00');
  });

  it('pairs every timestamp with a weekday-bearing display value', () => {
    const out = normalizeTimestampsInValue({ sentAt: '2026-07-27T23:31:09' }, ET);
    expect(out.sentAtDisplay).toContain('Mon');
    expect(out.sentAtDisplay).toContain('Jul 27');
    expect(out.sentAtDisplay).toContain('11:31 PM');
  });

  // The harm: a 10:38 PM ET send must never surface on the next calendar day.
  it('never reports a late-evening send on the following day', () => {
    const out = normalizeTimestampsInValue({ sentAt: '2026-07-27T22:38:00' }, ET);
    expect(out.sentAt.startsWith('2026-07-27')).toBe(true);
    expect(out.sentAtDisplay).toContain('Jul 27');
  });

  it('keeps OFW and Gmail contemporaneous events five minutes apart on one day', () => {
    const out = normalizeTimestampsInValue({
      ofw: { sentAt: '2026-07-27T23:31:09' },
      gmail: { date: '2026-07-27 23:36:09' },
    }, ET);
    expect(out.ofw.sentAt).toBe('2026-07-27T23:31:09-04:00');
    expect(out.gmail.date).toBe('2026-07-27T23:36:09-04:00');
    const delta = Date.parse(out.gmail.date) - Date.parse(out.ofw.sentAt);
    expect(delta).toBe(5 * 60_000);
  });

  it('emits no naive timestamp anywhere in the payload', () => {
    const out = normalizeTimestampsInValue({
      a: { sentAt: '2026-07-27T23:31:09' },
      b: [{ viewedAt: '2026-07-28T09:37:11' }],
      c: { fetchedBodyAt: '2026-07-28T12:11:19.106Z' },
    }, ET);
    const naive: unknown[] = [];
    const scan = (n: unknown): void => {
      if (Array.isArray(n)) return void n.forEach(scan);
      if (n && typeof n === 'object') return void Object.values(n).forEach(scan);
      if (isNaiveTimestamp(n)) naive.push(n);
    };
    scan(out);
    expect(naive).toEqual([]);
  });

  it('never mixes naive and offset-bearing timestamps in one object', () => {
    const out = normalizeTimestampsInValue({
      sentAt: '2026-07-27T23:31:09',
      fetchedBodyAt: '2026-07-28T12:11:19.106Z',
      asOf: '2026-07-28T20:27:11.426Z',
    }, ET);
    const values = [out.sentAt, out.fetchedBodyAt, out.asOf];
    expect(values.every((v) => /[+-]\d{2}:\d{2}$/.test(v))).toBe(true);
    expect(values.some(isNaiveTimestamp)).toBe(false);
  });

  it('DISPLAY_TZ shifts display fields and the offset, nothing else', () => {
    const payload = { id: 1, subject: 'S', sentAt: '2026-07-27T23:31:09' };
    const et = normalizeTimestampsInValue(payload, ET);
    const pt = normalizeTimestampsInValue(payload, 'America/Los_Angeles');
    expect(et.sentAt).not.toBe(pt.sentAt);
    expect(et.sentAtDisplay).not.toBe(pt.sentAtDisplay);
    expect(pt.id).toBe(1);
    expect(pt.subject).toBe('S');
  });

  // Response payloads carry live cache rows; rewriting them in place would
  // corrupt the cache and make normalization observable on a later read.
  it('does not mutate its input', () => {
    const input = { sentAt: '2026-07-27T23:31:09', nested: { viewedAt: '2026-07-28T09:37:11' } };
    const out = normalizeTimestampsInValue(input, ET);
    expect(input.sentAt).toBe('2026-07-27T23:31:09');
    expect(input.nested.viewedAt).toBe('2026-07-28T09:37:11');
    expect(out).not.toBe(input);
  });

  it('leaves the epoch-zero view placeholder recognisable as 1970', () => {
    // mapRecipients/hasRealView key off a "1970-01-01" prefix; normalization
    // must not move the value off that date.
    const out = normalizeTimestampsInValue({ viewedAt: '1970-01-01T00:00:00' }, ET);
    expect(out.viewedAt.startsWith('1970-01-01')).toBe(true);
  });

  it('leaves user content and non-timestamp keys alone', () => {
    const payload = {
      body: 'Let us meet 2026-07-28 03:36 as discussed',
      description: '2026-07-27T23:31:09',
      amount: '2026-07-28',
      count: 5,
    };
    expect(normalizeTimestampsInValue(payload, ET)).toEqual(payload);
  });

  it('passes primitives and null through untouched', () => {
    expect(normalizeTimestampsInValue(null, ET)).toBeNull();
    expect(normalizeTimestampsInValue('a string', ET)).toBe('a string');
    expect(normalizeTimestampsInValue(42, ET)).toBe(42);
  });

  it('normalizes a top-level array', () => {
    const out = normalizeTimestampsInValue([{ sentAt: '2026-07-27T23:31:09' }], ET);
    expect(out[0].sentAt).toBe('2026-07-27T23:31:09-04:00');
  });

  it('is idempotent — re-normalizing changes nothing', () => {
    const once = normalizeTimestampsInValue({ sentAt: '2026-07-27T23:31:09' }, ET);
    expect(normalizeTimestampsInValue(once, ET)).toEqual(once);
  });

  it('handles a DST spring-forward wall time without drifting a day', () => {
    // 2026-03-08 02:30 ET does not exist (clocks jump 02:00 -> 03:00).
    const out = normalizeTimestampsInValue({ sentAt: '2026-03-08 02:30' }, ET);
    expect(out.sentAt.startsWith('2026-03-08')).toBe(true);
    expect(out.sentAt).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it('leaves zone names untouched', () => {
    const out = normalizeTimestampsInValue({ timeZone: 'America/New_York', timezone: 'UTC' }, ET);
    expect(out.timeZone).toBe('America/New_York');
    expect(out.timezone).toBe('UTC');
  });
});
