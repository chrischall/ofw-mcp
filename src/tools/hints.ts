import { formatInstant, parseTimestampValue } from '../timestamps.js';

/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`, the context-groups contract). Inert data: a host that does
 * not read them sees an extra `_meta` key and nothing else. The shape is fixed
 * by the host's contract, so it is restated here rather than imported — this
 * server takes no dependency on mcp-host.
 *
 * `subject` and `when` name THIS tool's own argument names (the host fills
 * them), never values; `aliases` are the words a person says — lowercase, at
 * most 8, each at most 40 chars. No OFW tool takes a per-child argument, so no
 * hint here declares a `subject`.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'family';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for an OFW tool: every tool here is in the `family` group. */
export function familyMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {},
): { mint: MintHint } {
  return { mint: { domain: 'family', intent, ...extra } };
}

/** The longest line a `view: "brief"` answer emits. */
export const BRIEF_MAX = 120;

/**
 * One `view: "brief"` line: `title — <ISO date | no date> — <status>`, at most
 * {@link BRIEF_MAX} chars. The title is what gets shortened, never the date or
 * the status a host reads back.
 */
export function briefLine(title: string, date: string | null, status: string): string {
  const flat = title.replace(/\s+/g, ' ').trim() || '(untitled)';
  const tail = ` — ${date ?? 'no date'} — ${status}`;
  const room = BRIEF_MAX - tail.length;
  const shown = flat.length > room ? `${flat.slice(0, Math.max(room - 1, 0))}…` : flat;
  return `${shown}${tail}`;
}

/**
 * An OFW date or timestamp as ISO-8601 for a brief line: a bare `YYYY-MM-DD`
 * stays a date (an all-day item has no time to invent), a naive wall clock is
 * read in `tz` and gains its offset, and anything else is `null`.
 */
export function briefDate(value: unknown, tz: string): string | null {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const instant = parseTimestampValue('date', value, tz);
  return instant ? formatInstant(instant, tz).iso : null;
}
