import { z } from 'zod';
import { parseLenient, pruneUndefined } from '@chrischall/mcp-utils';
import type { OFWClient } from '../client.js';
import type { Recipient } from '../cache/store.js';
import { ApiRecipientSchema, mapRecipients } from './_shared.js';
import { briefDate, briefLine } from './hints.js';
import { offsetState, readUpstreamPaging } from './pagination.js';

/**
 * Messages in folders the cache does not hold (issue #453).
 *
 * The cache syncs three folders: inbox, sent and drafts. OurFamilyWizard has
 * more — user-created folders, plus system folders such as Archived and Action
 * Items — and a message the account holder files into one of them leaves the
 * inbox, so before this it was unreachable from every tool. And
 * `ofw_list_message_folders` advertised "folder IDs needed to call
 * ofw_list_messages", which then refused every one of them.
 *
 * These are read LIVE, one list page per call, and never cached. The list
 * endpoint is what the sync already walks: it carries no body and stamps
 * nothing, so reading a folder this way can never mark a message read. Bodies
 * stay behind `ofw_get_message`, with every gate it applies.
 */

const FolderEntrySchema = z.looseObject({
  // Numeric on the live payload (verified 2026-11-19), strings in older fixtures.
  id: z.union([z.number(), z.string()]).optional(),
  name: z.string().optional(),
  folderType: z.string().optional(),
});
const FoldersSchema = z.looseObject({
  systemFolders: z.array(FolderEntrySchema).optional(),
  userFolders: z.array(FolderEntrySchema).optional(),
});

/** One OFW message folder, as this module names it. */
export interface LiveFolder {
  id: string;
  name: string | null;
  folderType: string | null;
  /** True for a folder the account holder created. */
  user: boolean;
}

export type ResolvedFolder =
  /** A folder the cache holds: answer from the cache, as before. */
  | { kind: 'cached'; folder: 'inbox' | 'sent' }
  /** The drafts folder, which has its own tool. */
  | { kind: 'drafts' }
  /** Any other folder: read live. */
  | { kind: 'live'; folder: LiveFolder }
  /** No single folder matched; `available` is every folder OFW reported (or the tied ones). */
  | { kind: 'unknown'; available: LiveFolder[]; ambiguous: boolean };

/**
 * Resolve a caller's folder (an OFW id or a folder name) against OFW's live
 * folder list. One request. An id or name that matches nothing is UNKNOWN,
 * never an empty folder: OFW answers a list request for a folder that does not
 * exist with an empty page, which would read as "no messages".
 */
export async function resolveMessageFolder(client: OFWClient, arg: string): Promise<ResolvedFolder> {
  const data = parseLenient(
    FoldersSchema,
    await client.request('GET', '/pub/v1/messageFolders?includeFolderCounts=true'),
    { label: 'ofw-mcp', context: 'GET /pub/v1/messageFolders (ofw_list_messages folder)' },
  ) as z.infer<typeof FoldersSchema> | null;
  const toFolder = (user: boolean) => (f: z.infer<typeof FolderEntrySchema>): LiveFolder | null =>
    f.id === undefined ? null : { id: String(f.id), name: f.name ?? null, folderType: f.folderType ?? null, user };
  const all = [
    ...(data?.systemFolders ?? []).map(toFolder(false)),
    ...(data?.userFolders ?? []).map(toFolder(true)),
  ].filter((f): f is LiveFolder => f !== null);

  const wanted = arg.trim();
  let matches = all.filter((f) => f.id === wanted);
  if (matches.length === 0) {
    const lower = wanted.toLowerCase();
    matches = all.filter((f) => f.name !== null && f.name.trim().toLowerCase() === lower);
  }
  if (matches.length !== 1) {
    return { kind: 'unknown', available: matches.length > 1 ? matches : all, ambiguous: matches.length > 1 };
  }
  const [folder] = matches;
  if (folder.folderType === 'INBOX') return { kind: 'cached', folder: 'inbox' };
  if (folder.folderType === 'SENT_MESSAGES') return { kind: 'cached', folder: 'sent' };
  if (folder.folderType === 'DRAFTS') return { kind: 'drafts' };
  return { kind: 'live', folder };
}

const ListItemSchema = z.looseObject({
  id: z.number(),
  subject: z.string(),
  date: z.looseObject({ dateTime: z.string() }).optional(),
  recipients: z.array(ApiRecipientSchema).optional(),
});
const ListResponseSchema = z.looseObject({ data: z.array(ListItemSchema).optional() });

