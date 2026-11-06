// Uploads from a caller that shares no filesystem with the server: inline
// base64, blob-store upload slots, the hosted `path` refusal, and attaching
// in one step from ofw_save_draft / ofw_send_message. Plus the hosted
// download link. OFW is a small routing fake (method + path), the blob store
// a fake behind a stubbed global fetch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { OFWClient } from '../../src/client.js';
import { registerMessageTools } from '../../src/tools/messages.js';
import { NodeAttachmentIO, MAX_UPLOAD_BYTES } from '../../src/tools/attachments.js';
import { MAX_INLINE_BYTES } from '../../src/tools/delivery.js';
import { OFWCache } from '../../src/cache/node.js';
import type { CacheStore } from '../../src/cache/store.js';
import { NO_ELICIT_CTX, callConfirmed, callPreview } from './_confirm-helpers.js';

type Handler = (args: Record<string, unknown>, ctx?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PDF = Buffer.from('%PDF-1.7\n%%EOF\n');
const b64 = (b: Buffer) => b.toString('base64');
const BLOB_BASE = 'https://host.example/b/reg_0123456789abcdef01234567';

let handlers: Map<string, Handler>;
let cache: OFWCache;
let tmpDir: string;

// ── A routing fake of the OFW endpoints these tools touch ────────────────
interface FakeOfw {
  client: OFWClient;
  calls: Array<{ method: string; path: string; body: unknown }>;
  uploads: Array<{ fileName: string; type: string; shareClass: string; bytes: Buffer }>;
  messages: Map<number, Record<string, unknown>>;
  failUploadOf?: string;
}

function fakeOfw(seed: Record<number, Record<string, unknown>> = {}): FakeOfw {
  const client = new OFWClient();
  const state: FakeOfw = { client, calls: [], uploads: [], messages: new Map(Object.entries(seed).map(([k, v]) => [Number(k), v])) };
  let nextFileId = 7000;
  let nextMessageId = 9000;
  vi.spyOn(client, 'request').mockImplementation(async (method: string, path: string, body?: unknown) => {
    state.calls.push({ method, path, body });
    if (method === 'POST' && path === '/pub/v3/myfiles/multipart') {
      const form = body as FormData;
      const file = form.get('file') as Blob;
      const fileName = String(form.get('fileName'));
      if (state.failUploadOf === fileName) throw new Error(`OFW refused ${fileName}`);
      const bytes = Buffer.from(await file.arrayBuffer());
      state.uploads.push({ fileName, type: file.type, shareClass: String(form.get('shareClass')), bytes });
      return { fileId: nextFileId++, fileName, label: form.get('label'), fileType: file.type, sizeInBytes: bytes.length, shareClass: form.get('shareClass') };
    }
    if (method === 'POST' && path === '/pub/v3/messages') {
      const p = body as { subject: string; body: string; draft: boolean; attachments: { myFileIDs: number[] }; recipientIds: number[]; replyToId: number | null };
      const id = nextMessageId++;
      state.messages.set(id, {
        id, subject: p.subject, body: p.body, files: p.attachments.myFileIDs,
        recipients: p.draft ? [] : p.recipientIds.map((userId) => ({ user: { userId, name: `User ${userId}` } })),
        replyToId: p.replyToId, date: { dateTime: '2026-11-06T09:00:00' },
      });
      return { entityId: id };
    }
    const detail = /^\/pub\/v3\/messages\/(\d+)$/.exec(path);
    if (method === 'GET' && detail) {
      const m = state.messages.get(Number(detail[1]));
      if (!m) throw Object.assign(new Error('Not Found'), { status: 404 });
      return m;
    }
    if (method === 'DELETE' && path === '/pub/v1/messages') {
      for (const id of (body as FormData).getAll('messageIds')) state.messages.delete(Number(id));
      return {};
    }
    const meta = /^\/pub\/v1\/myfiles\/(\d+)$/.exec(path);
    if (method === 'GET' && meta) return { fileId: Number(meta[1]), fileName: `file-${meta[1]}.jpg`, fileType: 'image/jpeg', sizeInBytes: 8 };
    throw new Error(`fake OFW: unexpected ${method} ${path}`);
  });
  return state;
}

// ── A fake mcp-host blob store behind global fetch ───────────────────────
interface FakeBlobs {
  objects: Map<string, { bytes: Buffer; type: string }>;
  calls: Array<{ method: string; key: string }>;
  failDelete?: boolean;
}

function fakeBlobs(): FakeBlobs {
  vi.stubEnv('MCP_BLOB_BASE_URL', BLOB_BASE);
  vi.stubEnv('MCP_BLOB_SIGNING_KEY', 'a2V5');
  const state: FakeBlobs = { objects: new Map(), calls: [] };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.replace('/b/reg_0123456789abcdef01234567/', ''));
    const method = init?.method ?? 'GET';
    state.calls.push({ method, key });
    if (method === 'PUT') {
      state.objects.set(key, { bytes: Buffer.from(init!.body as ArrayBuffer), type: new Headers(init!.headers).get('content-type')! });
      return new Response(null, { status: 201 });
    }
    if (method === 'DELETE') {
      if (state.failDelete) return new Response('boom', { status: 500 });
      state.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const obj = state.objects.get(key);
    if (!obj) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(new Uint8Array(obj.bytes), { status: 200, headers: { 'content-type': obj.type } });
  }));
  return state;
}

