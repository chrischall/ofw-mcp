/** One bounded OFW calendar observation rendered as a static local iCalendar snapshot. */
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { writeFileSafe } from '@chrischall/mcp-utils';
import { getCacheDbPath } from '../config.js';

type Item = Record<string, unknown>;
type Omission = { rowIndex: number; sourceId: string | null; reason: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/;
const OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/;
const UNSAFE_TEXT_CONTROL = /[\u0000-\u0009\u000B-\u000C\u000E-\u001F\u007F-\u009F]/u;
const MAX_ROWS = 500;

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function validateCalendarExportRequest(startDate: string, endDate: string, timeZone: string): void {
  if (!DATE.test(startDate) || !DATE.test(endDate)) throw new Error('INVALID_CALENDAR_RANGE');
  const first = Date.parse(`${startDate}T00:00:00Z`);
  const last = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last)
      || new Date(first).toISOString().slice(0, 10) !== startDate
      || new Date(last).toISOString().slice(0, 10) !== endDate
      || last < first || last - first > 30 * 86_400_000) {
    throw new Error('INVALID_CALENDAR_RANGE');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone }); }
  catch { throw new Error('INVALID_CALENDAR_TIMEZONE'); }
}

export function assertCalendarExportHost(): void {
  // Node's mode bits do not establish owner-only Windows ACLs. Qualify that
  // boundary on a native Windows target before enabling local file export.
  if (process.platform === 'win32') throw new Error('CALENDAR_EXPORT_WINDOWS_UNQUALIFIED');
}

function assertNoSymlinkAncestors(path: string): void {
  let current = resolve(path);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('CALENDAR_EXPORT_DIR_UNSAFE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function privateOutputRoot(configured: string | undefined): string {
  const root = configured || join(homedir(), 'Downloads', 'ofw-mcp', 'calendar');
  if (!isAbsolute(root)) throw new Error('CALENDAR_EXPORT_DIR_MUST_BE_ABSOLUTE');
  // Check before mkdir: a symlinked parent could redirect the creation itself.
  assertNoSymlinkAncestors(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(root);
  const info = lstatSync(root);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    // Never chmod a user-selected directory. In particular, /tmp must stay /tmp.
    throw new Error('CALENDAR_EXPORT_DIR_NOT_PRIVATE');
  }
  const realRoot = realpathSync(root);
  if (realRoot !== resolve(root)) throw new Error('CALENDAR_EXPORT_DIR_UNSAFE');
  return realRoot;
}

function rowsFrom(data: unknown): Item[] {
  let value = data;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    value = (value as Item).calendarItems ?? (value as Item).data;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) value = (value as Item).data;
  if (!Array.isArray(value) || value.length > MAX_ROWS
      || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('CALENDAR_RESPONSE_UNSUPPORTED');
  }
  return value as Item[];
}

function sourceKey(item: Item): string | null {
  const type = item.type;
  if (type !== 'EVENT' && type !== 'CONNECTED_EVENT') return null;
  const id = item.id ?? item.eventRecurrenceId;
  if (!Number.isSafeInteger(id) || Number(id) <= 0
      || (item.id !== undefined && item.eventRecurrenceId !== undefined
          && item.id !== item.eventRecurrenceId)) return null;
  if (type === 'EVENT') return `EVENT:${id}`;
  const subscription = item.connectedCalendarSubscriptionId;
  if ((typeof subscription !== 'string' && typeof subscription !== 'number')
      || !/^[0-9]+$/.test(String(subscription))) return null;
  return `CONNECTED_EVENT:${subscription}:${id}`;
}

