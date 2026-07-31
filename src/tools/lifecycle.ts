import type { OFWClient } from '../client.js';
import type { CacheStore, DraftRow, FolderName, MessageRow } from '../cache/store.js';
import { resolveFolderIds } from '../sync.js';
import { draftRevision, fetchMessageSnapshot } from './draft-freshness.js';
import type { MessageSnapshot } from './draft-freshness.js';
import { deriveRead } from './_shared.js';

/**
 * What an id IS right now on OurFamilyWizard — not merely whether it exists.
 *
 * `existsOnServer` was the question the old cheap check could answer, and it is
 * the wrong one: a draft that has been SENT still exists (as a sent message), so
 * `existsOnServer: true` came back for a draft the user had sent the night
 * before, and the summary built on it said "you have 3 drafts" when there were
 * two. `state` is the field that answers what was actually being asked.
 *
 *   draft     still sitting unsent in the Drafts folder
 *   sent      it went out — check `sentAt`; it is part of the record now
 *   received  an inbox message from the co-parent
 *   deleted   no longer on OFW at all
 *   unknown   OFW reported a folder we cannot map (or reported none). NOT a
 *             synonym for "fine" — it means the question was not answered.
 */
export type EntityState = 'draft' | 'sent' | 'received' | 'deleted' | 'unknown';

/**
 * The OFW system-folder ids needed to turn a detail payload's own folder id
 * into an {@link EntityState}. Any of them may be null when no sync has ever
 * populated the `meta` table.
 */
export interface FolderIdMap {
  inbox: string | null;
  sent: string | null;
  drafts: string | null;
}

/** OFW's `folderType` discriminator for each folder we track. */
export const FOLDER_TYPE: Record<FolderName, string> = {
  inbox: 'INBOX',
  sent: 'SENT_MESSAGES',
  drafts: 'DRAFTS',
};

/** Where each folder's id is persisted in the `meta` table. */
const FOLDER_ID_META_KEY: Record<FolderName, string> = {
  inbox: 'inbox_folder_id',
  sent: 'sent_folder_id',
  drafts: 'drafts_folder_id',
};

const FOLDERS: FolderName[] = ['inbox', 'sent', 'drafts'];

/** Read whatever folder ids past syncs persisted. No requests. */
export async function readFolderIdMap(store: CacheStore): Promise<FolderIdMap> {
  return {
    inbox: await store.getMeta(FOLDER_ID_META_KEY.inbox),
    sent: await store.getMeta(FOLDER_ID_META_KEY.sent),
    drafts: await store.getMeta(FOLDER_ID_META_KEY.drafts),
  };
}

/**
 * Persist folder ids harvested from a folders listing the caller ALREADY
 * fetched.
 *
 * `ofw_check_freshness` asked about folders and ids in one call hits
 * `/pub/v1/messageFolders?includeFolderCounts=true` for the counts, and then
 * `ensureFolderIdMap` hit the very same endpoint again to learn the ids. The
 * response in hand already carries them; taking them makes the second call a
 * no-op instead of a duplicate round trip.
 */
export async function persistFolderIds(
  store: CacheStore,
  systemFolders: Array<{ id: string; folderType: string }>,
): Promise<void> {
  for (const folder of FOLDERS) {
    const entry = systemFolders.find((f) => f.folderType === FOLDER_TYPE[folder]);
    if (entry !== undefined) await store.setMeta(FOLDER_ID_META_KEY[folder], entry.id);
  }
}

/**
 * The folder map, resolving it live when the cache has never held all three.
 *
 * Costs at most ONE request, and only when the map is genuinely incomplete —
 * without it every probe degrades to `unknown`, which is a refusal to answer,
 * not an answer. A failed resolve is swallowed: we fall back to the partial
 * cached map and let classification say `unknown` honestly, rather than failing
 * a whole status call over a folder listing.
 */
