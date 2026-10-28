import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: () => Buffer.alloc(12, 0x7a) };
});

import { writeObservedCalendarIcs } from '../../src/tools/calendar-ics.js';

const originalRoot = process.env.OFW_CALENDAR_EXPORT_DIR;
let root: string | undefined;
afterEach(() => {
  if (originalRoot === undefined) delete process.env.OFW_CALENDAR_EXPORT_DIR;
  else process.env.OFW_CALENDAR_EXPORT_DIR = originalRoot;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('calendar export exclusive file creation', () => {
  it('never deletes an existing ICS file after a name collision', async () => {
    root = mkdtempSync(join(tmpdir(), 'ofw-ics-collision-'));
    const out = join(root, 'output');
    mkdirSync(out, { mode: 0o700 });
    process.env.OFW_CALENDAR_EXPORT_DIR = out;
    const target = join(out, `ofw-observed-${'7a'.repeat(12)}.ics`);
    writeFileSync(target, 'synthetic sentinel', { mode: 0o600 });
    await expect(writeObservedCalendarIcs({ calendarItems: [] }, {
      startDate: '2026-11-01', endDate: '2026-11-30', timeZone: 'America/Phoenix',
    })).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('synthetic sentinel');
  });

  it('removes only the ICS it created when the manifest name already exists', async () => {
    root = mkdtempSync(join(tmpdir(), 'ofw-ics-collision-'));
    const out = join(root, 'output');
    mkdirSync(out, { mode: 0o700 });
    process.env.OFW_CALENDAR_EXPORT_DIR = out;
    const stem = join(out, `ofw-observed-${'7a'.repeat(12)}`);
    writeFileSync(`${stem}.manifest.json`, 'synthetic manifest sentinel', { mode: 0o600 });
    await expect(writeObservedCalendarIcs({ calendarItems: [] }, {
      startDate: '2026-11-01', endDate: '2026-11-30', timeZone: 'America/Phoenix',
    })).rejects.toThrow();
    expect(readFileSync(`${stem}.manifest.json`, 'utf8')).toBe('synthetic manifest sentinel');
    expect(() => readFileSync(`${stem}.ics`)).toThrow();
  });
});