/** One message from a live folder page. Never carries a body. */
export interface FolderMessage {
  id: number;
  folderId: string;
  folderName: string | null;
  subject: string;
  /** The sender's name, or null when OFW named none. */
  from: string | null;
  sentAt: string | null;
  recipients: Recipient[];
  /**
   * OFW's own list `read` flag, or null when it sent none. Never derived from
   * anything else: on the inbox list that flag is the account holder's read
   * state, and nothing here vouches that a custom folder means otherwise.
   */
  read: boolean | null;
  replied?: boolean;
  files?: number;
  /** `view:"full"` only: the list item, with every copy of the body removed. */
  listData?: Record<string, unknown>;
}

export interface FolderPage {
  messages: FolderMessage[];
  /** Records in `messages`. */
  returned: number;
  /** List items dropped because they carried no numeric id. */
  skipped: number;
  /** Total across all pages, when OFW reported one. */
  total: number | null;
  hasMore: boolean;
  nextPage: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nameOf(value: unknown): string | null {
  const name = asRecord(value)?.name;
  return typeof name === 'string' && name !== '' ? name : null;
}

/**
 * Fetch ONE list page of a folder, newest (or oldest) first. One request, no
 * detail GETs: the list carries no body, so nothing is marked read.
 */
export async function fetchFolderPage(
  client: OFWClient,
  folder: LiveFolder,
  opts: { page: number; size: number; sort: 'newest' | 'oldest'; checkedAt: string; full?: boolean },
): Promise<FolderPage> {
  const direction = opts.sort === 'oldest' ? 'asc' : 'desc';
  const raw = await client.request(
    'GET',
    `/pub/v3/messages?folders=${encodeURIComponent(folder.id)}&page=${opts.page}&size=${opts.size}&sort=date&sortDirection=${direction}`,
  );
  // Lenient: a mismatch warns on stderr and the raw payload flows on, so each
  // item is read defensively below rather than trusted to the schema.
  parseLenient(ListResponseSchema, raw, { label: 'ofw-mcp', context: 'GET /pub/v3/messages?folders={folder}' });
  const items = (asRecord(raw)?.data as unknown[] | undefined) ?? [];
  const upstream = readUpstreamPaging(raw);

  const messages: FolderMessage[] = [];
  for (const entry of items) {
    const it = asRecord(entry);
    if (it === null || typeof it.id !== 'number') continue;
    const files = it.files;
    const dateTime = asRecord(it.date)?.dateTime;
    const message: FolderMessage = pruneUndefined({
      id: it.id,
      folderId: folder.id,
      folderName: folder.name,
      subject: typeof it.subject === 'string' ? it.subject : '',
      from: nameOf(it.author) ?? nameOf(it.from),
      sentAt: typeof dateTime === 'string' ? dateTime : null,
      recipients: mapRecipients(
        Array.isArray(it.recipients) ? it.recipients as z.infer<typeof ApiRecipientSchema>[] : [],
        { source: 'list', checkedAt: opts.checkedAt },
      ),
      read: typeof it.read === 'boolean' ? it.read : null,
      replied: typeof it.replied === 'boolean' ? it.replied : undefined,
      files: typeof files === 'number' ? files : Array.isArray(files) ? files.length : undefined,
    }) as FolderMessage;
    if (opts.full) {
      const { preview: _preview, body: _body, ...listData } = it;
      message.listData = listData;
    }
    messages.push(message);
  }

  const { hasMore } = offsetState({
    start: (opts.page - 1) * opts.size,
    max: opts.size,
    returned: items.length,
    total: upstream.total,
    last: upstream.last,
    base: 0,
  });
  return {
    messages,
    returned: messages.length,
    skipped: items.length - messages.length,
    total: upstream.total,
    hasMore,
    nextPage: hasMore ? opts.page + 1 : null,
  };
}

/** One folder message as a brief line: `<sender>: <subject> — <sent> — read|unread`. */
export function folderMessageBrief(m: FolderMessage, tz: string): string {
  const status = m.read === null ? 'read state unknown' : m.read ? 'read' : 'unread';
  return briefLine(m.from ? `${m.from}: ${m.subject}` : m.subject, briefDate(m.sentAt, tz), status);
}

/**
 * The largest page a live folder read asks OFW for: the size the sync walks
 * with, so it is known to be honoured. A bigger request OFW silently capped
 * would come back short and read as the last page.
 */
export const LIVE_FOLDER_MAX_PAGE = 50;
