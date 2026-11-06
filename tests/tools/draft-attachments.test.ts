// OFW drafts cannot hold attachments (verified live 2026-11-06: a draft saved
// with PRIVATE or SHARED fileIds — by create OR by the web app's in-place
// update — always comes back `files: []`, and the web app's compose screen
// never loads files from a draft). So attachments are HELD against the draft
// in the local cache and attached at send, uploaded/re-shared as SHARED the
// way the web app attaches every message file. The fake OFW below reproduces
// exactly that: drafts drop files; a send keeps only SHARED ones.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { OFWClient } from '../../src/client.js';
import { registerMessageTools } from '../../src/tools/messages.js';
import { NodeAttachmentIO } from '../../src/tools/attachments.js';
import { OFWCache } from '../../src/cache/node.js';
import type { CacheStore } from '../../src/cache/store.js';
import { draftRevision } from '../../src/tools/draft-freshness.js';
import { getHeldFiles } from '../../src/tools/held-attachments.js';
import * as syncModule from '../../src/sync.js';
import { NO_ELICIT_CTX, callConfirmed, callPreview } from './_confirm-helpers.js';

type Handler = (args: Record<string, unknown>, ctx?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const b64 = (b: Buffer) => b.toString('base64');
const COPARENT = 2000002;

let handlers: Map<string, Handler>;
let cache: OFWCache;
let tmpDir: string;

interface File { fileId: number; fileName: string; shareClass: 'PRIVATE' | 'SHARED'; bytes: Buffer }
interface Fake {
  client: OFWClient;
  calls: Array<{ method: string; path: string; body: unknown }>;
  files: Map<number, File>;
  messages: Map<number, Record<string, unknown>>;
  /** Simulate OFW silently dropping a file from a SENT message too. */
  dropOnSend?: Set<number>;
}

function fakeOfw(): Fake {
  const client = new OFWClient();
  const f: Fake = { client, calls: [], files: new Map(), messages: new Map() };
  let nextFile = 600;
  let nextMsg = 574600000;
  vi.spyOn(client, 'request').mockImplementation(async (method: string, path: string, body?: unknown) => {
    f.calls.push({ method, path, body });
    if (method === 'POST' && path === '/pub/v3/myfiles/multipart') {
      const form = body as FormData;
      const blob = form.get('file') as Blob;
      const file: File = {
        fileId: nextFile++, fileName: String(form.get('fileName')),
        shareClass: String(form.get('shareClass')) as File['shareClass'], bytes: Buffer.from(await blob.arrayBuffer()),
      };
      f.files.set(file.fileId, file);
      return { fileId: file.fileId, fileName: file.fileName, fileType: blob.type, sizeInBytes: file.bytes.length, shareClass: file.shareClass };
    }
    if (method === 'POST' && path === '/pub/v3/messages') {
      const p = body as { subject: string; body: string; draft: boolean; recipientIds: number[]; replyToId: number | null; attachments: { myFileIDs: number[] } };
      const id = nextMsg++;
      // The live behaviour: drafts never keep files; a send keeps SHARED ones.
      const kept = p.draft ? [] : p.attachments.myFileIDs.filter((fid) => f.files.get(fid)?.shareClass === 'SHARED' && !f.dropOnSend?.has(fid));
      f.messages.set(id, {
        id, subject: p.subject, body: p.body, files: kept, replyToId: p.replyToId,
        recipients: p.recipientIds.map((userId) => ({ user: { userId, name: 'Pat Doe' } })),
        folder: { id: p.draft ? 13471259 : 2, name: p.draft ? 'Drafts' : 'Sent' },
        date: { dateTime: '2026-11-06T11:20:03' },
      });
      return { entityId: id };
    }
    const detail = /^\/pub\/v3\/messages\/(\d+)$/.exec(path);
    if (method === 'GET' && detail) {
      const m = f.messages.get(Number(detail[1]));
      if (!m) throw new Error('OFW API error: 404 Not Found');
      return m;
    }
    if (method === 'DELETE' && path === '/pub/v1/messages') {
      for (const id of (body as FormData).getAll('messageIds')) f.messages.delete(Number(id));
      return {};
    }
    const meta = /^\/pub\/v1\/myfiles\/(\d+)$/.exec(path);
    if (method === 'GET' && meta) {
      const file = f.files.get(Number(meta[1]));
      return { fileId: Number(meta[1]), fileName: file?.fileName ?? 'x.jpg', fileType: 'image/jpeg', sizeInBytes: 8, shareClass: file?.shareClass };
    }
    throw new Error(`fake OFW: unexpected ${method} ${path}`);
  });
  vi.spyOn(client, 'requestBinary').mockImplementation(async (_m: string, path: string) => {
    const id = Number(/myfiles\/(\d+)\/data/.exec(path)![1]);
    const file = f.files.get(id)!;
    return { body: file.bytes, contentType: 'image/jpeg', suggestedFileName: file.fileName } as never;
  });
  return f;
}

/** A PRIVATE file that already exists in My Files and is known to the cache — like the user's four photos. */
async function seedPrivateFile(f: Fake, fileId: number, fileName: string): Promise<void> {
  f.files.set(fileId, { fileId, fileName, shareClass: 'PRIVATE', bytes: JPEG });
  await cache.upsertAttachmentForMessage({
    fileId, fileName, label: fileName, mimeType: 'image/jpeg', sizeBytes: JPEG.length,
    metadata: { fileId, fileName, shareClass: 'PRIVATE' }, messageId: 0,
  });
}

function setup(client: OFWClient): void {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  handlers = new Map();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _c: unknown, cb: unknown) => {
    handlers.set(name, cb as Handler);
    return undefined as never;
  });
  registerMessageTools(server, client, (): CacheStore => cache, new NodeAttachmentIO());
}

