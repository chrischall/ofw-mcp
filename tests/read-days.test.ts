import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { auditReadOverride, getReadDayPolicy, readingBlockedToday } from '../src/read-days.js';

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
    expect(blocked!.reason).toMatch(/only protects UNREAD inbox messages/);
    expect(blocked!.reason).toMatch(/Sent messages, inbox messages already read, and drafts stay fully readable/);
    expect(blocked!.reason).toMatch(/overrideNoReadDay/);
    expect(blocked!.reason).toMatch(/explicitly asked/);
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

  describe('a three-weekday allow list', () => {
    beforeEach(() => { process.env.OFW_READ_DAYS = 'sun,tue,fri'; });

    it.each([
      ['2026-11-08T17:00:00Z', 'Sunday'],
      ['2026-11-10T17:00:00Z', 'Tuesday'],
      ['2026-11-06T17:00:00Z', 'Friday'],
    ])('%s (%s) is a reading day', (instant) => {
      expect(readingBlockedToday(new Date(instant))).toBeNull();
    });

    it.each([
      ['2026-11-09T17:00:00Z', 'Monday', 'Tuesday 2026-11-10'],
      ['2026-11-11T17:00:00Z', 'Wednesday', 'Friday 2026-11-13'],
      ['2026-11-12T17:00:00Z', 'Thursday', 'Friday 2026-11-13'],
      ['2026-11-07T17:00:00Z', 'Saturday', 'Sunday 2026-11-08'],
    ])('%s (%s) is not', (instant, weekday, nextReadableDay) => {
      expect(readingBlockedToday(new Date(instant))).toMatchObject({ weekday, nextReadableDay });
    });

    it('11:30 PM ET Friday counts as Friday, though it is already Saturday in UTC', () => {
      expect(readingBlockedToday(new Date('2026-11-07T04:30:00Z'))).toBeNull();
    });

    it('12:30 AM ET Saturday is Saturday', () => {
      expect(readingBlockedToday(new Date('2026-11-07T05:30:00Z'))).toMatchObject({ weekday: 'Saturday' });
    });

    it('the boundary holds on the daylight-time side too', () => {
      // 2026-07-10 is a Friday: 11:30 PM EDT is 03:30 UTC Saturday.
      expect(readingBlockedToday(new Date('2026-07-11T03:30:00Z'))).toBeNull();
    });
  });

  it('day numbers are not a format: "0" fails closed rather than meaning Sunday', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OFW_READ_DAYS = '0,2,5';
    expect(getReadDayPolicy()!.invalid).toEqual(['0', '2', '5']);
    expect(readingBlockedToday(SUNDAY_NOON_ET)).not.toBeNull();
  });

  it('auditReadOverride writes one structured stderr line: timestamp, tool, messageIds', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    auditReadOverride('ofw_get_message', [7, 8], new Date('2026-11-09T12:00:00Z'));
    expect(err).toHaveBeenCalledTimes(1);
    const line = err.mock.calls[0][0] as string;
    expect(line.startsWith('[ofw-mcp] AUDIT ')).toBe(true);
    expect(JSON.parse(line.slice('[ofw-mcp] AUDIT '.length))).toEqual({
      event: 'no_read_day_override', timestamp: '2026-11-09T12:00:00.000Z', tool: 'ofw_get_message', messageIds: [7, 8],
    });
    // and with no clock argument, "now"
    auditReadOverride('ofw_sync_messages', []);
    expect(err.mock.calls[1][0]).toMatch(/"timestamp":"\d{4}-/);
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