export async function ensureFolderIdMap(
  client: OFWClient,
  store: CacheStore,
): Promise<{ map: FolderIdMap; requests: number }> {
  const cached = await readFolderIdMap(store);
  if (cached.inbox !== null && cached.sent !== null && cached.drafts !== null) {
    return { map: cached, requests: 0 };
  }
  try {
    const ids = await resolveFolderIds(client, store);
    return { map: { inbox: ids.inbox, sent: ids.sent, drafts: ids.drafts }, requests: 1 };
  } catch {
    return { map: cached, requests: 1 };
  }
}

/**
 * OFW's own display names for the three system folders, as observed on live
 * detail payloads (`folder.name`). Keys are lower-cased for the comparison —
 * this is a fixed vocabulary OFW controls, not user content, so a
 * case-insensitive match is a normalization, not a guess.
 */
const STATE_BY_FOLDER_NAME: Record<string, EntityState> = {
  drafts: 'draft',
  sent: 'sent',
  'sent messages': 'sent',
  inbox: 'received',
};

/**
 * Map a live snapshot to a lifecycle state. Pure — the request already happened.
 *
 * A null snapshot means OFW returned 404 / an empty body, i.e. `deleted`. The
 * folder ID (matched against the persisted system-folder map) is the primary
 * signal; when the id is unreported or unmapped, the folder NAME OFW itself put
 * on the payload is a fallback with exactly the same authority — a snapshot
 * reporting `folder.name: "Drafts"` answered the question, and declaring it
 * `unknown` was a refusal to read the answer (observed live: every draft probe
 * came back "unknown" while echoing the name "Drafts"). Only a folder that is
 * unmappable by BOTH id and name is `unknown`: guessing beyond that is exactly
 * how "still a draft" gets asserted about something that was sent.
 */
export function classifyState(snapshot: MessageSnapshot | null, map: FolderIdMap): EntityState {
  if (snapshot === null) return 'deleted';
  const { folderId, folderName } = snapshot;
  if (folderId !== null) {
    if (map.drafts !== null && folderId === map.drafts) return 'draft';
    if (map.sent !== null && folderId === map.sent) return 'sent';
    if (map.inbox !== null && folderId === map.inbox) return 'received';
  }
  if (folderName !== null) {
    const byName = STATE_BY_FOLDER_NAME[folderName.trim().toLowerCase()];
    if (byName !== undefined) return byName;
  }
  return 'unknown';
}

/**
 * Would probing this id stamp the record?
 *
 * A probe is `GET /pub/v3/messages/{id}`, and for an UNREAD INBOX message that
 * marks it read on OFW and writes a co-parent-visible "First Viewed" time —
 * court-visible and irreversible. Everything else is free of side effects:
 *
 *   - a cached DRAFT: drafts have no read state at all;
 *   - a cached SENT message: its view times belong to the recipient, and our
 *     own fetch never writes one;
 *   - a cached inbox message already derived as read: the stamp exists, and
 *     `deriveRead` is monotonic so it cannot be added twice.
 *
 * An id with NO cached row returns true — whether it would stamp is exactly
 * what cannot be known without making the request that stamps it.
 */
export function probeWouldStamp(cachedDraft: DraftRow | null, cachedMessage: MessageRow | null): boolean {
  if (cachedDraft !== null) return false;
  if (cachedMessage === null) return true;
  if (cachedMessage.folder === 'sent') return false;
  return !deriveRead(cachedMessage);
}

/** One id's live verdict, as returned by ofw_check_freshness and ofw_status. */
export interface LifecycleItem extends Record<string, unknown> {
  id: number;
  /** Absent when the probe did not run (skipped / errored). */
  state?: EntityState;
}

const SKIP_NOTE = 'Verifying this id requires fetching its detail from OurFamilyWizard, which would mark an unread inbox message as READ and stamp a co-parent-visible "First Viewed" time on the record. Ids already cached as drafts, as sent, or as already-read inbox messages are probed freely because none of those can stamp anything. Run ofw_sync_messages (it walks list pages, not bodies) or pass allowMarkRead:true.';

