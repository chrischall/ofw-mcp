import { z } from 'zod';
import { parseLenient } from '@chrischall/mcp-utils';
import type { OFWClient } from '../client.js';
import type { Recipient } from '../cache/store.js';
import { ApiRecipientSchema, mapRecipients } from './_shared.js';

/**
 * The content of a draft, normalized so a server copy and a cached copy are
 * directly comparable. Deliberately excludes `modifiedAt`.
 *
 * WHY NO TIMESTAMP TOKEN: OFW's draft `date.dateTime` is NOT a modification
 * time — editing a draft in the OFW web app does not bump it (this is why
 * commit 8295e72 removed the old modifiedAt-based skip from syncDrafts, and
 * why syncDrafts fetches every draft's detail unconditionally). An
 * `expectedModifiedAt` precondition would therefore compare EQUAL across
 * exactly the edit it exists to catch — a guard that always votes FRESH is
 * worse than no guard, because it manufactures confidence. The concurrency
 * token here is instead derived from the draft's content.
 */
export interface DraftContent {
  subject: string;
  body: string;
  recipients: Recipient[];
  replyToId: number | null;
}

/** Thrown when the freshness check itself could not be completed. */
export class DraftFreshnessError extends Error {}

// FNV-1a (64-bit) over a canonical encoding. Not cryptographic — this is a
// change detector, and it is never the sole guard: an unsupplied token falls
// back to a full field-by-field comparison against the cached base.
// BigInt keeps it byte-identical on node and on the Workers runtime.
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function fnv1a64(s: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ BigInt(s.charCodeAt(i))) * FNV_PRIME & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * A stable content revision for a draft. Callers get this back from
 * `ofw_list_drafts` / `ofw_get_message` and pass it to `ofw_save_draft` /
 * `ofw_delete_draft` as `expectedRevision`.
 *
 * Recipients reduce to a SORTED set of user ids: their display names and
 * `viewedAt` are presentation detail that differs between a list-sourced and a
 * detail-sourced copy of the same draft, and would otherwise produce a false
 * STALE. Fields are length-prefixed so content cannot shift across a field
 * boundary without changing the hash.
 */
export function draftRevision(d: DraftContent): string {
  const ids = [...new Set(d.recipients.map((r) => r.userId))].sort((a, b) => a - b);
  const parts = [d.subject, d.body, String(d.replyToId ?? ''), ids.join(',')];
  return `r1:${fnv1a64(parts.map((p) => `${p.length}:${p}`).join('|'))}`;
}

const ServerDraftSchema = z.looseObject({
  subject: z.string().optional(),
  body: z.string().optional(),
  replyToId: z.number().nullable().optional(),
  recipients: z.array(ApiRecipientSchema).optional(),
});

function isNotFound(e: unknown): boolean {
  return e instanceof Error && /OFW API error: 404\b/.test(e.message);
}

/**
 * Read a draft's AUTHORITATIVE state straight from OFW, bypassing the cache.
 *
 * Returns `null` when the draft no longer exists (404). Any other failure
 * throws `DraftFreshnessError`: a freshness check that could not run must
 * abort the write, never wave it through — see the callers in messages.ts.
 */
export async function fetchServerDraft(client: OFWClient, id: number): Promise<DraftContent | null> {
  let raw: unknown;
  try {
    raw = await client.request('GET', `/pub/v3/messages/${id}`);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw new DraftFreshnessError(
      `could not read the current state of draft ${id} from OurFamilyWizard: ${(e as Error).message}`,
    );
  }
  // An empty/null body is OFW's other way of saying "no such message". Treat
  // it as MISSING — which still ABORTS the write — rather than letting the
  // strict parse throw an opaque shape error.
  if (raw === null || raw === undefined) return null;
  const detail = parseLenient(ServerDraftSchema, raw, {
    label: 'ofw-mcp',
    context: 'GET /pub/v3/messages/{id} (draft freshness check)',
    mode: 'strict',
  });
  return {
    subject: detail.subject ?? '',
    body: detail.body ?? '',
    replyToId: detail.replyToId ?? null,
    recipients: mapRecipients(detail.recipients),
  };
}

export type FreshnessVerdict = 'FRESH' | 'STALE' | 'MISSING';