/** What the caller's curl would do: PUT the bytes into the slot. */
function putIntoSlot(blobs: FakeBlobs, slot: { blobKey: string; mimeType: string }, bytes: Buffer): void {
  blobs.objects.set(slot.blobKey, { bytes, type: slot.mimeType });
}

function setup(client: OFWClient, io = new NodeAttachmentIO()): void {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  handlers = new Map();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _c: unknown, cb: unknown) => {
    handlers.set(name, cb as Handler);
    return undefined as never;
  });
  registerMessageTools(server, client, (): CacheStore => cache, io);
}

const call = async (tool: string, args: Record<string, unknown>) => {
  const res = await handlers.get(tool)!(args, NO_ELICIT_CTX);
  // A noted response (ofw_save_draft's replace NOTE) puts its notes first and
  // the minified JSON last.
  const text = res.content[0].text;
  const at = text.lastIndexOf('\n\n{');
  return { res, body: JSON.parse(at === -1 ? text : text.slice(at + 2)) as Record<string, any> };
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ofw-upload-'));
  cache = OFWCache.open(':memory:');
  vi.stubEnv('OFW_ATTACHMENTS_DIR', tmpDir);
  vi.stubEnv('OFW_UPLOAD_DIR', '');
  vi.stubEnv('MCP_DATA_DIR', '');
  vi.stubEnv('MCP_BLOB_BASE_URL', '');
  vi.stubEnv('MCP_BLOB_SIGNING_KEY', '');
});

