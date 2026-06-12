import type { z } from 'zod';

/**
 * Validate an OFW API response against a zod schema at the call site.
 *
 * Every OFW endpoint is reverse-engineered and undocumented, so a backend
 * change on their side would otherwise flow `undefined` silently into the
 * SQLite cache and persist (issue #83). Schemas are `.looseObject(...)`
 * covering ONLY the fields the code actually reads — cosmetic API additions
 * pass through untouched (and stay present in the parsed output, which
 * matters for `listData`/`metadata` blobs cached verbatim).
 *
 * Two modes, chosen per call site:
 *  - `'lenient'` (default) — read/sync paths. On mismatch, log a structured
 *    warning to stderr naming the endpoint and fields, then return the RAW
 *    response unchanged so the existing `??` fallbacks keep the tool useful.
 *  - `'strict'` — write paths (send/save_draft verification, upload). On
 *    mismatch, throw: proceeding on an unverifiable response risks deleting
 *    a draft, mis-reporting a send, or caching an unusable fileId.
 *
 * The error/warning text is deliberately precise ("date.dateTime: expected
 * string…") — it's the failure signal a maintainer (human or Claude) fixes
 * in one session, vs. "some messages show the wrong date sometimes".
 */
export function parseOFW<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  ctx: string,
  mode: 'strict' | 'lenient' = 'lenient',
): z.output<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  const message = `OFW response for ${ctx} failed validation: ${issues}`;
  if (mode === 'strict') throw new Error(message);
  console.error(`[ofw-mcp] WARNING: ${message} — continuing with the raw response; fields derived from it may be missing or wrong.`);
  return raw as z.output<S>;
}