const parse = (text: string): Record<string, any> => {
  const at = text.lastIndexOf('\n\n{');
  return JSON.parse(at === -1 ? text : text.slice(at + 2)) as Record<string, any>;
};
const call = async (tool: string, args: Record<string, unknown>) => {
  const res = await handlers.get(tool)!(args, NO_ELICIT_CTX);
  return { res, text: res.content[0].text, body: parse(res.content[0].text) };
};
const messagePosts = (f: Fake) => f.calls.filter((c) => c.method === 'POST' && c.path === '/pub/v3/messages')
  .map((c) => c.body as { draft: boolean; attachments: { myFileIDs: number[] } });

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ofw-draftatt-'));
  cache = OFWCache.open(':memory:');
  vi.stubEnv('OFW_ATTACHMENTS_DIR', tmpDir);
  vi.stubEnv('MCP_DATA_DIR', '');
  vi.stubEnv('MCP_BLOB_BASE_URL', '');
  vi.stubEnv('MCP_BLOB_SIGNING_KEY', '');
});

afterEach(() => {
  cache.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ofw_save_draft holds attachments OFW will not keep on a draft', () => {
  it('a new draft with myFileIDs holds them, says so plainly, and does not warn about a "drop"', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 501, 'think-sheet.jpg');
    await seedPrivateFile(f, 502, 'ot-notes.jpg');
    setup(f.client);
    const { text, body } = await call('ofw_save_draft', { subject: 's', body: 'b', myFileIDs: [501, 502] });
    expect(body.attachments).toMatchObject({
      held: [{ fileId: 501, fileName: 'think-sheet.jpg' }, { fileId: 502, fileName: 'ot-notes.jpg' }],
      onDraft: [],
    });
    expect(body.attachments.note).toMatch(/OurFamilyWizard drafts do not store attachments/);
    expect(body.attachments.note).toMatch(/ofw_send_message/);
    expect(text).not.toMatch(/were requested in myFileIDs but are not attached/);
    expect(await getHeldFiles(cache, body.id)).toEqual([501, 502]);
    // Posted anyway, so a draft that DID keep them would show them on OFW.
    expect(messagePosts(f)[0]!.attachments.myFileIDs).toEqual([501, 502]);
  });

  it('replacing a draft carries its held files over and adds new ones, de-duplicated', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 1, 'a.jpg');
    await seedPrivateFile(f, 2, 'b.jpg');
    setup(f.client);
    const first = (await call('ofw_save_draft', { subject: 's', body: 'v1', myFileIDs: [1] })).body;
    const second = await call('ofw_save_draft', {
      subject: 's', body: 'v2', messageId: first.id, myFileIDs: [1, 2],
      inlineAttachments: [{ filename: 'c.jpg', contentBase64: b64(JPEG) }],
    });
    const uploaded = second.body.attachmentsUploaded[0].fileId as number;
    expect(second.body.attachments.held.map((h: { fileId: number }) => h.fileId)).toEqual([1, 2, uploaded]);
    expect(await getHeldFiles(cache, second.body.id)).toEqual([1, 2, uploaded]);
    expect(await getHeldFiles(cache, first.id)).toEqual([]); // moved, not copied
    // An edit that names no files keeps them all.
    const third = await call('ofw_save_draft', { subject: 's', body: 'v3', messageId: second.body.id });
    expect(third.body.attachments.held).toHaveLength(3);
  });

  it('removeFileIDs drops a held file', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 1, 'a.jpg');
    await seedPrivateFile(f, 2, 'b.jpg');
    setup(f.client);
    const first = (await call('ofw_save_draft', { subject: 's', body: 'v1', myFileIDs: [1, 2] })).body;
    const second = (await call('ofw_save_draft', { subject: 's', body: 'v1', messageId: first.id, removeFileIDs: [1] })).body;
    expect(second.attachments.held.map((h: { fileId: number }) => h.fileId)).toEqual([2]);
  });

  it('the replace NOTE reports what is actually on the draft and what is held — not what was requested', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 1, 'a.jpg');
    setup(f.client);
    const first = (await call('ofw_save_draft', { subject: 's', body: 'v1' })).body;
    const { text } = await call('ofw_save_draft', { subject: 's', body: 'v2', messageId: first.id, myFileIDs: [1] });
    expect(text).toMatch(/attachments: 0 on the draft, 1 held for send/);
    expect(text).not.toMatch(/attachments \(1\)/);
  });

  it('revision changes when ONLY the attachments change, and the new token is accepted on the next edit', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 1, 'a.jpg');
    setup(f.client);
    const first = (await call('ofw_save_draft', { subject: 's', body: 'same' })).body;
    const second = (await call('ofw_save_draft', { subject: 's', body: 'same', messageId: first.id, expectedRevision: first.revision, myFileIDs: [1] })).body;
    expect(second.revision).not.toBe(first.revision);
    expect(second.revision).toBe(draftRevision({ subject: 's', body: 'same', recipients: [], replyToId: null }, [1]));
    // The token it returned is the one the guard accepts next time …
    const third = await call('ofw_save_draft', { subject: 's', body: 'same 2', messageId: second.id, expectedRevision: second.revision });
    expect(third.res.isError).toBeFalsy();
    // … and reads report the same revision.
    const read = parse((await handlers.get('ofw_get_message')!({ messageId: String(third.body.id) })).content[0].text);
    expect(read.revision).toBe(third.body.revision);
    expect(read.attachments).toEqual([expect.objectContaining({ fileId: 1, held: true })]);
  });

  it('a token minted before any files were held is still accepted (no false STALE)', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 1, 'a.jpg');
    setup(f.client);
    const first = (await call('ofw_save_draft', { subject: 's', body: 'b', myFileIDs: [1] })).body;
    const plain = draftRevision({ subject: 's', body: 'b', recipients: [], replyToId: null });
    const res = await call('ofw_save_draft', { subject: 's', body: 'b2', messageId: first.id, expectedRevision: plain });
    expect(res.res.isError).toBeFalsy();
  });

  it('ofw_delete_draft forgets the held files', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 1, 'a.jpg');
    setup(f.client);
    const d = (await call('ofw_save_draft', { subject: 's', body: 'b', myFileIDs: [1] })).body;
    await call('ofw_delete_draft', { messageId: d.id, expectedRevision: d.revision });
    expect(await getHeldFiles(cache, d.id)).toEqual([]);
  });
});