afterEach(() => {
  cache.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ofw_upload_attachment — inline bytes', () => {
  it('uploads a JPEG through the same My Files POST as path, PRIVATE by default', async () => {
    const ofw = fakeOfw();
    setup(ofw.client);
    const { body } = await call('ofw_upload_attachment', {
      inline: { filename: 'Sam_Think_Sheet_2026-11-03.jpg', contentBase64: b64(JPEG) },
      label: 'Sam Think Sheet 11-3-26',
    });
    expect(ofw.uploads).toHaveLength(1);
    expect(ofw.uploads[0]).toMatchObject({ fileName: 'Sam_Think_Sheet_2026-11-03.jpg', type: 'image/jpeg', shareClass: 'PRIVATE' });
    expect(ofw.uploads[0]!.bytes).toEqual(JPEG);
    const form = ofw.calls[0]!.body as FormData;
    expect(form.get('label')).toBe('Sam Think Sheet 11-3-26');
    expect(form.get('source')).toBe('message');
    expect(body).toMatchObject({
      fileId: 7000, fileName: 'Sam_Think_Sheet_2026-11-03.jpg', mimeType: 'image/jpeg',
      bytes: JPEG.length, shareClass: 'PRIVATE',
    });
    // Cached like a path upload, so a later download can short-circuit.
    expect((await cache.getAttachment(7000))?.fileName).toBe('Sam_Think_Sheet_2026-11-03.jpg');
  });

  it('uploads a PDF, honouring an explicit mimeType', async () => {
    const ofw = fakeOfw();
    setup(ofw.client);
    const { body } = await call('ofw_upload_attachment', {
      inline: { filename: 'report', contentBase64: b64(PDF), mimeType: 'application/pdf' },
    });
    expect(ofw.uploads[0]!.type).toBe('application/pdf');
    expect(body.mimeType).toBe('application/pdf');
  });

  it('refuses bad base64, an empty file, an over-size file and a path-like filename without uploading', async () => {
    const ofw = fakeOfw();
    setup(ofw.client);
    const up = handlers.get('ofw_upload_attachment')!;
    await expect(up({ inline: { filename: 'a.jpg', contentBase64: 'abc' } })).rejects.toThrow(/not valid base64/);
    await expect(up({ inline: { filename: 'a.jpg', contentBase64: '' } })).rejects.toThrow(/empty/);
    const huge = 'A'.repeat(Math.ceil((MAX_UPLOAD_BYTES + 3) / 3) * 4);
    await expect(up({ inline: { filename: 'a.jpg', contentBase64: huge } })).rejects.toThrow(/25 MiB/);
    await expect(up({ inline: { filename: '../a.jpg', contentBase64: b64(JPEG) } })).rejects.toThrow(/bare filename/);
    await expect(up({ inline: { filename: '.secret', contentBase64: b64(JPEG) } })).rejects.toThrow(/dot/);
    expect(ofw.uploads).toHaveLength(0);
  });

  it('requires exactly one source', async () => {
    const ofw = fakeOfw();
    setup(ofw.client);
    const up = handlers.get('ofw_upload_attachment')!;
    await expect(up({})).rejects.toThrow(/exactly one of path, inline, uploadSlots or blobKeys/);
    await expect(up({ path: 'a.jpg', inline: { filename: 'a.jpg', contentBase64: b64(JPEG) } }))
      .rejects.toThrow(/exactly one of path, inline, uploadSlots or blobKeys/);
    expect(ofw.calls).toHaveLength(0);
  });

  it('a batch returns per-file results in order and does not let one failure sink the rest', async () => {
    const ofw = fakeOfw();
    ofw.failUploadOf = 'c.jpg';
    setup(ofw.client);
    const { res, body } = await call('ofw_upload_attachment', {
      inline: [
        { filename: 'a.jpg', contentBase64: b64(JPEG) },
        { filename: 'b.jpg', contentBase64: 'not base64!' },
        { filename: 'c.jpg', contentBase64: b64(JPEG) },
        { filename: 'd.pdf', contentBase64: b64(PDF) },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(body).toMatchObject({ uploaded: 2, failed: 2, fileIds: [7000, 7001] });
    expect(body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, false, false, true]);
    expect(body.results[0]).toMatchObject({ index: 0, ok: true, fileId: 7000, fileName: 'a.jpg' });
    expect(body.results[1]).toMatchObject({ index: 1, ok: false, filename: 'b.jpg' });
    expect(body.results[1].error).toMatch(/not valid base64/);
    expect(body.results[2].error).toMatch(/OFW refused c\.jpg/);
    expect(body.results[3]).toMatchObject({ ok: true, fileId: 7001, mimeType: 'application/pdf' });
  });

  it('a batch where every file fails is an error result', async () => {
    const ofw = fakeOfw();
    setup(ofw.client);
    const { res, body } = await call('ofw_upload_attachment', { inline: [{ filename: 'a.jpg', contentBase64: '!!' }] });
    expect(res.isError).toBe(true);
    expect(body).toMatchObject({ uploaded: 0, failed: 1 });
  });

  it('refuses more than 10 files in one call', async () => {
    setup(fakeOfw().client);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ filename: `p${i}.jpg`, contentBase64: b64(JPEG) }));
    await expect(handlers.get('ofw_upload_attachment')!({ inline: eleven })).rejects.toThrow(/at most 10/);
  });

  it('SHARED inline keeps the confirmation flow: preview uploads nothing, the token uploads once', async () => {
    const ofw = fakeOfw();
    setup(ofw.client);
    const args = { inline: { filename: 'form.pdf', contentBase64: b64(PDF) }, shareClass: 'SHARED' };
    const preview = await callPreview(handlers.get('ofw_upload_attachment')!, args);
    expect(ofw.uploads).toHaveLength(0);
    expect(preview.preview).toMatchObject({ fileName: 'form.pdf', sizeBytes: PDF.length, shareClass: 'SHARED' });
    await callConfirmed(handlers.get('ofw_upload_attachment')!, args);
    expect(ofw.uploads).toHaveLength(1);
    expect(ofw.uploads[0]!.shareClass).toBe('SHARED');
  });

  it('SHARED as a one-file inline array is previewed like a single file', async () => {
    const ofw = fakeOfw();
    setup(ofw.client);
    const preview = await callPreview(handlers.get('ofw_upload_attachment')!, {
      inline: [{ filename: 'form.pdf', contentBase64: b64(PDF) }], shareClass: 'SHARED',
    });
    expect(preview.preview).toMatchObject({ fileName: 'form.pdf', shareClass: 'SHARED' });
    expect(ofw.uploads).toHaveLength(0);
  });

  it('SHARED is one file at a time', async () => {
    setup(fakeOfw().client);
    await expect(handlers.get('ofw_upload_attachment')!({
      inline: [{ filename: 'a.jpg', contentBase64: b64(JPEG) }, { filename: 'b.jpg', contentBase64: b64(JPEG) }],
      shareClass: 'SHARED',
    })).rejects.toThrow(/one file at a time/);
  });
});

