// OFW calendar → iCalendar (RFC 5545), plus the `types` filter shared with
// ofw_list_events' JSON path.
//
// What the detailed calendar endpoint actually returns (verified live
// 2026-10-28, sixteen months of one account): `calendarItems` holding EVENT
// rows (real ids, title, start/end), CONNECTED_EVENT rows (events from a
// subscribed outside calendar), and TRANSITION rows — the custody handoffs —
// beside `guardianData`, a per-day grid of who has the children. On that
// account TRANSITIONs were 68 of 71 items. OFW's own web export ("you will not
// be able to export your parenting schedule") leaves them out; here they are
// the point, so each run between two handoffs becomes one "Parenting time"
// event.
//
// TRANSITION quirks this file is built around:
//  - every one carries `id: 1`, so a UID has to be derived, not copied;
//  - each has a start and no end — a period is the gap to the NEXT handoff;
//  - the first and last rows of a response are window-edge sentinels, with a
//    null `transitionStartParent` (head) or `transitionEndParent` (tail), at a
//    time OFW picks near the requested range, not at a real handoff.
//
// Times arrive as naive wall clock in the account's zone. They are read with
// parseTimestampValue in the caller's zone, the same reading every JSON
// response gets, and written in UTC, so no VTIMEZONE block is needed and every
// importer agrees on the instant.
import { parseTimestampValue } from '../timestamps.js';

type Item = Record<string, unknown>;

export const CALENDAR_ITEM_TYPES = ['EVENT', 'CONNECTED_EVENT', 'TRANSITION', 'SCHEDULE'] as const;
export type CalendarItemType = (typeof CALENDAR_ITEM_TYPES)[number];

export interface IcsOmission {
  type: string | null;
  id: number | null;
  reason: string;
}

export interface CalendarIcs {
  ics: string;
  counts: { events: number; custodyPeriods: number; omitted: number };
  omitted: IcsOmission[];
}

const isObject = (v: unknown): v is Item => v !== null && typeof v === 'object' && !Array.isArray(v);

function itemsOf(data: unknown): Item[] {
  const items = isObject(data) ? data.calendarItems : undefined;
  return Array.isArray(items) ? items.filter(isObject) : [];
}

/**
 * Keep only the named item types. `SCHEDULE` names the `guardianData` grid
 * (its entries are typed SCHEDULE), which is dropped unless asked for — it is
 * most of a response's weight. No filter (or an empty one) returns the payload
 * itself, so the default response is unchanged.
 */
export function filterCalendarTypes(data: unknown, types: readonly string[] | undefined): unknown {
  if (!types?.length || !isObject(data)) return data;
  const wanted = new Set(types);
  const { calendarItems: _items, guardianData, ...rest } = data;
  const out: Item = { ...rest };
  if (Array.isArray(data.calendarItems)) {
    out.calendarItems = data.calendarItems.filter((i) => isObject(i) && wanted.has(String(i.type)));
  }
  if (wanted.has('SCHEDULE') && guardianData !== undefined) out.guardianData = guardianData;
  return out;
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

// RFC 5545 §3.1: lines longer than 75 OCTETS fold with CRLF + space, and a
// fold must not split a multi-byte UTF-8 character.
function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (size + bytes > 75) {
      out.push(current);
      current = ' ';
      size = 1;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join('\r\n');
}

const utcStamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function dateTimeOf(item: Item, field: string): string | undefined {
  const value = item[field];
  return isObject(value) && typeof value.dateTime === 'string' ? value.dateTime : undefined;
}

function instantOf(item: Item, field: string, tz: string): Date | null {
  const raw = dateTimeOf(item, field);
  return raw === undefined ? null : parseTimestampValue(field, raw, tz);
}

// An all-day event's calendar date is the wall date OFW wrote (it pads all-day
// events with placeholder times, so the time part means nothing).
function wallDateOf(item: Item, field: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateTimeOf(item, field) ?? '');
  return m && parseTimestampValue(field, `${m[0]}T00:00:00`, 'UTC') ? `${m[1]}${m[2]}${m[3]}` : null;
}

function nextDay(yyyymmdd: string): string {
  const d = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6)) + 1));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

const idOf = (item: Item): number | null =>
  Number.isSafeInteger(item.id) && (item.id as number) > 0 ? (item.id as number) : null;

interface Parent { userId: number; name: string }

function parentOf(value: unknown): Parent | null {
  if (!isObject(value) || typeof value.userId !== 'number') return null;
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `parent ${value.userId}`;
  return { userId: value.userId, name };
}

