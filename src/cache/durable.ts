import { DurableObject } from 'cloudflare:workers';
import { createHelpfulError } from '@chrischall/mcp-utils';
import {
  OFWCacheCore,
  type AttachmentRow,
  type CacheStore,
  type DraftRow,
  type FolderName,
  type ListMessagesOptions,
  type MessageFilter,
  type MessageRow,
  type SqlDriver,
  type SqlParam,
  type SyncState,
  type UpsertAttachmentInput,
} from './store.js';

// The Cloudflare Durable Object backend for the OFW message cache, used by the
// remote connector (src/worker.ts). The connector's own MCP agent DO is keyed
// per session (per conversation) and so its storage is ephemeral; this is a
// SEPARATE, durable DO keyed by the authenticated operator's username
// (idFromName), so one cache persists across all of that user's conversations.
// Keying by the operator (never a subject being queried) means a user's cache
// only ever holds message history their own OFW account was allowed to fetch.

/** Adapts a Durable Object's SQLite storage to the driver the core needs. */
class SqlStorageDriver implements SqlDriver {
  constructor(private readonly storage: DurableObjectStorage) {}
  private get sql(): SqlStorage {
    return this.storage.sql;
  }
  execScript(sql: string): void {
    this.sql.exec(sql);
  }
  run(sql: string, params: SqlParam[]): void {
    this.sql.exec(sql, ...params);
  }
  get(sql: string, params: SqlParam[]): Record<string, unknown> | undefined {
    return this.sql.exec(sql, ...params).toArray()[0] as Record<string, unknown> | undefined;
  }
  all(sql: string, params: SqlParam[]): Record<string, unknown>[] {
    return this.sql.exec(sql, ...params).toArray() as Record<string, unknown>[];
  }
  transaction(fn: () => void): void {
    // SQLite-backed DO storage runs a synchronous closure atomically.
    this.storage.transactionSync(fn);
  }
}

/**
 * Per-operator durable message cache Durable Object. Its public async methods
 * are the RPC surface {@link DurableCacheStore} calls; each delegates to the
 * shared synchronous {@link OFWCacheCore} over this DO's SQLite storage.
 */
export class OFWCacheDO extends DurableObject {
  private readonly core: OFWCacheCore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.core = new OFWCacheCore(new SqlStorageDriver(ctx.storage));
  }

  async upsertMessage(row: MessageRow): Promise<void> {
    this.core.upsertMessage(row);
  }
  async getMessage(id: number): Promise<MessageRow | null> {
    return this.core.getMessage(id);
  }
  async deleteMessage(id: number): Promise<void> {
    this.core.deleteMessage(id);
  }
  async listMessages(opts: ListMessagesOptions): Promise<MessageRow[]> {
    return this.core.listMessages(opts);
  }
  async countMessages(opts: MessageFilter): Promise<number> {
    return this.core.countMessages(opts);
  }
  async upsertDraft(row: DraftRow): Promise<void> {
    this.core.upsertDraft(row);
  }
  async getDraft(id: number): Promise<DraftRow | null> {
    return this.core.getDraft(id);
  }
  async listDrafts(opts: { page: number; size: number }): Promise<DraftRow[]> {
    return this.core.listDrafts(opts);
  }
  async deleteDraft(id: number): Promise<void> {
    this.core.deleteDraft(id);
  }
  async listDraftIds(): Promise<number[]> {
    return this.core.listDraftIds();
  }
  async getSyncState(folder: FolderName): Promise<SyncState | null> {
    return this.core.getSyncState(folder);
  }
  async setSyncState(folder: FolderName, state: SyncState): Promise<void> {
    this.core.setSyncState(folder, state);
  }
  async getMeta(key: string): Promise<string | null> {
    return this.core.getMeta(key);
  }
  async setMeta(key: string, value: string): Promise<void> {
    this.core.setMeta(key, value);
  }
  async findLatestReplyTip(replyToId: number): Promise<number> {
    return this.core.findLatestReplyTip(replyToId);
  }
  async getAttachment(fileId: number): Promise<AttachmentRow | null> {
    return this.core.getAttachment(fileId);
  }
  async listAttachmentsForMessage(messageId: number): Promise<AttachmentRow[]> {
    return this.core.listAttachmentsForMessage(messageId);
  }
  async upsertAttachmentForMessage(input: UpsertAttachmentInput): Promise<void> {
    this.core.upsertAttachmentForMessage(input);
  }
  async markAttachmentDownloaded(fileId: number, path: string): Promise<void> {
    this.core.markAttachmentDownloaded(fileId, path);
  }
}

