import { z } from 'zod';
import { parseLenient } from '@chrischall/mcp-utils';
import type { OFWClient } from '../client.js';
import type { Recipient } from '../cache/store.js';
import { ApiRecipientSchema, mapRecipients, threadedReplyTo } from './_shared.js';

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
  // BOTH spellings of the threading echo (see ThreadingEcho in _shared.ts):
  // OFW reports the reply target as `replyToId` on some payloads and as
  // `inReplyTo` on others. The snapshot derives one value from whichever is
  // present, so the revision hashed here matches the one ofw_save_draft
  // computed from the same server state — a one-sided read produced revisions
  // that disagreed about the same draft.
  replyToId: z.number().nullable().optional(),
  inReplyTo: z.number().nullable().optional(),
  recipients: z.array(ApiRecipientSchema).optional(),
  // Read for the LIFECYCLE answer (see tools/lifecycle.ts): which folder OFW
  // itself says this id lives in right now. `existsOnServer` alone cannot
  // distinguish "still a draft" from "was sent" — a sent draft still exists.
  // `id` accepts BOTH spellings deliberately. This schema is parsed in
  // `mode: 'strict'` because it backs the destructive-draft guard, so a
  // present-but-mistyped field THROWS — and OFW is already inconsistent about
  // this exact field: the folders listing (`FoldersSchema` in sync.ts) types it
  // `z.string()`, while message detail has been observed returning a number.
  // Pinning one spelling here would turn a harmless representation change into
  // a hard failure of ofw_save_draft / ofw_delete_draft, which is the opposite
  // of what a strict boundary is for: it exists to stop us acting on a response
  // we cannot interpret, not to reject one we can. `folderId` is normalized to
  // a string below, so both spellings compare correctly downstream.
  folder: z.looseObject({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
  }).nullable().optional(),
  date: z.looseObject({ dateTime: z.string().optional() }).nullable().optional(),
});

function isNotFound(e: unknown): boolean {
  return e instanceof Error && /OFW API error: 404\b/.test(e.message);
}

/**
 * One live read of a message/draft, carrying both its comparable CONTENT and
 * the metadata needed to say what it has BECOME.
 *
 * Deliberately one object from one request: asking "did this change?" and
 * "is this still a draft?" separately would double the cost of the cheap
 * verification primitive that exists precisely so verification stays cheaper
 * than recollection.
 */
export interface MessageSnapshot {
  content: DraftContent;
  /** OFW's own folder id for this message right now, or null when unreported. */
  folderId: string | null;
  /** OFW's display name for that folder, echoed for the caller. */
  folderName: string | null;
  /** `date.dateTime` — the sent time for a sent message. */
  dateTime: string | null;
}

/**
 * Read a message's AUTHORITATIVE state straight from OFW, bypassing the cache.
 *
 * Returns `null` when it no longer exists (404, or an empty body — OFW's other
 * way of saying "no such message"). Any other failure throws.
 *
 * Most failures throw `DraftFreshnessError`, but not all — a strict
 * `parseLenient` mismatch throws `McpToolError` instead. Callers must not assume
 * the narrower type (the catch blocks read only `.message`, which every Error
 * carries).
 */
export async function fetchMessageSnapshot(client: OFWClient, id: number): Promise<MessageSnapshot | null> {
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
    content: {
      subject: detail.subject ?? '',
      body: detail.body ?? '',
      replyToId: threadedReplyTo(detail),
      recipients: mapRecipients(detail.recipients),
    },
    folderId: detail.folder?.id === undefined ? null : String(detail.folder.id),
    folderName: detail.folder?.name ?? null,
    dateTime: detail.date?.dateTime ?? null,
  };
}

/**
 * The content-only view of {@link fetchMessageSnapshot}, used by the
 * destructive-draft guard, which cares what the draft SAYS, not where it lives.
 *
 * Returns `null` when the draft no longer exists. Any other failure throws, and
 * the callers in messages.ts abort on ALL of them: a freshness check that could
 * not run must never wave the write through.
 */
export async function fetchServerDraft(client: OFWClient, id: number): Promise<DraftContent | null> {
  return (await fetchMessageSnapshot(client, id))?.content ?? null;
}

export type FreshnessVerdict = 'FRESH' | 'STALE' | 'MISSING';

export interface FreshnessResult {
  verdict: FreshnessVerdict;
  reason: string;
  /** Which fields diverged between server and cached base. */
  changedFields: string[];
  /**
   * FRESH verdicts only. True when the sole divergence was
   * connector/server-authored metadata (`replyToId` normalized after the save)
   * with the substantive content (subject/body/recipients) intact — so a caller
   * can note the normalization rather than mistaking it for a conflict. See
   * SUBSTANTIVE_FIELDS.
   */
  metadataOnly?: boolean;
}

/**
 * The fields whose divergence constitutes a REAL conflict — the actual message
 * content a caller would lose if we overwrote a copy edited elsewhere. Anything
 * NOT listed here (currently only `replyToId`) is connector/server-authored
 * metadata: OFW normalizes `replyToId` after a draft is saved (dropping it, or
 * re-targeting it to the thread tip), which is the connector's own mutation
 * surfacing later — not third-party interference. A divergence in metadata
 * alone must never refuse the write, or the guard manufactures a false STALE
 * for a change the caller did not make. See issue thread on save/edit round
 * trips.
 */
const SUBSTANTIVE_FIELDS = ['subject', 'body', 'recipients'] as const;

/** The substantive subset of a changed-field list (drops metadata like replyToId). */
function substantiveChanges(changed: string[]): string[] {
  return changed.filter((f) => (SUBSTANTIVE_FIELDS as readonly string[]).includes(f));
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
 * In BOTH modes the conflict decision turns on the SUBSTANTIVE fields
 * (subject/body/recipients), not on any revision delta. When the only thing
 * that moved is connector/server-authored metadata — `replyToId` normalized
 * after the save — the content is intact, so it is FRESH (with `metadataOnly`
 * set) rather than STALE. That is the connector's own mutation resurfacing, not
 * a third party editing the draft; refusing it would be a false positive that
 * trains callers to distrust the guard. The fail-safe direction is untouched:
 * the moment subject, body or recipients differ, it still refuses.
 *
 * Everything else — server ahead of cache on real content, no cached base to
 * compare, draft gone from the server — refuses.
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
    // Token mismatch. When the caller's token is the one WE cached, we can name
    // exactly what drifted — and if that is metadata alone, it is our own
    // post-save normalization, not a conflict.
    if (cached !== null && draftRevision(cached) === expectedRevision) {
      const changedFields = diffFields(server, cached);
      if (substantiveChanges(changedFields).length === 0) {
        return {
          verdict: 'FRESH',
          reason: `Only connector-authored metadata (${changedFields.join(', ')}) changed since you read the draft; its subject, body and recipients are unchanged, so this is not a conflict.`,
          changedFields,
          metadataOnly: true,
        };
      }
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
  if (substantiveChanges(changedFields).length === 0) {
    return {
      verdict: 'FRESH',
      reason: `Only connector-authored metadata (${changedFields.join(', ')}) differs from the cached copy; subject, body and recipients match, so this is not a conflict.`,
      changedFields,
      metadataOnly: true,
    };
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