export function buildCalendarIcs(data: unknown, opts: { timeZone: string; now?: Date }): CalendarIcs {
  const tz = opts.timeZone;
  const stamp = utcStamp(opts.now ?? new Date());
  const omitted: IcsOmission[] = [];
  const vevents: string[][] = [];
  // UID → what it was issued for, so a second row with the same identity is
  // either told apart (by start) or recognised as the same event twice.
  const issued = new Map<string, string>();
  let events = 0;
  let custodyPeriods = 0;

  const vevent = (uid: string, props: string[]): string[] =>
    ['BEGIN:VEVENT', `UID:${uid}@ofw-mcp`, `DTSTAMP:${stamp}`, ...props, 'END:VEVENT'];

  const transitions: Array<{ at: Date; from: Parent | null; to: Parent | null }> = [];

  for (const item of itemsOf(data)) {
    const type = typeof item.type === 'string' ? item.type : null;
    // A TRANSITION's id is always 1 — reporting it would name nothing.
    const id = type === 'TRANSITION' ? null : idOf(item);
    const omit = (reason: string) => omitted.push({ type, id, reason });

    if (type === 'TRANSITION') {
      const at = instantOf(item, 'startDate', tz);
      if (!at) { omit('unreadable_time'); continue; }
      transitions.push({ at, from: parentOf(item.transitionStartParent), to: parentOf(item.transitionEndParent) });
      continue;
    }
    if (type !== 'EVENT' && type !== 'CONNECTED_EVENT') { omit('unsupported_type'); continue; }
    if (id === null) { omit('no_id'); continue; }

    let when: string[];
    let startKey: string;
    let signature: string;
    if (item.allDay === true) {
      const start = wallDateOf(item, 'startDate');
      const end = wallDateOf(item, 'endDate');
      if (!start || !end) { omit('unreadable_time'); continue; }
      if (end < start) { omit('ends_before_start'); continue; }
      // DTEND is exclusive for DATE values: a one-day event ends the next day.
      when = [`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${nextDay(end)}`];
      startKey = start;
      signature = `${start}/${end}`;
    } else {
      const start = instantOf(item, 'startDate', tz);
      const end = instantOf(item, 'endDate', tz);
      if (!start || !end) { omit('unreadable_time'); continue; }
      if (end < start) { omit('ends_before_start'); continue; }
      when = [`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`];
      startKey = utcStamp(start);
      signature = `${startKey}/${utcStamp(end)}`;
    }
    const title = typeof item.title === 'string' && item.title.trim() ? item.title : '(untitled)';
    signature += `/${title}`;

    // A connected event's id is only unique within its subscription.
    const base = type === 'EVENT'
      ? `ofw-event-${id}`
      : `ofw-connected-${String(item.connectedCalendarSubscriptionId ?? 'unknown')}-${id}`;
    // Occurrences of a repeating event share an id, so each is keyed by its
    // start; a one-off keeps the bare id, so re-importing after an edit to
    // its time updates the event rather than duplicating it.
    let uid = item.repeating === true ? `${base}-${startKey}` : base;
    if (issued.has(uid)) {
      if (issued.get(uid) === signature) { omit('duplicate'); continue; }
      uid = `${base}-${startKey}`;
      if (issued.has(uid)) { omit('duplicate'); continue; }
    }
    issued.set(uid, signature);

    const props = [...when, `SUMMARY:${escapeText(title)}`];
    if (typeof item.location === 'string' && item.location.trim()) props.push(`LOCATION:${escapeText(item.location)}`);
    if (typeof item.notes === 'string' && item.notes.trim()) props.push(`DESCRIPTION:${escapeText(item.notes)}`);
    vevents.push(vevent(uid, props));
    events += 1;
  }

  // Custody periods: each handoff opens a period for the parent it hands TO,
  // which the next handoff closes. OFW does not promise row order.
  transitions.sort((a, b) => a.at.getTime() - b.at.getTime());
  transitions.forEach((t, i) => {
    const owner = t.to;
    if (!owner) return; // a tail sentinel (or a gap) opens nothing
    const next = transitions[i + 1];
    if (!next) { omitted.push({ type: 'TRANSITION', id: null, reason: 'no_end' }); return; }
    if (next.from && next.from.userId !== owner.userId) {
      omitted.push({ type: 'TRANSITION', id: null, reason: 'handoff_mismatch' });
      return;
    }
    const clippedHead = t.from === null;
    const clippedTail = next.to === null;
    // A head-clipped period's start is the window edge, not a handoff, so its
    // identity hangs off its real END instead — otherwise every export with a
    // different start date would mint a different UID for the same period.
    const uid = clippedHead
      ? `ofw-custody-${owner.userId}-until-${utcStamp(next.at)}`
      : `ofw-custody-${owner.userId}-${utcStamp(t.at)}`;
    const notes = [
      clippedHead ? 'Starts before the exported range.' : `Handoff from ${t.from!.name}.`,
      ...(clippedTail ? ['Continues past the exported range.'] : []),
    ];
    vevents.push(vevent(uid, [
      `DTSTART:${utcStamp(t.at)}`,
      `DTEND:${utcStamp(next.at)}`,
      `SUMMARY:${escapeText(`Parenting time: ${owner.name}`)}`,
      `DESCRIPTION:${escapeText(notes.join(' '))}`,
      'TRANSP:TRANSPARENT',
    ]));
    custodyPeriods += 1;
  });

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ofw-mcp//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:OurFamilyWizard',
    `X-WR-TIMEZONE:${tz}`,
    ...vevents.flat(),
    'END:VCALENDAR',
  ];
  return {
    ics: lines.map(fold).join('\r\n') + '\r\n',
    counts: { events, custodyPeriods, omitted: omitted.length },
    omitted,
  };
}
