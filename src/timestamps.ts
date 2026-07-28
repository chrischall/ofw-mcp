// Canonical timestamp handling for every structured OFW response.
//
// A single response object used to mix zones: `sentAt`/`viewedAt`/`modifiedAt`
// came from OFW's API as NAIVE local wall-clock ("2026-07-27T23:31:09", no
// offset), while `fetchedBodyAt` and `freshness.asOf` were stamped by us as UTC
// with a `Z`. Nothing in the payload said which was which, so a reader assumed
// one zone for both and was wrong by the UTC offset on half the fields.
//
// The failure that matters is the calendar DAY. A message sent 10:38 PM Eastern
// reported as 02:38 lands on the following day, and in a co-parenting record
// that decides which custody day an event belongs to and whether it beat a
// 48-hour response window.
//
// Every value that survives detection is rewritten to ISO-8601 WITH an
// explicit offset and paired with a `<key>Display` sibling rendered in the
// operator's zone, weekday included, because a wrong weekday is what makes a
// date-boundary error visible at a glance.
//
// NOTE: this mirrors the helper in gogcli-mcp. Both connectors had the same
// defect, and the two copies should collapse into @chrischall/mcp-utils once
// that package next ships.

import { readEnvVar } from '@chrischall/mcp-utils';

// Fallback display zone for this deployment. IANA name, never a fixed offset —
// a hardcoded -04:00 would be an hour wrong from November through March.
export const DEFAULT_DISPLAY_TZ = 'America/New_York';

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The zone all *Display fields render in, and the zone a NAIVE source value is
// assumed to be wall-clock in. OFW's API reports naive local times in the
// account's own zone, so this must match it. An invalid DISPLAY_TZ falls back
// rather than throwing, so a typo degrades the label instead of breaking
// every tool.
export function displayTimeZone(): string {
  const configured = readEnvVar('DISPLAY_TZ');
  if (configured && isValidTimeZone(configured)) return configured;
  return DEFAULT_DISPLAY_TZ;
}

// Offset of `tz` at a given instant, as "+HH:MM"/"-HH:MM". Uses the IANA
// database via Intl, so DST is handled per-instant rather than per-zone.
function offsetAt(instant: Date, tz: string): string {
  // Derived arithmetically rather than parsed out of Intl's "GMT-04:00" label:
  // the gap between the zone's wall clock and the instant IS the offset, and
  // zone offsets are always whole minutes.
  const w = wallPartsIn(instant, tz);
  const asUTC = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, instant.getUTCMilliseconds());
  const minutes = Math.round((asUTC - instant.getTime()) / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// Wall-clock fields of `instant` as seen in `tz`, via Intl so the IANA rules
// (including DST) apply.
// Intl.DateTimeFormat construction dominates the cost here, and a 50-message
// listing formats hundreds of timestamps. Cache one formatter per zone.
const wallPartsFormatters = new Map<string, Intl.DateTimeFormat>();
const displayFormatters = new Map<string, Intl.DateTimeFormat>();

function wallPartsFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = wallPartsFormatters.get(tz);
  if (!fmt) {
    fmt = buildWallPartsFormatter(tz);
    wallPartsFormatters.set(tz, fmt);
  }
  return fmt;
}

function wallPartsIn(instant: Date, tz: string): Record<string, number> {
  const parts = wallPartsFormatter(tz).formatToParts(instant);
  const out: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

function buildWallPartsFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // h23 pins midnight to hour 00; without it some ICU builds render hour 24.
    hourCycle: 'h23',
  });
}

// Interpret naive wall-clock fields as an instant in `tz`. There is no direct
// inverse of the zone rules, so guess UTC, measure how far the guess lands from
// the requested wall time in that zone, and correct. Two passes settle the case
// where the correction itself crosses a DST boundary.
function wallTimeToInstant(
  y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tz: string,
): Date {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  for (let i = 0; i < 2; i += 1) {
    const seen = wallPartsIn(new Date(guess), tz);
    const seenUTC = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second, ms);
    const drift = Date.UTC(y, mo - 1, d, h, mi, s, ms) - seenUTC;
    if (drift === 0) break;
    guess += drift;
  }
  return new Date(guess);
}