describe('ofw_send_message attaches held and new files as SHARED, and verifies them', () => {
  it('sending a draft attaches its held files, re-sharing PRIVATE ones as SHARED only after approval', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 501, 'think-sheet.jpg');
    setup(f.client);
    const draft = (await call('ofw_save_draft', { subject: 'Weekly', body: 'b', recipientIds: [COPARENT], myFileIDs: [501] })).body;
    const args = { draftId: draft.id, recipientIds: [COPARENT], expectedRevision: draft.revision };
    const preview = await callPreview(handlers.get('ofw_send_message')!, args);
    expect(JSON.stringify(preview.preview)).toContain('think-sheet.jpg');
    expect(JSON.stringify(preview.preview)).toMatch(/re-shared as SHARED/);
    expect(f.calls.some((c) => c.path === '/pub/v3/myfiles/multipart')).toBe(false); // nothing re-shared by a preview
    const res = await callConfirmed(handlers.get('ofw_send_message')!, args);
    const sent = parse(res.content[0].text);
    const reshared = [...f.files.values()].find((x) => x.shareClass === 'SHARED')!;
    expect(reshared).toMatchObject({ fileName: 'think-sheet.jpg' });
    expect(reshared.bytes).toEqual(JPEG);
    const sendPost = messagePosts(f).find((p) => !p.draft)!;
    expect(sendPost.attachments.myFileIDs).toEqual([reshared.fileId]);
    expect(sent.attachments).toMatchObject({ verified: true, onMessage: [reshared.fileId] });
    expect(sent.attachments.reshared).toEqual([{ from: 501, to: reshared.fileId, fileName: 'think-sheet.jpg' }]);
    expect(await getHeldFiles(cache, draft.id)).toEqual([]);
  });

  it('composing with myFileIDs and inlineAttachments: new files upload SHARED, existing SHARED ones pass through', async () => {
    const f = fakeOfw();
    f.files.set(500, { fileId: 500, fileName: 'shared.pdf', shareClass: 'SHARED', bytes: JPEG });
    await cache.upsertAttachmentForMessage({ fileId: 500, fileName: 'shared.pdf', label: 'shared.pdf', mimeType: 'application/pdf', sizeBytes: 8, metadata: { shareClass: 'SHARED' }, messageId: 0 });
    setup(f.client);
    const res = await callConfirmed(handlers.get('ofw_send_message')!, {
      subject: 's', body: 'b', recipientIds: [COPARENT], myFileIDs: [500],
      inlineAttachments: [{ filename: 'new.jpg', contentBase64: b64(JPEG) }],
    });
    const sent = parse(res.content[0].text);
    const uploaded = [...f.files.values()].find((x) => x.fileName === 'new.jpg')!;
    expect(uploaded.shareClass).toBe('SHARED');
    expect(messagePosts(f)[0]!.attachments.myFileIDs).toEqual([500, uploaded.fileId]);
    expect(sent.attachments).toMatchObject({ verified: true, onMessage: [500, uploaded.fileId] });
  });

  it('a file OFW drops from the SENT message is reported loudly, not silently', async () => {
    const f = fakeOfw();
    f.files.set(500, { fileId: 500, fileName: 'x.pdf', shareClass: 'SHARED', bytes: JPEG });
    f.dropOnSend = new Set([500]);
    setup(f.client);
    const res = await callConfirmed(handlers.get('ofw_send_message')!, { subject: 's', body: 'b', recipientIds: [COPARENT], myFileIDs: [500] });
    const text = res.content[0].text;
    const sent = parse(text);
    expect(sent.attachments).toMatchObject({ verified: false, missing: [500] });
    expect(text).toMatch(/WARNING: the message was SENT, but OurFamilyWizard did not attach fileId\(s\) 500/);
  });

  it('a file whose share class is unknown is passed through untouched (no guessing, no extra requests)', async () => {
    const f = fakeOfw();
    f.files.set(900, { fileId: 900, fileName: 'y.jpg', shareClass: 'SHARED', bytes: JPEG });
    setup(f.client);
    await callConfirmed(handlers.get('ofw_send_message')!, { subject: 's', body: 'b', recipientIds: [COPARENT], myFileIDs: [900] });
    expect(f.calls.filter((c) => c.path === '/pub/v3/myfiles/multipart')).toHaveLength(0);
    expect(messagePosts(f)[0]!.attachments.myFileIDs).toEqual([900]);
  });
});

