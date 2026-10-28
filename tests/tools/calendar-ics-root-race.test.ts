import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fsFault = vi.hoisted(() => ({ redirectCanonicalPath: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, realpathSync: (path: string) => fsFault.redirectCanonicalPath
    ? `${path}/redirected` : actual.realpathSync(path) };
});

import { writeObservedCalendarIcs } from '../../src/tools/calendar-ics.js';

const originalRoot = process.env.OFW_CALENDAR_EXPORT_DIR;
let root: string | undefined;
afterEach(() => {
  fsFault.redirectCanonicalPath = false;
  if (originalRoot === undefined) delete process.env.OFW_CALENDAR_EXPORT_DIR;
  else process.env.OFW_CALENDAR_EXPORT_DIR = originalRoot;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('calendar export directory race guard', () => {
  it('refuses a root whose canonical location changed after validation', async () => {
    root = mkdtempSync(join(tmpdir(), 'ofw-ics-root-race-'));
    process.env.OFW_CALENDAR_EXPORT_DIR = root;
    fsFault.redirectCanonicalPath = true;
    await expect(writeObservedCalendarIcs({ calendarItems: [] }, {
      startDate: '2026-11-01', endDate: '2026-11-30', timeZone: 'America/Phoenix',
    })).rejects.toThrow('CALENDAR_EXPORT_DIR_UNSAFE');
  });
});
