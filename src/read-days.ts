// Days on which message CONTENT may be read.
//
// Some co-parenting arrangements (a court order, a parenting-plan clause, or
// just a personal rule) limit when OFW messages are read — e.g. "check OFW on
// Mondays and Thursdays only". On the other days it is fine to see THAT a
// message arrived, who sent it and its subject, but not to read it — and above
// all not to mark it read, which stamps a co-parent-visible "First Viewed"
// time on the record that cannot be undone.
//
// Two env vars, either or both:
//   OFW_READ_DAYS     allow list — reading is permitted ONLY on these days
//   OFW_NO_READ_DAYS  deny list  — reading is refused on these days
// Each is a comma/space-separated list of tokens:
//   mon … sun / monday … sunday   a weekday, every week
//   2026-12-25                     one calendar date
//   2026-12-24..2026-12-31         an inclusive date range
// A day is readable when (no allow list, or the day is on it) AND the day is
// not on the deny list — so the deny list carves exceptions out of the allow
// list. Unset/blank both → every day is readable (the default).
//
// "Today" is the calendar day in DISPLAY_TZ, the account's own zone — the same
// zone every *Display timestamp renders in — never the host's UTC clock, which
// would flip the day hours early or late.
//
// An unparseable token fails CLOSED (every day blocked) with a stderr warning:
// someone who wrote "Thrusday" meant to restrict reading, and silently
// ignoring the typo would keep reading on the day they meant to keep clear.

import { readEnvVar } from '@chrischall/mcp-utils';
import { displayTimeZone } from './timestamps.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface DaySet {
  weekdays: Set<number>;
  // Inclusive [from, to] pairs of YYYY-MM-DD strings (lexical order = date order).
  ranges: Array<[string, string]>;
}

interface ParsedList {
  set: DaySet;
  invalid: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parseList(raw: string): ParsedList {
  const set: DaySet = { weekdays: new Set(), ranges: [] };
  const invalid: string[] = [];
  for (const token of raw.split(/[\s,;]+/).filter((t) => t.length > 0)) {
    const lower = token.toLowerCase();
    const weekday = WEEKDAYS.findIndex((w) => w === lower || (lower.length >= 3 && w.startsWith(lower)));
    if (weekday !== -1) {
      set.weekdays.add(weekday);
      continue;
    }
    const [from, to, ...rest] = token.split('..');
    const end = to ?? from;
    if (rest.length === 0 && isRealDate(from) && isRealDate(end) && from <= end) {
      set.ranges.push([from, end]);
      continue;
    }
    invalid.push(token);
  }
  return { set, invalid };
}

function contains(set: DaySet, date: string, weekday: number): boolean {
  return set.weekdays.has(weekday) || set.ranges.some(([from, to]) => date >= from && date <= to);
}

export interface ReadDayPolicy {
  allow: DaySet | null;
  deny: DaySet | null;
  // Set when a token could not be parsed — the policy then blocks every day.
  invalid: string[];
}

/** The configured policy, or null when neither env var is set (always readable). */
export function getReadDayPolicy(): ReadDayPolicy | null {
  const allowRaw = readEnvVar('OFW_READ_DAYS');
  const denyRaw = readEnvVar('OFW_NO_READ_DAYS');
  if (allowRaw === undefined && denyRaw === undefined) return null;
  const allow = allowRaw === undefined ? null : parseList(allowRaw);
  const deny = denyRaw === undefined ? null : parseList(denyRaw);
  const invalid = [...(allow?.invalid ?? []), ...(deny?.invalid ?? [])];
  if (invalid.length > 0) {
    // stdio transport: stderr only — stdout is reserved for JSON-RPC.
    console.error(
      `[ofw-mcp] Unrecognized OFW_READ_DAYS / OFW_NO_READ_DAYS token(s) ${invalid.map((t) => JSON.stringify(t)).join(', ')} — failing closed: message content is withheld on EVERY day until this is fixed. Valid tokens: weekday names (mon, monday, …), YYYY-MM-DD, or YYYY-MM-DD..YYYY-MM-DD.`,
    );
  }
  return { allow: allow?.set ?? null, deny: deny?.set ?? null, invalid };
}

function isReadable(policy: ReadDayPolicy, date: string, weekday: number): boolean {
  if (policy.invalid.length > 0) return false;
  if (policy.allow !== null && !contains(policy.allow, date, weekday)) return false;
  return !(policy.deny !== null && contains(policy.deny, date, weekday));
}

// Calendar date (YYYY-MM-DD) of `instant` in `tz`.
function localDate(instant: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

// Calendar arithmetic on a YYYY-MM-DD string, in UTC so DST never skews it.
function addDays(date: string, n: number): { date: string; weekday: number } {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return { date: dt.toISOString().slice(0, 10), weekday: dt.getUTCDay() };
}

export interface ReadingBlocked {
  error: 'READING_BLOCKED';
  today: string;
  weekday: string;
  timeZone: string;
  reason: string;
  // The next calendar day content may be read, or null when none falls within
  // the coming year (e.g. an allow list of past dates, or a broken config).
  nextReadableDay: string | null;
}

/**
 * Null when message content may be read today; otherwise a description of why
 * not, suitable for embedding in a tool response.
 */
export function readingBlockedToday(now: Date = new Date()): ReadingBlocked | null {
  const policy = getReadDayPolicy();
  if (policy === null) return null;
  const timeZone = displayTimeZone();
  const today = addDays(localDate(now, timeZone), 0);
  if (isReadable(policy, today.date, today.weekday)) return null;

  let nextReadableDay: string | null = null;
  for (let i = 1; i <= 366; i++) {
    const day = addDays(today.date, i);
    if (isReadable(policy, day.date, day.weekday)) {
      nextReadableDay = `${WEEKDAY_LABELS[day.weekday]} ${day.date}`;
      break;
    }
  }

  const reason = policy.invalid.length > 0
    ? `OFW_READ_DAYS / OFW_NO_READ_DAYS contains unrecognized value(s) ${policy.invalid.map((t) => JSON.stringify(t)).join(', ')}, so reading is blocked on every day until the setting is fixed.`
    : `Today (${WEEKDAY_LABELS[today.weekday]} ${today.date}, ${timeZone}) is not a message-reading day under this server's OFW_READ_DAYS / OFW_NO_READ_DAYS setting.`;
  return {
    error: 'READING_BLOCKED',
    today: today.date,
    weekday: WEEKDAY_LABELS[today.weekday],
    timeZone,
    reason: `${reason} You may see that messages arrived, who sent them, when, and their subjects — but message bodies and attachments are withheld, and nothing may be marked read on OurFamilyWizard. This is a deployment setting; no per-call argument can override it.`,
    nextReadableDay,
  };
}