describe('ofw_upload_attachment — blob upload slots', () => {
  it('mints signed PUT slots and touches neither OFW nor the store', async () => {
    const ofw = fakeOfw();
    const blobs = fakeBlobs();
    setup(ofw.client);
    const { body } = await call('ofw_upload_attachment', { uploadSlots: [{ filename: 'a.jpg' }, { filename: 'b.heic' }] });
    expect(ofw.calls).toHaveLength(0);
    expect(blobs.calls).toHaveLength(0);
    expect(body.slots).toHaveLength(2);
    expect(body.slots[0]).toMatchObject({ filename: 'a.jpg', mimeType: 'image/jpeg', method: 'PUT' });
    expect(body.slots[1].mimeType).toBe('image/heic');
    expect(body.slots[0].uploadUrl.startsWith(`${BLOB_BASE}/uploads/`)).toBe(true);
    expect(body.next).toMatch(/blobKeys/);
  });

  it('refuses slots on a deployment without a blob store, pointing at path or inline', async () => {
    setup(fakeOfw().client);
    await expect(handlers.get('ofw_upload_attachment')!({ uploadSlots: [{ filename: 'a.jpg' }] }))
      .rejects.toThrow(/no blob store.*path.*inline/s);
  });

  it('blobKeys: reads the PUT object, uploads it to OFW, then deletes it from the store', async () => {
    const ofw = fakeOfw();
    const blobs = fakeBlobs();
    setup(ofw.client);
    const { body: slots } = await call('ofw_upload_attachment', { uploadSlots: [{ filename: 'Sam Think Sheet.jpg' }] });
    const slot = slots.slots[0];
    putIntoSlot(blobs, slot, JPEG);
    const { body } = await call('ofw_upload_attachment', { blobKeys: [slot.blobKey], label: 'Think sheet' });
    expect(ofw.uploads[0]).toMatchObject({ fileName: 'Sam Think Sheet.jpg', type: 'image/jpeg', shareClass: 'PRIVATE' });
    expect(ofw.uploads[0]!.bytes).toEqual(JPEG);
    expect(body.results[0]).toMatchObject({ ok: true, fileId: 7000, fileName: 'Sam Think Sheet.jpg', bytes: JPEG.length, blobDeleted: true });
    expect(blobs.calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect(blobs.objects.has(slot.blobKey)).toBe(false);
  });

  it('keeps the blob when OFW refuses the upload, so the same key can be retried', async () => {
    const ofw = fakeOfw();
    ofw.failUploadOf = 'a.jpg';
    const blobs = fakeBlobs();
    setup(ofw.client);
    const slot = (await call('ofw_upload_attachment', { uploadSlots: [{ filename: 'a.jpg' }] })).body.slots[0];
    putIntoSlot(blobs, slot, JPEG);
    const { body } = await call('ofw_upload_attachment', { blobKeys: [slot.blobKey] });
    expect(body.results[0]).toMatchObject({ ok: false });
    expect(body.results[0].error).toMatch(/OFW refused/);
    expect(blobs.objects.has(slot.blobKey)).toBe(true);
  });

  it('reports a key that was never PUT (or already consumed) per file', async () => {
    const ofw = fakeOfw();
    const blobs = fakeBlobs();
    setup(ofw.client);
    const { body: s } = await call('ofw_upload_attachment', { uploadSlots: [{ filename: 'a.jpg' }, { filename: 'b.jpg' }] });
    putIntoSlot(blobs, s.slots[1], JPEG);
    const { body } = await call('ofw_upload_attachment', { blobKeys: [s.slots[0].blobKey, s.slots[1].blobKey] });
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toMatch(/not found/i);
    expect(body.results[1]).toMatchObject({ ok: true, blobDeleted: true });
  });

  it('a failed delete after a successful upload is a warning, not a failure', async () => {
    const ofw = fakeOfw();
    const blobs = fakeBlobs();
    blobs.failDelete = true;
    setup(ofw.client);
    const slot = (await call('ofw_upload_attachment', { uploadSlots: [{ filename: 'a.jpg' }] })).body.slots[0];
    putIntoSlot(blobs, slot, JPEG);
    const { body } = await call('ofw_upload_attachment', { blobKeys: [slot.blobKey] });
    expect(body.results[0]).toMatchObject({ ok: true, fileId: 7000, blobDeleted: false });
    expect(body.results[0].blobDeleteError).toMatch(/HTTP 500/);
  });

  it('refuses a key it did not mint', async () => {
    fakeBlobs();
    setup(fakeOfw().client);
    const { body } = await call('ofw_upload_attachment', { blobKeys: ['calendar/x/y.ics'] });
    expect(body.results[0].error).toMatch(/not an upload key/);
  });

  it('blobKeys without a blob store is refused', async () => {
    setup(fakeOfw().client);
    await expect(handlers.get('ofw_upload_attachment')!({ blobKeys: ['uploads/x/y'] })).rejects.toThrow(/no blob store/);
  });

  it('SHARED blob: the preview keeps the blob, the confirmed call uploads and deletes it', async () => {
    const ofw = fakeOfw();
    const blobs = fakeBlobs();
    setup(ofw.client);
    const slot = (await call('ofw_upload_attachment', { uploadSlots: [{ filename: 'form.pdf' }] })).body.slots[0];
    putIntoSlot(blobs, slot, PDF);
    const args = { blobKeys: [slot.blobKey], shareClass: 'SHARED' };
    const preview = await callPreview(handlers.get('ofw_upload_attachment')!, args);
    expect(preview.preview).toMatchObject({ fileName: 'form.pdf', shareClass: 'SHARED' });
    expect(blobs.objects.has(slot.blobKey)).toBe(true);
    expect(ofw.uploads).toHaveLength(0);
    await callConfirmed(handlers.get('ofw_upload_attachment')!, args);
    expect(ofw.uploads[0]!.shareClass).toBe('SHARED');
    expect(blobs.objects.has(slot.blobKey)).toBe(false);
  });
});

describe('ofw_upload_attachment — path mode', () => {
  it('passes through a filesystem error that is not a missing file', async () => {
    writeFileSync(join(tmpDir, 'a.jpg'), JPEG);
    setup(fakeOfw().client);
    await expect(handlers.get('ofw_upload_attachment')!({ path: 'a.jpg/inner.jpg' })).rejects.toThrow(/ENOTDIR/);
  });

  it('creates a missing upload directory (0700) instead of failing on lstat', async () => {
    const dir = join(tmpDir, 'not', 'yet', 'there');
    vi.stubEnv('OFW_UPLOAD_DIR', dir);
    setup(fakeOfw().client);
    await expect(handlers.get('ofw_upload_attachment')!({ path: 'photo.jpg' })).rejects.toThrow(/not found.*upload directory/i);
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('still uploads a file placed in the upload directory', async () => {
    writeFileSync(join(tmpDir, 'a.jpg'), JPEG);
    const ofw = fakeOfw();
    setup(ofw.client);
    const { body } = await call('ofw_upload_attachment', { path: 'a.jpg' });
    expect(body).toMatchObject({ fileId: 7000, bytes: JPEG.length });
  });

  it('on a hosted deployment refuses path with a plain explanation instead of ENOENT', async () => {
    vi.stubEnv('MCP_DATA_DIR', join(tmpDir, 'state'));
    const ofw = fakeOfw();
    setup(ofw.client);
    const err = await handlers.get('ofw_upload_attachment')!({ path: 'Sam_Think_Sheet_2026-11-03.jpg' }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/remote and can't read files on your machine/);
    expect((err as Error).message).toMatch(/inline/);
    expect((err as Error).message).not.toMatch(/ENOENT|lstat/);
    expect(existsSync(join(tmpDir, 'state'))).toBe(false);
    expect(ofw.calls).toHaveLength(0);
  });
});

describe('ofw_save_draft — attachments in one step', () => {
  it('uploads inlineAttachments PRIVATE first, then saves the draft with them alongside myFileIDs', async () => {
    const ofw = fakeOfw();
    setup(ofw.client);
    const { body } = await call('ofw_save_draft', {
      subject: 'Think sheet', body: 'See attached.', myFileIDs: [55],
      inlineAttachments: [{ filename: 'a.jpg', contentBase64: b64(JPEG) }, { filename: 'b.pdf', contentBase64: b64(PDF) }],
    });
    expect(ofw.uploads.map((u) => u.shareClass)).toEqual(['PRIVATE', 'PRIVATE']);
    const post = ofw.calls.find((c) => c.method === 'POST' && c.path === '/pub/v3/messages')!;
    expect((post.body as { attachments: { myFileIDs: number[] } }).attachments.myFileIDs).toEqual([55, 7000, 7001]);
    expect(body.attachmentsUploaded).toEqual([
      expect.objectContaining({ fileId: 7000, fileName: 'a.jpg' }),
      expect.objectContaining({ fileId: 7001, fileName: 'b.pdf' }),
    ]);
  });

  it('keeps attachments when the draft is edited, and uploads new ones on top', async () => {
    const ofw = fakeOfw();
    setup(ofw.client);
    const first = (await call('ofw_save_draft', {
      subject: 'Think sheet', body: 'v1', inlineAttachments: [{ filename: 'a.jpg', contentBase64: b64(JPEG) }],
    })).body;
    // Edit the text only: the server draft's file must come along.
    const second = await call('ofw_save_draft', { subject: 'Think sheet', body: 'v2', messageId: first.id });
    const posts = ofw.calls.filter((c) => c.method === 'POST' && c.path === '/pub/v3/messages');
    expect((posts[1]!.body as { attachments: { myFileIDs: number[] } }).attachments.myFileIDs).toEqual([7000]);
    expect(second.res.content[0].text).toMatch(/attachments: 1 on the draft, 0 held for send/);
    // Edit again, adding a photo: both are kept.
    await call('ofw_save_draft', {
      subject: 'Think sheet', body: 'v3', messageId: second.body.id,
      inlineAttachments: [{ filename: 'b.jpg', contentBase64: b64(JPEG) }],
    });
    const third = ofw.calls.filter((c) => c.method === 'POST' && c.path === '/pub/v3/messages')[2]!;
    expect((third.body as { attachments: { myFileIDs: number[] } }).attachments.myFileIDs).toEqual([7000, 7001]);
  });

  it('an explicit myFileIDs on edit adds to the held set rather than replacing it', async () => {
    const ofw = fakeOfw();
    setup(ofw.client);
    const first = (await call('ofw_save_draft', {
      subject: 's', body: 'v1', inlineAttachments: [{ filename: 'a.jpg', contentBase64: b64(JPEG) }],
    })).body;
    await call('ofw_save_draft', { subject: 's', body: 'v2', messageId: first.id, myFileIDs: [55] });
    const posts = ofw.calls.filter((c) => c.method === 'POST' && c.path === '/pub/v3/messages');
    expect((posts[1]!.body as { attachments: { myFileIDs: number[] } }).attachments.myFileIDs).toEqual([7000, 55]);
  });

  it('an invalid attachment fails the call before anything is uploaded or saved', async () => {
    const ofw = fakeOfw();
    setup(ofw.client);
    await expect(handlers.get('ofw_save_draft')!({
      subject: 's', body: 'b',
      inlineAttachments: [{ filename: 'a.jpg', contentBase64: b64(JPEG) }, { filename: 'b.jpg', contentBase64: 'abc' }],
    })).rejects.toThrow(/b\.jpg.*not valid base64/);
    expect(ofw.calls).toHaveLength(0);
  });

  it('an upload that fails part-way saves nothing and names the files already uploaded', async () => {
    const ofw = fakeOfw();
    ofw.failUploadOf = 'b.jpg';
    setup(ofw.client);
    const err = await handlers.get('ofw_save_draft')!({
      subject: 's', body: 'b',
      inlineAttachments: [{ filename: 'a.jpg', contentBase64: b64(JPEG) }, { filename: 'b.jpg', contentBase64: b64(JPEG) }],
    }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/b\.jpg/);
    expect((err as Error).message).toMatch(/a\.jpg \(fileId 7000\)/);
    expect((err as Error).message).toMatch(/myFileIDs/);
    expect(ofw.calls.some((c) => c.path === '/pub/v3/messages')).toBe(false);
  });

  it('attaches blobKeys and deletes each blob once uploaded', async () => {
    const ofw = fakeOfw();
    const blobs = fakeBlobs();
    setup(ofw.client);
    const slot = (await call('ofw_upload_attachment', { uploadSlots: [{ filename: 'a.jpg' }] })).body.slots[0];
    putIntoSlot(blobs, slot, JPEG);
    await call('ofw_save_draft', { subject: 's', body: 'b', blobKeys: [slot.blobKey] });
    const post = ofw.calls.find((c) => c.method === 'POST' && c.path === '/pub/v3/messages')!;
    expect((post.body as { attachments: { myFileIDs: number[] } }).attachments.myFileIDs).toEqual([7000]);
    expect(blobs.objects.has(slot.blobKey)).toBe(false);
  });
});

describe('ofw_send_message — attachments in one step', () => {
  it('previews the new files WITHOUT uploading, then uploads and sends on confirmation', async () => {
    const ofw = fakeOfw();
    setup(ofw.client);
    const args = {
      subject: 'Think sheet', body: 'Attached.', recipientIds: [2000001],
      inlineAttachments: [{ filename: 'Sam.jpg', contentBase64: b64(JPEG) }],
    };
    const preview = await callPreview(handlers.get('ofw_send_message')!, args);
    expect(ofw.calls).toHaveLength(0);
    expect(JSON.stringify(preview.preview)).toContain('Sam.jpg');
    await callConfirmed(handlers.get('ofw_send_message')!, args);
    expect(ofw.uploads).toHaveLength(1);
    // Uploaded PRIVATE: a send keeps PRIVATE files (verified live), so no
    // co-parent-visible copy is made before the message itself goes out.
    expect(ofw.uploads[0]!.shareClass).toBe('PRIVATE');
    const post = ofw.calls.find((c) => c.method === 'POST' && c.path === '/pub/v3/messages')!;
    expect((post.body as { draft: boolean; attachments: { myFileIDs: number[] } })).toMatchObject({ draft: false, attachments: { myFileIDs: [7000] } });
  });

  it('a blob attachment that changed after the preview is refused, and nothing is sent', async () => {
    const ofw = fakeOfw();
    const blobs = fakeBlobs();
    setup(ofw.client);
    const slot = (await call('ofw_upload_attachment', { uploadSlots: [{ filename: 'a.jpg' }] })).body.slots[0];
    putIntoSlot(blobs, slot, JPEG);
    const args = { subject: 's', body: 'b', recipientIds: [1], blobKeys: [slot.blobKey] };
    const { confirmToken } = await callPreview(handlers.get('ofw_send_message')!, args);
    expect(blobs.objects.has(slot.blobKey)).toBe(true);
    putIntoSlot(blobs, slot, Buffer.concat([JPEG, JPEG]));
    const { body } = await call('ofw_send_message', { ...args, confirmToken });
    expect(body).toMatchObject({ error: 'DRAFT_CHANGED', dispatched: false });
    expect(ofw.uploads).toHaveLength(0);
    expect(ofw.calls.some((c) => c.path === '/pub/v3/messages')).toBe(false);
  });

  it('a blob that cannot be deleted after the send is reported as a warning', async () => {
    const ofw = fakeOfw();
    const blobs = fakeBlobs();
    blobs.failDelete = true;
    setup(ofw.client);
    const slot = (await call('ofw_upload_attachment', { uploadSlots: [{ filename: 'a.jpg' }] })).body.slots[0];
    putIntoSlot(blobs, slot, JPEG);
    const res = await callConfirmed(handlers.get('ofw_send_message')!, { subject: 's', body: 'b', recipientIds: [1], blobKeys: [slot.blobKey] });
    const text = res.content[0].text;
    const sent = JSON.parse(text.slice(text.lastIndexOf('\n\n{') === -1 ? 0 : text.lastIndexOf('\n\n{') + 2));
    expect(sent.attachmentsUploaded).toEqual([expect.objectContaining({ fileId: 7000 })]);
    expect(sent.warnings[0]).toMatch(/could not be deleted/);
  });

  it('a blob attachment is uploaded, sent and deleted on confirmation', async () => {
    const ofw = fakeOfw();
    const blobs = fakeBlobs();
    setup(ofw.client);
    const slot = (await call('ofw_upload_attachment', { uploadSlots: [{ filename: 'a.jpg' }] })).body.slots[0];
    putIntoSlot(blobs, slot, JPEG);
    await callConfirmed(handlers.get('ofw_send_message')!, { subject: 's', body: 'b', recipientIds: [1], blobKeys: [slot.blobKey] });
    const post = ofw.calls.find((c) => c.method === 'POST' && c.path === '/pub/v3/messages')!;
    expect((post.body as { attachments: { myFileIDs: number[] } }).attachments.myFileIDs).toEqual([7000]);
    expect(blobs.objects.has(slot.blobKey)).toBe(false);
  });
});

describe('ofw_download_attachment — hosted download link', () => {
  function seedFile(ofw: FakeOfw, bytes: Buffer, name = 'scan.pdf', type = 'application/pdf') {
    vi.spyOn(ofw.client, 'requestBinary').mockResolvedValue({ body: bytes, contentType: type, suggestedFileName: name } as never);
  }

  it('on mcp-host with inline off, PUTs the file to the blob store and returns a signed link instead of a server path', async () => {
    const ofw = fakeOfw();
    const blobs = fakeBlobs();
    seedFile(ofw, PDF);
    const io = new NodeAttachmentIO();
    const write = vi.spyOn(io, 'writeDownload');
    setup(ofw.client, io);
    const { body } = await call('ofw_download_attachment', { fileId: 31, inline: false });
    expect(write).not.toHaveBeenCalled();
    expect(body).toMatchObject({ fileId: 31, deliveredVia: 'link', fileName: 'scan.pdf', mimeType: 'application/pdf', sizeBytes: PDF.length });
    expect(body.url).toMatch(new RegExp(`^${BLOB_BASE}/attachments/[0-9a-f-]{36}/31-scan\\.pdf\\?exp=`));
    expect(typeof body.expiresAt).toBe('string');
    const put = blobs.calls.find((c) => c.method === 'PUT')!;
    expect(blobs.objects.get(put.key)!.bytes).toEqual(PDF);
  });

  it('link:true asks for the link explicitly', async () => {
    const ofw = fakeOfw();
    fakeBlobs();
    seedFile(ofw, PDF);
    setup(ofw.client);
    const { body } = await call('ofw_download_attachment', { fileId: 31, link: true, linkMinutes: 5 });
    expect(body.deliveredVia).toBe('link');
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  });

  it('a link can carry the extracted content too, and falls back to cached metadata for name and type', async () => {
    const ofw = fakeOfw();
    fakeBlobs();
    await cache.upsertAttachmentForMessage({ fileId: 34, fileName: 'notes.txt', label: 'notes', mimeType: 'text/plain', sizeBytes: 5, metadata: {}, messageId: 0 });
    vi.spyOn(ofw.client, 'requestBinary').mockResolvedValue({ body: Buffer.from('hello') } as never);
    setup(ofw.client);
    const { body } = await call('ofw_download_attachment', { fileId: 34, link: true, extract: true });
    expect(body).toMatchObject({ deliveredVia: 'link', fileName: 'notes.txt', mimeType: 'text/plain' });
    expect(JSON.stringify(body.extracted)).toContain('hello');
  });

  it('an image over the inline cap falls back to a link instead of failing', async () => {
    const ofw = fakeOfw();
    fakeBlobs();
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_INLINE_BYTES)]);
    seedFile(ofw, big, 'huge.png', 'image/png');
    setup(ofw.client);
    const { body } = await call('ofw_download_attachment', { fileId: 32, inline: true });
    expect(body.deliveredVia).toBe('link');
    expect(body.note).toMatch(/too large to return inline/);
  });

  it('on mcp-host, link:false returns the content inline rather than writing to the server disk', async () => {
    const ofw = fakeOfw();
    fakeBlobs();
    seedFile(ofw, JPEG, 'p.jpg', 'image/jpeg');
    const io = new NodeAttachmentIO();
    const write = vi.spyOn(io, 'writeDownload');
    setup(ofw.client, io);
    const res = await handlers.get('ofw_download_attachment')!({ fileId: 33, inline: false, link: false }, NO_ELICIT_CTX);
    expect(write).not.toHaveBeenCalled();
    expect(res.content.some((c) => c.type === 'image')).toBe(true);
  });

  it('link:true without a blob store is refused with the alternatives', async () => {
    const ofw = fakeOfw();
    seedFile(ofw, PDF);
    setup(ofw.client);
    await expect(handlers.get('ofw_download_attachment')!({ fileId: 31, link: true }))
      .rejects.toThrow(/no blob store.*inline/s);
  });
});