export interface CanonicalTimestamp {
  /** ISO-8601 with an explicit offset, e.g. 2026-07-27T23:31:09-04:00. */
  iso: string;
  /** Human rendering in the display zone, weekday first. */
  display: string;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

// Render `instant` as ISO-8601 carrying `offset`'s wall time and label.
function isoWithOffset(instant: Date, tz: string, offset: string): string {
  const w = wallPartsIn(instant, tz);
  const msPart = instant.getUTCMilliseconds();
  const frac = msPart ? `.${pad(msPart, 3)}` : '';
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${frac}${offset}`;
}

// The one place an instant becomes user-visible text. Every emitted timestamp
// goes through here, so no call site can reintroduce a naive value.
export function formatInstant(instant: Date, tz = displayTimeZone()): CanonicalTimestamp {
  const offset = offsetAt(instant, tz);
  let fmt = displayFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    displayFormatters.set(tz, fmt);
  }
  return { iso: isoWithOffset(instant, tz, offset), display: fmt.format(instant) };
}

// Keys whose STRING values are timestamps. Deliberately an allowlist rather
// than a name pattern: a value must ALSO match a timestamp shape below, so both
// the key and the value have to agree before anything is touched. That keeps
// user-authored content (a message body quoting a date, an expense description)
// from ever being rewritten.
const TIMESTAMP_KEYS = new Set([
  // OFW: naive local wall-clock from the API.
  'sentAt',
  'viewedAt',
  'modifiedAt',
  'createdAt',
  'dueAt',
  'occurredAt',
  // OFW: UTC instants we stamp ourselves.
  'fetchedBodyAt',
  'fetchedAt',
  'syncedAt',
  'downloadedAt',
  'recordedAt',
  'expiresAt',
  // Freshness/sync bookkeeping. These sit in the SAME object as `asOf`, so
  // omitting them left the freshness block emitting two zones at once — the
  // exact defect this module exists to remove. Enumerated from a sweep of
  // emitted field names rather than from the ones a bug report happened to
  // mention.
  'asOf',
  'checkedAt',
  'lastVerifiedAt',
  'oldestVerifiedAt',
  'lastServerSyncAt',
  'lastSyncAt',
  // OFW API inner shape: `date: { dateTime }`, `viewed: { dateTime }`.
  'dateTime',
  // Generic.
  'date',
  'updated',
  'lastModified',
  'expirationTime',
]);

// Deliberately NOT timestamps: `startDate`/`endDate` are YYYY-MM-DD and
// `startTime`/`endTime` are HH:mm — a calendar date and a wall time, neither of
// which denotes an instant. Attaching an offset would invent information. The
// shape guards below would reject them anyway; this records the intent.

// Keys that hold a zone NAME rather than an instant. They cannot match a
// timestamp shape anyway, but naming them documents the hazard.
const ZONE_NAME_KEYS = new Set(['timeZone', 'timezone']);

const RFC3339_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;
const NAIVE_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?$/;
// A bare YYYY-MM-DD is a DATE, not an instant — Calendar uses it for all-day
// events. Converting one would invent a time that the source never asserted.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// True when the components describe a real calendar instant. Guards against
// Date.UTC's silent rollover of out-of-range values.
function isRealCalendarDate(p: {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
}): boolean {
  const utc = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
  return utc.getUTCFullYear() === p.year
    && utc.getUTCMonth() === p.month - 1
    && utc.getUTCDate() === p.day
    && utc.getUTCHours() === p.hour
    && utc.getUTCMinutes() === p.minute
    && utc.getUTCSeconds() === p.second;
}

// Resolve a raw field value to an instant, or null when it is not a timestamp.
// `assumeNaiveIn` is the zone a naive (offset-less) value is wall-clock in.
export function parseTimestampValue(
  key: string,
  value: unknown,
  assumeNaiveIn: string,
): Date | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '' || DATE_ONLY.test(raw)) return null;

  if (RFC3339_WITH_OFFSET.test(raw)) {
    // The source already knows its offset; trust it verbatim.
    const parsed = new Date(raw.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const naive = NAIVE_DATE_TIME.exec(raw);
  if (naive) {
    const [, y, mo, d, h, mi, s, frac] = naive;
    const ms = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
    const parts = {
      year: Number(y), month: Number(mo), day: Number(d),
      hour: Number(h), minute: Number(mi), second: Number(s ?? '0'),
    };
    // Date.UTC silently rolls impossible components over — month 99 becomes
    // 2034, Feb 30 becomes Mar 2 — so a typo would surface as a confident wrong
    // date rather than a rejection. The offset branch above already returns
    // null for the same input; match it.
    //
    // Checked in UTC space, deliberately: validating against the ZONE's wall
    // clock would also reject a non-existent spring-forward time like
    // 2026-03-08 02:30 ET, and shifting such a value forward (as zone libraries
    // do) is better than dropping a timestamp we can place to within an hour.
    if (!isRealCalendarDate(parts)) return null;
    return wallTimeToInstant(
      parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, ms, assumeNaiveIn,
    );
  }
  return null;
}

// True when a string carries no zone information — the shape this whole module
// exists to eliminate. Used by the contract test.
export function isNaiveTimestamp(value: unknown): boolean {
  return typeof value === 'string' && NAIVE_DATE_TIME.test(value.trim());
}

// Walk a parsed payload, rewriting every allowlisted timestamp to canonical
// form and attaching its display sibling. Mutates and returns `node`.
function walk(node: unknown, tz: string): unknown {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, tz);
    return node;
  }
  if (node === null || typeof node !== 'object') return node;

  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value !== null && typeof value === 'object') {
      walk(value, tz);
      continue;
    }
    if (ZONE_NAME_KEYS.has(key) || !TIMESTAMP_KEYS.has(key)) continue;
    const instant = parseTimestampValue(key, value, tz);
    if (!instant) continue;
    const { iso, display } = formatInstant(instant, tz);
    obj[key] = iso;
    obj[`${key}Display`] = display;
  }
  return obj;
}

// Normalize every timestamp in a structured response payload.
//
// The input is CLONED before walking: response payloads routinely include live
// cache rows, and rewriting those in place would corrupt the cache and make the
// normalization observable on a later read. Primitives pass through untouched
// so the seam is safe for any tool result.
export function normalizeTimestampsInValue<T>(value: T, tz = displayTimeZone()): T {
  if (value === null || typeof value !== 'object') return value;
  return walk(structuredClone(value), tz) as T;
}