export interface FreshnessResult {
  verdict: FreshnessVerdict;
  reason: string;
  /** Which fields diverged between server and cached base (STALE only). */
  changedFields: string[];
}

function diffFields(a: DraftContent, b: DraftContent): string[] {
  const changed: string[] = [];
  if (a.subject !== b.subject) changed.push('subject');
  if (a.body !== b.body) changed.push('body');
  if (a.replyToId !== b.replyToId) changed.push('replyToId');
  const ids = (d: DraftContent): string =>
    [...new Set(d.recipients.map((r) => r.userId))].sort((x, y) => x - y).join(',');
  if (ids(a) !== ids(b)) changed.push('recipients');
  return changed;
}

/**
 * Decide whether it is safe to destroy the server's copy of a draft.
 *
 * Two independent ways to earn FRESH, in priority order:
 *
 *  1. `expectedRevision` matches the live server revision. The caller has named
 *     the exact server state it edited from, which is what optimistic
 *     concurrency asserts. A stale cached copy alongside a matching token is
 *     not evidence of a conflict, so the token wins.
 *  2. No token supplied → the cached base must match the server EXACTLY. This
 *     is the safe default: "no token" never means "force".
 *
 * Everything else — server ahead of cache, no cached base to compare, draft
 * gone from the server — refuses.
 */
export function checkDraftFreshness(input: {
  server: DraftContent | null;
  cached: DraftContent | null;
  expectedRevision?: string;
}): FreshnessResult {
  const { server, cached, expectedRevision } = input;

  if (server === null) {
    return {
      verdict: 'MISSING',
      reason: 'The draft no longer exists on OurFamilyWizard — it may have been sent or deleted elsewhere.',
      changedFields: [],
    };
  }

  if (expectedRevision !== undefined) {
    const actual = draftRevision(server);
    if (expectedRevision === actual) {
      return { verdict: 'FRESH', reason: 'expectedRevision matches the live server draft.', changedFields: [] };
    }
    return {
      verdict: 'STALE',
      reason: `expectedRevision ${expectedRevision} does not match the live server draft (${actual}) — it changed after you read it.`,
      changedFields: cached === null ? [] : diffFields(server, cached),
    };
  }

  if (cached === null) {
    return {
      verdict: 'STALE',
      reason: 'This draft is not in the local cache, so there is no base to confirm the edit against.',
      changedFields: [],
    };
  }

  const changedFields = diffFields(server, cached);
  if (changedFields.length === 0) {
    return { verdict: 'FRESH', reason: 'The cached draft matches the live server draft.', changedFields: [] };
  }
  return {
    verdict: 'STALE',
    reason: `The draft on OurFamilyWizard differs from the cached copy (${changedFields.join(', ')}) — it was edited outside this tool.`,
    changedFields,
  };
}

export interface StaleDraftPayload {
  error: string;
  draftId: number;
  verdict: FreshnessVerdict;
  reason: string;
  changedFields?: string[];
  serverBody?: string;
  serverSubject?: string;
  serverRevision?: string;
  cachedBody?: string;
  recovery: string;
}

/**
 * Build the structured refusal returned when a destructive draft op is blocked.
 * ALWAYS carries the current server body when there is one, so the content we
 * declined to overwrite is recoverable from the tool result itself.
 */
export function staleDraftPayload(input: {
  error: string;
  draftId: number;
  verdict: FreshnessResult;
  server: DraftContent | null;
  cached: DraftContent | null;
}): StaleDraftPayload {
  const { error, draftId, verdict, server, cached } = input;
  return {
    error,
    draftId,
    verdict: verdict.verdict,
    reason: verdict.reason,
    ...(verdict.changedFields.length > 0 ? { changedFields: verdict.changedFields } : {}),
    ...(server !== null
      ? { serverBody: server.body, serverSubject: server.subject, serverRevision: draftRevision(server) }
      : {}),
    ...(cached !== null ? { cachedBody: cached.body } : {}),
    recovery: server === null
      ? 'The draft is gone from OurFamilyWizard. Nothing was changed. If you still want this content saved, call ofw_save_draft WITHOUT messageId to create a new draft.'
      : 'Nothing was changed. Merge your edit into serverBody above, then retry with expectedRevision set to serverRevision. Pass force:true only if you intend to discard the server copy shown here.',
  };
}
