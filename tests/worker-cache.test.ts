import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import type { MessageRow, DraftRow, SyncState } from '../src/cache/store.js';
import {
  makeDurableCacheStore,
  durableCacheProvider,
  type OFWCacheDO,
} from '../src/cache/durable.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { OFWClient } from '../src/client.js';
import type { AttachmentIO, ResolvedUpload } from '../src/tools/attachments.js';

// Exercises the OFW message-cache Durable Object backend inside the REAL
// Workers runtime (Miniflare via @cloudflare/vitest-pool-workers), against
// wrangler.jsonc's `CACHE_DO` binding. This is where the DO's SQLite storage
// adapter (src/cache/durable.ts → SqlStorageDriver → OFWCacheCore) is proven —
// the Node suite can't run `cloudflare:workers`.

// `env` is untyped in the pool; CACHE_DO is a real DurableObjectNamespace whose
// stub / store exposes OFWCacheCore's surface.
const CACHE = (env as unknown as { CACHE_DO: DurableObjectNamespace<OFWCacheDO> }).CACHE_DO;

const stubAttachmentIO: AttachmentIO = {
  supportsDisk: false,
  resolveUpload(): Promise<ResolvedUpload> {
    return Promise.reject(new Error('not used'));
  },
  readDownloaded(): Buffer | null {
    throw new Error('not used');
  },
  writeDownload(): void {
    throw new Error('not used');
  },
};

function msg(id: number, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    folder: 'inbox',
    subject: `Subject ${id}`,
    fromUser: 'Coparent A',
    sentAt: `2026-07-${String((id % 27) + 1).padStart(2, '0')}T12:00:00.000Z`,
    recipients: [{ userId: 99, name: 'Me', viewedAt: null }],
    body: `Body of message ${id}`,
    fetchedBodyAt: '2026-07-14T00:00:00.000Z',
    replyToId: null,
    chainRootId: null,
    listData: { files: 0 },
    ...over,
  };
}

function draft(id: number, over: Partial<DraftRow> = {}): DraftRow {
  return {
    id,
    subject: `Draft ${id}`,
    body: `Draft body ${id}`,
    recipients: [{ userId: 99, name: 'Me', viewedAt: null }],
    replyToId: null,
    modifiedAt: '2026-07-14T00:00:00.000Z',
    listData: null,
    ...over,
  };
}

