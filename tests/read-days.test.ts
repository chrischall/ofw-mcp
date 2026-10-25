import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getReadDayPolicy, readingBlockedToday } from '../src/read-days.js';

// 2026-10-25 is a Sunday; 2026-10-26 a Monday; 2026-12-25 a Friday.
const SUNDAY_NOON_ET = new Date('2026-10-25T16:00:00Z');
const MONDAY_NOON_ET = new Date('2026-10-26T16:00:00Z');

const KEYS = ['OFW_READ_DAYS', 'OFW_NO_READ_DAYS', 'DISPLAY_TZ'] as const;

describe('read-day policy (OFW_READ_DAYS / OFW_NO_READ_DAYS)', () => {
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) { prev[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    vi.restoreAllMocks();
  });

  it('defaults to allowing every day when neither var is set', () => {
    expect(getReadDayPolicy()).toBeNull();
    expect(readingBlockedToday(SUNDAY_NOON_ET)).toBeNull();
    // and with no argument, "now"
    expect(readingBlockedToday()).toBeNull();
  });

  it('blank and placeholder values count as unset', () => {
    process.env.OFW_READ_DAYS = '   ';
    process.env.OFW_NO_READ_DAYS = '${OFW_NO_READ_DAYS}';
    expect(getReadDayPolicy()).toBeNull();
  });

  it('allow list: reading only on the listed weekdays, naming the next reading day', () => {
    process.env.OFW_READ_DAYS = 'Monday, THU';
    expect(readingBlockedToday(MONDAY_NOON_ET)).toBeNull();
    const blocked = readingBlockedToday(SUNDAY_NOON_ET);
    expect(blocked).toMatchObject({
      error: 'READING_BLOCKED',
      today: '2026-10-25',
      weekday: 'Sunday',
      timeZone: 'America/New_York',
      nextReadableDay: 'Monday 2026-10-26',
    });
    expect(blocked!.reason).toMatch(/subjects/);
    expect(blocked!.reason).toMatch(/no per-call argument/);
  });

  it('deny list: dates and inclusive ranges', () => {
    process.env.OFW_NO_READ_DAYS = '2026-12-24..2026-12-26 2027-01-01';
    expect(readingBlockedToday(new Date('2026-12-25T17:00:00Z'))).toMatchObject({
      today: '2026-12-25', weekday: 'Friday', nextReadableDay: 'Sunday 2026-12-27',
    });
    expect(readingBlockedToday(new Date('2026-12-27T17:00:00Z'))).toBeNull();
    expect(readingBlockedToday(new Date('2027-01-01T17:00:00Z'))).not.toBeNull();
  });

  it('the deny list carves exceptions out of the allow list', () => {
    process.env.OFW_READ_DAYS = 'mon';
    process.env.OFW_NO_READ_DAYS = '2026-10-26';
    expect(readingBlockedToday(MONDAY_NOON_ET)).toMatchObject({ nextReadableDay: 'Monday 2026-11-02' });
  });

  it('decides "today" in DISPLAY_TZ, not UTC', () => {
    // 02:00 UTC Monday is still 22:00 Sunday in New York.
    const instant = new Date('2026-10-26T02:00:00Z');
    process.env.OFW_READ_DAYS = 'sun';
    expect(readingBlockedToday(instant)).toBeNull();
    process.env.DISPLAY_TZ = 'UTC';
    expect(readingBlockedToday(instant)).toMatchObject({ weekday: 'Monday', timeZone: 'UTC' });
  });

  it('fails closed on an unrecognized token, warning on stderr', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of ['Thrusday', 'th', '2026-02-30', '2026-12-31..2026-12-01', '2026-01-01..2026-01-02..2026-01-03']) {
      process.env.OFW_NO_READ_DAYS = bad;
      const blocked = readingBlockedToday(MONDAY_NOON_ET);
      expect(blocked, bad).toMatchObject({ nextReadableDay: null });
      expect(blocked!.reason).toContain(JSON.stringify(bad));
    }
    expect(err).toHaveBeenCalledWith(expect.stringContaining('failing closed'));
  });

  it('an allow list with no readable day in the coming year reports nextReadableDay: null', () => {
    process.env.OFW_READ_DAYS = '2020-01-01';
    expect(readingBlockedToday(MONDAY_NOON_ET)).toMatchObject({ nextReadableDay: null });
  });
});