/** A {@link CacheStore} that forwards every call to an {@link OFWCacheDO} stub. */
class DurableCacheStore implements CacheStore {
  constructor(private readonly stub: DurableObjectStub<OFWCacheDO>) {}
  upsertMessage(row: MessageRow): Promise<void> {
    return this.stub.upsertMessage(row);
  }
  getMessage(id: number): Promise<MessageRow | null> {
    return this.stub.getMessage(id);
  }
  deleteMessage(id: number): Promise<void> {
    return this.stub.deleteMessage(id);
  }
  listMessages(opts: ListMessagesOptions): Promise<MessageRow[]> {
    return this.stub.listMessages(opts);
  }
  countMessages(opts: MessageFilter): Promise<number> {
    return this.stub.countMessages(opts);
  }
  upsertDraft(row: DraftRow): Promise<void> {
    return this.stub.upsertDraft(row);
  }
  getDraft(id: number): Promise<DraftRow | null> {
    return this.stub.getDraft(id);
  }
  listDrafts(opts: { page: number; size: number }): Promise<DraftRow[]> {
    return this.stub.listDrafts(opts);
  }
  deleteDraft(id: number): Promise<void> {
    return this.stub.deleteDraft(id);
  }
  listDraftIds(): Promise<number[]> {
    return this.stub.listDraftIds();
  }
  getSyncState(folder: FolderName): Promise<SyncState | null> {
    return this.stub.getSyncState(folder);
  }
  setSyncState(folder: FolderName, state: SyncState): Promise<void> {
    return this.stub.setSyncState(folder, state);
  }
  getMeta(key: string): Promise<string | null> {
    return this.stub.getMeta(key);
  }
  setMeta(key: string, value: string): Promise<void> {
    return this.stub.setMeta(key, value);
  }
  findLatestReplyTip(replyToId: number): Promise<number> {
    return this.stub.findLatestReplyTip(replyToId);
  }
  getAttachment(fileId: number): Promise<AttachmentRow | null> {
    return this.stub.getAttachment(fileId);
  }
  listAttachmentsForMessage(messageId: number): Promise<AttachmentRow[]> {
    return this.stub.listAttachmentsForMessage(messageId);
  }
  upsertAttachmentForMessage(input: UpsertAttachmentInput): Promise<void> {
    return this.stub.upsertAttachmentForMessage(input);
  }
  markAttachmentDownloaded(fileId: number, path: string): Promise<void> {
    return this.stub.markAttachmentDownloaded(fileId, path);
  }
}

/**
 * Build a {@link CacheStore} backed by the operator's durable cache DO. Keyed by
 * `idFromName(operatorUsername)` so every one of that user's sessions shares one
 * persistent cache.
 */
export function makeDurableCacheStore(
  namespace: DurableObjectNamespace<OFWCacheDO> | undefined,
  operatorUsername: string | undefined,
): CacheStore {
  // Fail loudly and specifically instead of letting an `undefined` binding
  // surface later as an opaque "Cannot read properties of undefined" TypeError.
  if (!namespace) {
    throw createHelpfulError('The OFW message cache storage binding (CACHE_DO) is not available on this deployment.', {
      hint: 'Declare the CACHE_DO Durable Object binding and its migration in wrangler.jsonc, then redeploy (npm run worker:deploy). Non-cache tools do not need it.',
    });
  }
  if (!operatorUsername) {
    throw createHelpfulError('Cannot open the OFW message cache: no authenticated OFW username on the session.', {
      hint: 'Re-authenticate with the connector so the cache can be scoped to your account.',
    });
  }
  const id = namespace.idFromName(operatorUsername.toLowerCase());
  return new DurableCacheStore(namespace.get(id));
}

/**
 * Build the cache-store provider the Worker hands to `registerMessageTools` /
 * `syncAll`. Deferred (built per tool call) so a missing binding surfaces as a
 * clear error on a cache tool rather than breaking client construction / the
 * non-cache API tools.
 */
export function durableCacheProvider(
  namespace: DurableObjectNamespace<OFWCacheDO> | undefined,
  operatorUsername: string | undefined,
): () => CacheStore {
  return () => makeDurableCacheStore(namespace, operatorUsername);
}