describe('OFWCacheDO (Durable Object SQLite backend)', () => {
  it('round-trips messages, sync_state and drafts through the DurableCacheStore', async () => {
    // Drive the DO through the same CacheStore facade worker.ts hands the tools.
    const store = makeDurableCacheStore(CACHE, 'operator_roundtrip');

    // messages: upsert → get → list → count
    await store.upsertMessage(msg(11));
    await store.upsertMessage(msg(22, { folder: 'sent', subject: 'Sent one' }));
    await store.upsertMessage(msg(22, { folder: 'sent', subject: 'Sent one (edited)' })); // upsert overwrites

    const got = await store.getMessage(22);
    expect(got?.subject).toBe('Sent one (edited)');
    expect(got?.folder).toBe('sent');
    expect(got?.body).toBe('Body of message 22');

    expect(await store.getMessage(999)).toBeNull();

    const inbox = await store.listMessages({ folder: 'inbox', page: 1, size: 50 });
    expect(inbox.map((m) => m.id)).toEqual([11]);
    expect(await store.countMessages({})).toBe(2);
    expect(await store.countMessages({ folder: 'sent' })).toBe(1);

    // sync_state: set → get
    const state: SyncState = { lastSyncAt: '2026-07-14T09:00:00.000Z', newestId: 22, resumePage: 3 };
    await store.setSyncState('inbox', state);
    const readState = await store.getSyncState('inbox');
    expect(readState?.lastSyncAt).toBe('2026-07-14T09:00:00.000Z');
    expect(readState?.newestId).toBe(22);
    expect(readState?.resumePage).toBe(3); // resume cursor round-trips through the DO SQLite
    expect(await store.getSyncState('sent')).toBeNull();

    // drafts: upsert → get → list → delete
    await store.upsertDraft(draft(500));
    await store.upsertDraft(draft(501, { subject: 'Second draft' }));
    const d = await store.getDraft(500);
    expect(d?.subject).toBe('Draft 500');
    expect((await store.listDrafts({ page: 1, size: 50 })).map((x) => x.id).sort()).toEqual([500, 501]);
    expect(await store.listDraftIds()).toEqual(expect.arrayContaining([500, 501]));
    await store.deleteDraft(500);
    expect(await store.getDraft(500)).toBeNull();

    // meta: set → get
    await store.setMeta('drafts_folder_id', '4242');
    expect(await store.getMeta('drafts_folder_id')).toBe('4242');
  });

  it('round-trips batch message + draft upserts and reads through the DO', async () => {
    const store = makeDurableCacheStore(CACHE, 'operator_batch');

    // Empty batches are no-ops across the RPC boundary.
    await store.upsertMessages([]);
    await store.upsertDrafts([]);
    expect(await store.getMessages([])).toEqual([]);
    expect(await store.getDrafts([])).toEqual([]);

    // Batch write one RPC per collection, then batch read (partial hit).
    await store.upsertMessages([msg(6001), msg(6002, { subject: 'Batched sent', folder: 'sent' })]);
    const gotMsgs = await store.getMessages([6001, 9999, 6002]);
    expect(gotMsgs.map((m) => m.id).sort()).toEqual([6001, 6002]);
    expect(gotMsgs.find((m) => m.id === 6002)?.subject).toBe('Batched sent');

    await store.upsertDrafts([draft(6100), draft(6101, { subject: 'Batched draft' })]);
    const gotDrafts = await store.getDrafts([6100, 9999, 6101]);
    expect(gotDrafts.map((d) => d.id).sort()).toEqual([6100, 6101]);
    expect(gotDrafts.find((d) => d.id === 6101)?.subject).toBe('Batched draft');
  });

  it('keeps each operator’s cache isolated in its own DO', async () => {
    const a = makeDurableCacheStore(CACHE, 'operator_a');
    const b = makeDurableCacheStore(CACHE, 'operator_b');
    await a.upsertMessage(msg(700));
    expect(await a.countMessages({})).toBe(1);
    // A different operator's DO is a separate database — no cross-contamination.
    expect(await b.countMessages({})).toBe(0);
  });

  it('is keyed case-insensitively on the operator username', async () => {
    const lower = makeDurableCacheStore(CACHE, 'CaseUser');
    await lower.upsertMessage(msg(800));
    const upper = makeDurableCacheStore(CACHE, 'caseuser');
    expect(await upper.getMessage(800)).not.toBeNull();
  });
});

describe('worker cache wiring', () => {
  it('surfaces a clear error — not an undefined TypeError — when the binding is missing', () => {
    // The exact failure mode a stale bundle without the CACHE_DO binding hits:
    // it must read as "CACHE_DO", not "Cannot read properties of undefined".
    expect(() => makeDurableCacheStore(undefined, 'someone')).toThrowError(/CACHE_DO/);
  });

  it('surfaces a clear error when there is no authenticated username', () => {
    expect(() => makeDurableCacheStore(CACHE, undefined)).toThrowError(/username/i);
  });

  it('drives a message tool end-to-end through MCP against the real DO binding', async () => {
    // Mirrors how worker.ts wires the store: a provider built from env.CACHE_DO,
    // handed to registerMessageTools. Exercises env → provider → store → DO → tool.
    const provider = durableCacheProvider(CACHE, 'e2e_op');
    await provider().upsertMessage(msg(3001, { folder: 'sent', subject: 'End to end' }));

    const harness = await createTestHarness((server) =>
      registerMessageTools(server, new OFWClient(), provider, stubAttachmentIO),
    );
    try {
      const r = await harness.callTool('ofw_list_messages', { folderId: 'sent' });
      const text = (r as { content: { text: string }[] }).content[0].text;
      const out = JSON.parse(text);
      expect(JSON.stringify(out)).toContain('End to end');
    } finally {
      await harness.close();
    }
  });
});