function stateNote(
  state: EntityState,
  cachedAsDraft: boolean,
  folderName: string | null,
): string | undefined {
  if (state === 'deleted') {
    return cachedAsDraft
      ? 'This draft is in the local cache but NO LONGER EXISTS on OurFamilyWizard — it was sent or deleted elsewhere. Do not describe it as still unsent.'
      : 'Not found on OurFamilyWizard.';
  }
  if (state === 'sent') {
    return cachedAsDraft
      ? 'This id is cached as a DRAFT but OurFamilyWizard now has it in Sent — it was SENT (see sentAt). It is no longer a draft; saying it is still unsent would be false.'
      : 'This id is a sent message on OurFamilyWizard.';
  }
  if (state === 'received') {
    return cachedAsDraft
      ? 'This id is cached as a draft but OurFamilyWizard has it in the Inbox. Run ofw_sync_messages to reconcile.'
      : 'This id is an inbox message on OurFamilyWizard.';
  }
  if (state === 'unknown') {
    return `OurFamilyWizard did not report a folder this tool can map${folderName === null ? '' : ` (it reported "${folderName}")`}, so what this id has become is NOT established. Treat it as unverified rather than assuming it is unchanged.`;
  }
  return undefined;
}

/** One id's cached state, read once and reused across planning and probing. */
interface PreparedProbe {
  id: number;
  cachedDraft: DraftRow | null;
  cachedMessage: MessageRow | null;
  skip: boolean;
}

/**
 * Probe a batch of ids live and return one lifecycle verdict each.
 *
 * Skips are decided BEFORE anything is fetched, so a call whose every id is
 * refused spends zero OFW requests — including the folder-map resolve, which
 * only happens when at least one id will actually be probed. Costs at most one
 * request for the map plus one per probed id.
 */
export async function probeIds(
  client: OFWClient,
  store: CacheStore,
  ids: number[],
  opts: { allowMarkRead: boolean },
): Promise<{ items: LifecycleItem[]; requests: number }> {
  // THREE cache reads for the whole batch, not three per id. On the Durable
  // Object backend every cache call is a subrequest counting against the same
  // hosting cap as the OFW fetches, so a per-id lookup would spend the caller's
  // budget on bookkeeping before a single probe ran.
  const draftsById = new Map((await store.getDrafts(ids)).map((d) => [d.id, d]));
  const messagesById = new Map((await store.getMessages(ids)).map((m) => [m.id, m]));

  const prepared: PreparedProbe[] = ids.map((id) => {
    const cachedDraft = draftsById.get(id) ?? null;
    const cachedMessage = cachedDraft === null ? messagesById.get(id) ?? null : null;
    return {
      id,
      cachedDraft,
      cachedMessage,
      skip: !opts.allowMarkRead && probeWouldStamp(cachedDraft, cachedMessage),
    };
  });

  let requests = 0;
  let map: FolderIdMap = { inbox: null, sent: null, drafts: null };
  if (prepared.some((p) => !p.skip)) {
    const resolved = await ensureFolderIdMap(client, store);
    map = resolved.map;
    requests += resolved.requests;
  }

  const keyById = new Map(
    (await store.getDraftLineageByIds(ids)).map((l) => [l.id, l.draftKey]),
  );

  const items: LifecycleItem[] = [];
  for (const p of prepared) {
    if (p.skip) {
      items.push({ id: p.id, skipped: true, reason: 'WOULD_MARK_READ', note: SKIP_NOTE });
      continue;
    }
    const probe = await probeOne(client, p, map, keyById.get(p.id) ?? null);
    requests += probe.requests;
    items.push(probe.item);
  }
  return { items, requests };
}

/**
 * The live half of one probe. Never throws: a probe that could not run comes
 * back as an error item, because a check that failed must never read as
 * "in sync".
 */