function wallParts(formatter: Intl.DateTimeFormat, instant: number): string {
  const values = Object.fromEntries(formatter.formatToParts(new Date(instant))
    .filter((part) => ['year', 'month', 'day', 'hour', 'minute', 'second'].includes(part.type))
    .map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

function offsetAt(formatter: Intl.DateTimeFormat, instant: number): number {
  const wall = wallParts(formatter, instant);
  return Date.parse(`${wall}Z`) - instant;
}

function utcInstant(value: unknown, formatter: Intl.DateTimeFormat): number | null {
  if (typeof value !== 'string' || !CLOCK.test(value)) return null;
  if (OFFSET.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return null;
    const sign = value.endsWith('Z') || value.slice(-6, -5) === '+' ? 1 : -1;
    const offset = value.endsWith('Z') ? 0
      : sign * (Number(value.slice(-5, -3)) * 60 + Number(value.slice(-2))) * 60_000;
    return new Date(parsed + offset).toISOString().slice(0, 19) === value.slice(0, 19)
      ? parsed : null;
  }
  const nominal = Date.parse(`${value}Z`);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 19) !== value) return null;
  const offsets = new Set<number>();
  for (let delta = -48; delta <= 48; delta += 4) {
    offsets.add(offsetAt(formatter, nominal + delta * 3_600_000));
  }
  const candidates = new Set<number>();
  for (const offset of offsets) {
    const candidate = nominal - offset;
    if (wallParts(formatter, candidate) === value) candidates.add(candidate);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

function dateField(item: Item, name: string): unknown {
  const field = item[name];
  return field && typeof field === 'object' && !Array.isArray(field)
    ? (field as Item).dateTime : undefined;
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function fold(line: string): string {
  const result: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (size + bytes > 75) {
      result.push(current);
      current = ' ';
      size = 1;
    }
    current += char;
    size += bytes;
  }
  result.push(current);
  return result.join('\r\n');
}

function utcText(instant: number): string {
  return new Date(instant).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
}

export async function writeObservedCalendarIcs(data: unknown, opts: {
  startDate: string; endDate: string; timeZone: string;
}): Promise<Record<string, unknown>> {
  assertCalendarExportHost();
  validateCalendarExportRequest(opts.startDate, opts.endDate, opts.timeZone);
  const rows = rowsFrom(data);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: opts.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hourCycle: 'h23' });
  const observedAt = new Date().toISOString();
  const stamp = utcText(Date.parse(observedAt));
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ofw-mcp//Observed Calendar//EN',
    'CALSCALE:GREGORIAN'];
  const selected: Array<{ sourceId: string; type: string; subscriptionId: string | null }> = [];
  const omissions: Omission[] = [];
  const seen = new Map<string, string>();
  for (const [rowIndex, item] of rows.entries()) {
    const sourceId = sourceKey(item);
    if (!sourceId) { omissions.push({ rowIndex, sourceId: null, reason: 'unsupported_or_unqualified_identity' }); continue; }
    const previous = seen.get(sourceId);
    if (previous !== undefined) {
      if (previous !== JSON.stringify(item)) throw new Error('CALENDAR_SOURCE_ID_COLLISION');
      omissions.push({ rowIndex, sourceId, reason: 'duplicate_identical_source_row' });
      continue;
    }
    seen.set(sourceId, JSON.stringify(item));
    if (item.allDay !== false) { omissions.push({ rowIndex, sourceId, reason: 'all_day_semantics_unverified' }); continue; }
    const rawStart = dateField(item, 'startDate');
    const rawEnd = dateField(item, 'endDate');
    if (typeof rawStart === 'string' && typeof rawEnd === 'string'
        && OFFSET.test(rawStart) !== OFFSET.test(rawEnd)) {
      omissions.push({ rowIndex, sourceId, reason: 'mixed_source_clock_basis' }); continue;
    }
    const start = utcInstant(rawStart, formatter);
    const end = utcInstant(rawEnd, formatter);
    if (start === null || end === null || start >= end) {
      omissions.push({ rowIndex, sourceId, reason: 'missing_invalid_or_ambiguous_interval' }); continue;
    }
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 4000
        || UNSAFE_TEXT_CONTROL.test(item.title)
        || (item.location !== undefined && item.location !== null
            && (typeof item.location !== 'string' || item.location.length > 4000
                || UNSAFE_TEXT_CONTROL.test(item.location)))) {
      omissions.push({ rowIndex, sourceId, reason: 'invalid_text' }); continue;
    }
    // The cache basename is the account-scoped identity hash. Directory moves
    // therefore keep UIDs stable without disclosing the account identity.
    const uid = sha(`${basename(getCacheDbPath())}\0${sourceId}`);
    lines.push('BEGIN:VEVENT', `UID:${uid}@ofw-mcp.local`, `DTSTAMP:${stamp}`,
      `DTSTART:${utcText(start)}`, `DTEND:${utcText(end)}`, `SUMMARY:${escapeText(item.title)}`);
    if (typeof item.location === 'string') lines.push(`LOCATION:${escapeText(item.location)}`);
    lines.push('END:VEVENT');
    selected.push({ sourceId, type: String(item.type),
      subscriptionId: item.type === 'CONNECTED_EVENT' ? String(item.connectedCalendarSubscriptionId) : null });
  }
  lines.push('END:VCALENDAR');
  const content = Buffer.from(lines.map(fold).join('\r\n') + '\r\n', 'utf8');
  if (content.length > 5 * 1024 * 1024) throw new Error('CALENDAR_EXPORT_TOO_LARGE');
  const parsedResponseSha256 = sha(JSON.stringify(data));
  const icsSha256 = sha(content);
  const manifest = { format: 'ofw-observed-calendar-ics-v1', observedAt,
    endpoint: '/pub/v1/calendar/detailed', startDate: opts.startDate, endDate: opts.endDate,
    accountTimeZone: opts.timeZone, timezoneBasis: 'caller_confirmed_account_iana_zone',
    parsedResponseSha256, rawRows: rows.length, selectedSourceIds: selected, omissions,
    icsSha256, staticSnapshot: true, sourceCoverageComplete: false,
    warning: 'One bounded OFW response only. This file does not sync later changes or establish subscribed-event creation/edit history.' };
  const realRoot = privateOutputRoot(process.env.OFW_CALENDAR_EXPORT_DIR?.trim());
  const name = `ofw-observed-${randomBytes(12).toString('hex')}`;
  const path = join(realRoot, `${name}.ics`);
  const manifestPath = join(realRoot, `${name}.manifest.json`);
  let icsCreated = false;
  try {
    await writeFileSafe(path, content, { mode: 0o600, allowedRoots: [realRoot] });
    icsCreated = true;
    await writeFileSafe(manifestPath, Buffer.from(JSON.stringify(manifest) + '\n'),
      { mode: 0o600, allowedRoots: [realRoot] });
  } catch (error) {
    if (icsCreated) {
      try { unlinkSync(path); } catch { /* preserve the original error */ }
    }
    throw error;
  }
  return { path, manifestPath, icsSha256, includedCount: selected.length,
    omittedCount: omissions.length, rawRows: rows.length, sourceCoverageComplete: false,
    timeZone: opts.timeZone, staticSnapshot: true,
    privacyBasis: 'private directory and exclusive mode-0600 files' };
}
