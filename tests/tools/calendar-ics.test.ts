import { describe, it, expect } from 'vitest';
import { buildCalendarIcs, filterCalendarTypes } from '../../src/tools/calendar-ics.js';

// Shapes mirror a live GET /pub/v1/calendar/detailed (2026-10-28): naive local
// `dateTime`s, TRANSITION rows that all carry `id: 1` and only a start, and a
// window-edge sentinel at each end whose start or end parent is null.
const A = { userId: 101, name: 'Parent A' };
const B = { userId: 202, name: 'Parent B' };
const at = (dateTime: string) => ({ dateTime, displayDate: 'ignored' });
const transition = (dateTime: string, from: object | null, to: object | null) => ({
  id: 1, type: 'TRANSITION', allDay: false, displayHierarchy: 9999,
  startDate: at(dateTime), transitionStartParent: from, transitionEndParent: to,
});
const event = (over: Record<string, unknown> = {}) => ({
  id: 123596421, type: 'EVENT', allDay: false, title: 'Dentist', repeating: false,
  startDate: at('2026-06-10T17:00:00'), endDate: at('2026-06-10T18:00:00'), ...over,
});

const NOW = new Date('2026-10-28T12:00:00Z');
const TZ = 'America/New_York';
const build = (items: unknown[], extra: Record<string, unknown> = {}) =>
  buildCalendarIcs({ calendarItems: items, guardianData: {}, ...extra }, { timeZone: TZ, now: NOW });
const lines = (ics: string) => ics.split('\r\n');