async function probeOne(
  client: OFWClient,
  prepared: PreparedProbe,
  map: FolderIdMap,
  draftKey: string | null,
): Promise<{ item: LifecycleItem; requests: number }> {
  const { id, cachedDraft } = prepared;

  let snapshot: MessageSnapshot | null;
  try {
    snapshot = await fetchMessageSnapshot(client, id);
  } catch (e) {
    return {
      requests: 1,
      item: {
        id,
        error: 'FRESHNESS_CHECK_FAILED',
        message: (e as Error).message,
        inSync: null,
        note: 'The freshness check itself failed, so nothing is confirmed either way.',
      },
    };
  }

  const state = classifyState(snapshot, map);
  const cacheRevision = cachedDraft === null ? null : draftRevision(cachedDraft);
  const serverRevision = snapshot === null ? null : draftRevision(snapshot.content);
  const viewedAt = snapshot?.content.recipients.find((r) => r.viewedAt !== null)?.viewedAt ?? null;

  // `inSync` compares the CACHED DRAFT against the server, and it is FALSE the
  // moment the entity stops being what the cache says it is — even when every
  // byte of content still matches. A sent draft keeps its subject and body
  // verbatim, so a revision-only comparison reported inSync:true for exactly
  // the case this whole mechanism exists to catch.
  //
  // `null` means "not compared", the same thing it means on the folder
  // verdicts: there is no cached draft to compare, or the content matches but
  // OFW did not tell us where the message now lives. Never `false` for those —
  // false claims a drift was detected.
  let inSync: boolean | null;
  if (cachedDraft === null) inSync = null;
  else if (snapshot === null) inSync = false;
  else if (cacheRevision !== serverRevision) inSync = false;
  else if (state === 'draft') inSync = true;
  else if (state === 'unknown') inSync = null;
  else inSync = false;

  // State and content are INDEPENDENT signals, so both are reported. An
  // unmappable folder must not swallow "this was edited on OFW", and a content
  // match must not swallow "this is no longer a draft".
  const notes: string[] = [];
  const stateN = stateNote(state, cachedDraft !== null, snapshot?.folderName ?? null);
  if (stateN !== undefined) notes.push(stateN);
  if (snapshot !== null && cachedDraft === null) {
    notes.push('Not in the drafts cache, so there is no cached copy to compare its content against (inSync is null, not false).');
  } else if (snapshot !== null && cacheRevision !== serverRevision) {
    notes.push('Content differs from the cache — it was edited on OurFamilyWizard since the last sync. Run ofw_sync_messages before reading or writing it.');
  }

  return {
    requests: 1,
    item: {
      id,
      state,
      folder: snapshot?.folderName ?? null,
      sentAt: state === 'sent' ? snapshot?.dateTime ?? null : null,
      viewedAt,
      existsOnServer: snapshot !== null,
      cacheRevision,
      serverRevision,
      inSync,
      ...(draftKey !== null ? { draftKey } : {}),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    },
  };
}

/**
 * Resolve a stable {@link import('../cache/store.js').DraftLineageRow} key to
 * the chain's CURRENT id.
 *
 * Returns null when the key was never recorded — an unknown key must not
 * silently resolve to nothing-in-particular.
 */
export async function resolveDraftKey(
  store: CacheStore,
  draftKey: string,
): Promise<{ currentId: number; ids: number[] } | null> {
  const chain = await store.getDraftLineage(draftKey);
  if (chain.length === 0) return null;
  return { currentId: chain[chain.length - 1].id, ids: chain.map((r) => r.id) };
}

/**
 * Mint a new stable draft identity. Uses the Web Crypto global, which both
 * Node ≥19 and the Workers runtime provide — a `node:crypto` import would not
 * bundle for the hosted connector.
 */
export function newDraftKey(): string {
  return `dk_${crypto.randomUUID()}`;
}