describe('held files — edges', () => {
  it('a corrupt held-files record reads as none rather than throwing', async () => {
    await cache.setMeta('draft_held_files:1', 'not json');
    await cache.setMeta('draft_held_files:2', '{"a":1}');
    await cache.setMeta('draft_held_files:3', '[1,"x",2.5,3]');
    expect(await getHeldFiles(cache, 1)).toEqual([]);
    expect(await getHeldFiles(cache, 2)).toEqual([]);
    expect(await getHeldFiles(cache, 3)).toEqual([1, 3]);
  });

  it('ofw_list_drafts and ofw_status carry heldFiles and the held-aware revision', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 1, 'a.jpg');
    setup(f.client);
    const d = (await call('ofw_save_draft', { subject: 's', body: 'b', myFileIDs: [1] })).body;
    await call('ofw_save_draft', { subject: 'other', body: 'b' });
    const list = (await call('ofw_list_drafts', { verify: false })).body;
    const row = list.drafts.find((x: { id: number }) => x.id === d.id);
    expect(row).toMatchObject({ heldFiles: [1], revision: d.revision });
    expect(list.drafts.find((x: { id: number }) => x.id !== d.id).heldFiles).toBeUndefined();
    vi.spyOn(syncModule, 'syncAll').mockResolvedValue({ refreshed: ['drafts'], notRefreshed: [], syncComplete: true } as never);
    const status = (await call('ofw_status', {})).body;
    const sRow = status.drafts.find((x: { id: number }) => x.id === d.id);
    expect(sRow).toMatchObject({ heldFiles: [1], revision: d.revision });
    expect(status.drafts.find((x: { id: number }) => x.id !== d.id).heldFiles).toBeUndefined();
  });

  it('a re-share that fails part-way sends nothing and names what was already re-shared', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 1, 'a.jpg');
    await seedPrivateFile(f, 2, 'b.jpg');
    setup(f.client);
    const binary = vi.spyOn(f.client, 'requestBinary');
    binary.mockResolvedValueOnce({ body: JPEG } as never); // no content type: falls back to the cached one
    binary.mockRejectedValueOnce(new Error('OFW API error: 500'));
    const handler = handlers.get('ofw_send_message')!;
    const args = { subject: 's', body: 'b', recipientIds: [COPARENT], myFileIDs: [1, 2] };
    const { confirmToken } = await callPreview(handler, args);
    const err = await handler({ ...args, confirmToken }, NO_ELICIT_CTX).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/b\.jpg \(fileId 2\) could not be re-shared as SHARED: OFW API error: 500\. Nothing was sent\./);
    expect((err as Error).message).toMatch(/Already re-shared: a\.jpg \(fileId 1 → \d+\)/);
    expect(messagePosts(f).some((p) => !p.draft)).toBe(false);
    expect([...f.files.values()].find((x) => x.shareClass === 'SHARED')!.fileName).toBe('a.jpg');
  });

  it('a first re-share failure says so without an "already re-shared" list', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 1, 'a.jpg');
    setup(f.client);
    vi.spyOn(f.client, 'requestBinary').mockRejectedValueOnce(new Error('boom'));
    const handler = handlers.get('ofw_send_message')!;
    const args = { subject: 's', body: 'b', recipientIds: [COPARENT], myFileIDs: [1] };
    const { confirmToken } = await callPreview(handler, args);
    const err = await handler({ ...args, confirmToken }, NO_ELICIT_CTX).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/could not be re-shared as SHARED: boom\. Nothing was sent\.$/);
  });
});