describe('buildCalendarIcs — envelope', () => {
  it('emits a CRLF VCALENDAR with the zone named and a trailing CRLF', () => {
    const { ics } = build([]);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//ofw-mcp//Calendar//EN\r\n')).toBe(true);
    expect(ics).toContain('\r\nX-WR-CALNAME:OurFamilyWizard\r\n');
    expect(ics).toContain('\r\nX-WR-TIMEZONE:America/New_York\r\n');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('treats a payload with no calendarItems as empty rather than throwing', () => {
    expect(buildCalendarIcs(null, { timeZone: TZ, now: NOW }).counts).toEqual({ events: 0, custodyPeriods: 0, omitted: 0 });
    expect(buildCalendarIcs({ calendarItems: 'nope' }, { timeZone: TZ, now: NOW }).counts.events).toBe(0);
  });
});

describe('buildCalendarIcs — events', () => {
  it('renders a timed event in UTC, read as wall clock in the given zone', () => {
    const { ics, counts } = build([event()]);
    const l = lines(ics);
    expect(l).toContain('UID:ofw-event-123596421@ofw-mcp');
    expect(l).toContain('DTSTAMP:20261028T120000Z');
    expect(l).toContain('DTSTART:20260610T210000Z'); // 17:00 EDT
    expect(l).toContain('DTEND:20260610T220000Z');
    expect(l).toContain('SUMMARY:Dentist');
    expect(counts).toEqual({ events: 1, custodyPeriods: 0, omitted: 0 });
  });

  it('honours the zone it is given — the same naive time lands an hour apart', () => {
    const chicago = buildCalendarIcs({ calendarItems: [event()] }, { timeZone: 'America/Chicago', now: NOW });
    expect(lines(chicago.ics)).toContain('DTSTART:20260610T220000Z');
  });

  it('trusts an explicit offset on the source value over the zone', () => {
    const { ics } = build([event({ startDate: at('2026-06-10T17:00:00Z'), endDate: at('2026-06-10T18:00:00Z') })]);
    expect(lines(ics)).toContain('DTSTART:20260610T170000Z');
  });

  it('renders an all-day event as DATE values with an exclusive end', () => {
    const { ics } = build([event({ allDay: true, startDate: at('2026-12-24T01:00:00'), endDate: at('2026-12-26T02:00:00') })]);
    const l = lines(ics);
    expect(l).toContain('DTSTART;VALUE=DATE:20261224');
    expect(l).toContain('DTEND;VALUE=DATE:20261227');
  });

  it('keeps location and notes, escaped', () => {
    const { ics } = build([event({ title: 'Pick-up; bring coats, hats', location: 'School\\Gym', notes: 'line1\nline2' })]);
    const l = lines(ics);
    expect(l).toContain('SUMMARY:Pick-up\\; bring coats\\, hats');
    expect(l).toContain('LOCATION:School\\\\Gym');
    expect(l).toContain('DESCRIPTION:line1\\nline2');
  });

  it('names a connected event by its subscription so two feeds cannot collide', () => {
    const { ics } = build([event({ type: 'CONNECTED_EVENT', connectedCalendarSubscriptionId: 77 })]);
    expect(lines(ics)).toContain('UID:ofw-connected-77-123596421@ofw-mcp');
  });

  it('gives each occurrence of a repeating event its own UID', () => {
    const { ics } = build([
      event({ repeating: true }),
      event({ repeating: true, startDate: at('2026-06-17T17:00:00'), endDate: at('2026-06-17T18:00:00') }),
    ]);
    expect(lines(ics)).toContain('UID:ofw-event-123596421-20260610T210000Z@ofw-mcp');
    expect(lines(ics)).toContain('UID:ofw-event-123596421-20260617T210000Z@ofw-mcp');
  });

  it('disambiguates a repeated non-repeating id by start, and drops an exact duplicate', () => {
    const second = event({ startDate: at('2026-06-11T17:00:00'), endDate: at('2026-06-11T18:00:00') });
    const { ics, omitted } = build([event(), second, event()]);
    expect(lines(ics)).toContain('UID:ofw-event-123596421@ofw-mcp');
    expect(lines(ics)).toContain('UID:ofw-event-123596421-20260611T210000Z@ofw-mcp');
    expect(omitted).toEqual([{ type: 'EVENT', id: 123596421, reason: 'duplicate' }]);
  });

  it('falls back to a placeholder title rather than an empty SUMMARY', () => {
    expect(lines(build([event({ title: '  ' })]).ics)).toContain('SUMMARY:(untitled)');
  });

  it('omits, with a reason, what it cannot place', () => {
    const { omitted, counts } = build([
      event({ id: 'x' }),
      event({ id: 2, startDate: at('not a date') }),
      event({ id: 3, endDate: at('2026-06-10T16:00:00') }),
      event({ id: 4, allDay: true, startDate: at('2026-06-10T01:00:00'), endDate: at('2026-06-09T02:00:00') }),
      event({ id: 5, endDate: undefined }),
    ]);
    expect(omitted).toEqual([
      { type: 'EVENT', id: null, reason: 'no_id' },
      { type: 'EVENT', id: 2, reason: 'unreadable_time' },
      { type: 'EVENT', id: 3, reason: 'ends_before_start' },
      { type: 'EVENT', id: 4, reason: 'ends_before_start' },
      { type: 'EVENT', id: 5, reason: 'unreadable_time' },
    ]);
    expect(counts.events).toBe(0);
  });

  it('omits an all-day event whose dates are missing or impossible', () => {
    const { omitted } = build([
      event({ id: 6, allDay: true, startDate: undefined }),
      event({ id: 7, allDay: true, startDate: at('2026-02-30T01:00:00'), endDate: at('2026-03-01T02:00:00') }),
    ]);
    expect(omitted).toEqual([
      { type: 'EVENT', id: 6, reason: 'unreadable_time' },
      { type: 'EVENT', id: 7, reason: 'unreadable_time' },
    ]);
  });

  it('still names a connected event OFW sent without a subscription id', () => {
    expect(lines(build([event({ type: 'CONNECTED_EVENT' })]).ics)).toContain('UID:ofw-connected-unknown-123596421@ofw-mcp');
  });

  it('drops a row whose identity and start are both already taken by a different event', () => {
    const repeat = event({ repeating: true, startDate: at('2026-06-11T17:00:00'), endDate: at('2026-06-11T18:00:00') });
    const clash = event({ title: 'Other', startDate: at('2026-06-11T17:00:00'), endDate: at('2026-06-11T18:00:00') });
    const { omitted, counts } = build([event(), repeat, clash]);
    expect(counts.events).toBe(2);
    expect(omitted).toEqual([{ type: 'EVENT', id: 123596421, reason: 'duplicate' }]);
  });

  it('leaves unknown item types out and says so', () => {
    expect(build([{ type: 'HOLIDAY', id: 9 }]).omitted).toEqual([{ type: 'HOLIDAY', id: 9, reason: 'unsupported_type' }]);
    expect(build([{ id: 9 }]).omitted).toEqual([{ type: null, id: 9, reason: 'unsupported_type' }]);
  });
});

describe('buildCalendarIcs — custody periods from TRANSITION rows', () => {
  const schedule = [
    transition('2026-09-04T12:00:00', A, B),
    transition('2026-08-31T00:00:00', null, A), // head sentinel — deliberately out of order
    transition('2026-09-11T12:00:00', B, A),
    transition('2026-09-14T00:00:00', A, null), // tail sentinel
  ];

  it('turns consecutive handoffs into one period per parent', () => {
    const { ics, counts } = build(schedule);
    const l = lines(ics);
    expect(counts.custodyPeriods).toBe(3);
    // Head: clipped at the window start, so its UID hangs off its real END.
    expect(l).toContain('UID:ofw-custody-101-until-20260904T160000Z@ofw-mcp');
    expect(l).toContain('DTSTART:20260831T040000Z');
    // Middle: a full period, keyed by its real start.
    expect(l).toContain('UID:ofw-custody-202-20260904T160000Z@ofw-mcp');
    expect(l).toContain('DTEND:20260911T160000Z');
    // Tail: clipped at the window end, still keyed by its real start.
    expect(l).toContain('UID:ofw-custody-101-20260911T160000Z@ofw-mcp');
    expect(l.filter((x) => x === 'SUMMARY:Parenting time: Parent A')).toHaveLength(2);
    expect(l).toContain('SUMMARY:Parenting time: Parent B');
    expect(l).toContain('DESCRIPTION:Handoff from Parent A.');
    expect(l).toContain('DESCRIPTION:Starts before the exported range.');
    expect(l).toContain('DESCRIPTION:Handoff from Parent B. Continues past the exported range.');
  });

  it('refuses to invent a period when the next handoff names a different parent', () => {
    const { omitted, counts } = build([transition('2026-09-04T12:00:00', A, B), transition('2026-09-11T12:00:00', A, B)]);
    expect(omitted).toEqual([
      { type: 'TRANSITION', id: null, reason: 'handoff_mismatch' },
      { type: 'TRANSITION', id: null, reason: 'no_end' },
    ]);
    expect(counts.custodyPeriods).toBe(0);
  });

  it('omits a handoff with no readable time, and a period with no end', () => {
    const { omitted, counts } = build([transition('garbage', A, B), transition('2026-09-04T12:00:00', A, B)]);
    expect(omitted).toEqual([
      { type: 'TRANSITION', id: null, reason: 'unreadable_time' },
      { type: 'TRANSITION', id: null, reason: 'no_end' },
    ]);
    expect(counts.custodyPeriods).toBe(0);
  });

  it('uses the parent id when OFW sends no name', () => {
    const { ics } = build([transition('2026-09-04T12:00:00', A, { userId: 303 }), transition('2026-09-11T12:00:00', { userId: 303 }, null)]);
    expect(lines(ics)).toContain('SUMMARY:Parenting time: parent 303');
  });

  it('skips the gap after a tail sentinel without reporting it', () => {
    const { omitted } = build([transition('2026-09-04T12:00:00', A, null), transition('2026-09-11T12:00:00', null, B), transition('2026-09-18T12:00:00', B, A), transition('2026-09-20T00:00:00', A, null)]);
    expect(omitted).toEqual([]);
  });
});

describe('buildCalendarIcs — line folding', () => {
  it('folds at 75 octets without splitting a multi-byte character', () => {
    const { ics } = build([event({ title: 'é'.repeat(80) })]);
    const physical = lines(ics);
    for (const line of physical) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    const summary = ics.replace(/\r\n /g, '').split('\r\n').find((x) => x.startsWith('SUMMARY:'));
    expect(summary).toBe(`SUMMARY:${'é'.repeat(80)}`);
  });
});

describe('filterCalendarTypes', () => {
  const data = { calendarItems: [event(), transition('2026-09-04T12:00:00', A, B), { type: 'CONNECTED_EVENT', id: 5 }], guardianData: { '2026-09-04': [] }, other: 1 };

  it('passes everything through when no filter is given', () => {
    expect(filterCalendarTypes(data, undefined)).toBe(data);
    expect(filterCalendarTypes(data, [])).toBe(data);
  });

  it('keeps only the named item types and drops the custody grid unless SCHEDULE is named', () => {
    const out = filterCalendarTypes(data, ['EVENT']) as Record<string, unknown>;
    expect((out.calendarItems as Array<{ type: string }>).map((i) => i.type)).toEqual(['EVENT']);
    expect(out).not.toHaveProperty('guardianData');
    expect(out.other).toBe(1);
  });

  it('keeps the grid alone for SCHEDULE', () => {
    const out = filterCalendarTypes(data, ['SCHEDULE']) as Record<string, unknown>;
    expect(out.calendarItems).toEqual([]);
    expect(out.guardianData).toEqual({ '2026-09-04': [] });
  });

  it('returns a non-object payload untouched', () => {
    expect(filterCalendarTypes('x', ['EVENT'])).toBe('x');
    expect(filterCalendarTypes({ guardianData: {} }, ['EVENT'])).toEqual({});
  });
});