describe('auto-review #421 follow-ups', () => {
  it('a re-share followed by a failed upload names the SHARED copies, and a retry reuses them instead of duplicating', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 1, 'a.jpg');
    setup(f.client);
    const handler = handlers.get('ofw_send_message')!;
    const args = {
      subject: 's', body: 'b', recipientIds: [COPARENT], myFileIDs: [1],
      inlineAttachments: [{ filename: 'bad.jpg', contentBase64: b64(JPEG) }],
    };
    const multipart = () => f.calls.filter((c) => c.path === '/pub/v3/myfiles/multipart').length;
    // Fail the NEW upload (the second multipart POST), after the re-share succeeded.
    const real = (f.client.request as unknown as { getMockImplementation: () => (...a: unknown[]) => Promise<unknown> }).getMockImplementation();
    let posts = 0;
    vi.mocked(f.client.request).mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (path === '/pub/v3/myfiles/multipart' && ++posts === 2) {
        f.calls.push({ method, path, body });
        throw new Error('OFW API error: 500');
      }
      return real(method, path, body);
    });
    const { confirmToken } = await callPreview(handler, args);
    const err = await handler({ ...args, confirmToken }, NO_ELICIT_CTX).catch((e: Error) => e);
    const shared = [...f.files.values()].find((x) => x.shareClass === 'SHARED')!;
    expect((err as Error).message).toMatch(/Nothing was sent/);
    expect((err as Error).message).toMatch(new RegExp(`re-shared as SHARED: a\\.jpg \\(fileId 1 → ${shared.fileId}\\)`));
    expect((err as Error).message).toMatch(/Already uploaded to My Files \(SHARED\)|could not be uploaded/);
    expect(multipart()).toBe(2);

    // Retry with the same ids: the existing SHARED copy is reused, not re-uploaded.
    vi.mocked(f.client.request).mockImplementation(real as never);
    const retry = { subject: 's', body: 'b', recipientIds: [COPARENT], myFileIDs: [1] };
    const res = await callConfirmed(handler, retry);
    const sent = parse(res.content[0].text);
    expect(multipart()).toBe(2);
    expect(messagePosts(f).find((p) => !p.draft)!.attachments.myFileIDs).toEqual([shared.fileId]);
    expect(sent.attachments.reshared).toEqual([{ from: 1, to: shared.fileId, fileName: 'a.jpg', reused: true }]);
  });

  it('a send that fails without a definitive answer reports the re-shared copies', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 1, 'a.jpg');
    setup(f.client);
    const real = (f.client.request as unknown as { getMockImplementation: () => (...a: unknown[]) => Promise<unknown> }).getMockImplementation();
    vi.mocked(f.client.request).mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && path === '/pub/v3/messages') throw new Error('socket hang up');
      return real(method, path, body);
    });
    const res = await callConfirmed(handlers.get('ofw_send_message')!, { subject: 's', body: 'b', recipientIds: [COPARENT], myFileIDs: [1] });
    const out = parse(res.content[0].text);
    const shared = [...f.files.values()].find((x) => x.shareClass === 'SHARED')!;
    expect(out.result).toBe('SEND_UNCONFIRMED');
    expect(out.reshared).toEqual([{ from: 1, to: shared.fileId, fileName: 'a.jpg' }]);
  });

  it('a send rejected outright names the re-shared copies in its error', async () => {
    const f = fakeOfw();
    await seedPrivateFile(f, 1, 'a.jpg');
    setup(f.client);
    const real = (f.client.request as unknown as { getMockImplementation: () => (...a: unknown[]) => Promise<unknown> }).getMockImplementation();
    vi.mocked(f.client.request).mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && path === '/pub/v3/messages') throw new Error('OFW API error: 400 Bad Request');
      return real(method, path, body);
    });
    const handler = handlers.get('ofw_send_message')!;
    const args = { subject: 's', body: 'b', recipientIds: [COPARENT], myFileIDs: [1] };
    const { confirmToken } = await callPreview(handler, args);
    const err = await handler({ ...args, confirmToken }, NO_ELICIT_CTX).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/OFW API error: 400/);
    expect((err as Error).message).toMatch(/re-shared as SHARED: a\.jpg \(fileId 1 → \d+\)/);
  });
});
