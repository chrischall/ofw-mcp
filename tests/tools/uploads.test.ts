import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBlobStore } from '@chrischall/mcp-utils/export';
import { MAX_UPLOAD_BYTES } from '../../src/tools/attachments.js';
import { OFWClient } from '../../src/client.js';
import { OFWCache } from '../../src/cache/node.js';
import {
  blobObjectToUpload,
  decodeBase64Content,
  fileNameFromBlobKey,
  hasBlobStoreEnv,
  hostedPathRefusal,
  isHostedDeployment,
  mintUploadSlot,
  resolveInlineUpload,
  resolveUploadMime,
  sanitizeUploadFilename,
  uploadPending,
  UPLOAD_SLOT_TTL_MS,
  type PendingAttachment,
} from '../../src/tools/uploads.js';

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const STORE = createBlobStore({ baseUrl: 'https://host.example/b/reg_0123456789abcdef01234567', signingKey: 'a2V5' });

describe('sanitizeUploadFilename', () => {
  it('keeps an ordinary filename, spaces and unicode included, trimmed', () => {
    expect(sanitizeUploadFilename('  Sam Think Sheet 11-3.jpg ')).toBe('Sam Think Sheet 11-3.jpg');
    expect(sanitizeUploadFilename('reçu.pdf')).toBe('reçu.pdf');
  });

  it.each([
    ['', /empty/],
    ['   ', /empty/],
    ['photos/a.jpg', /bare filename/],
    ['..\\a.jpg', /bare filename/],
    ['/etc/passwd', /bare filename/],
    ['.env', /dot/],
    ['..', /dot/],
    ['a\u0000.jpg', /control/],
    ['a\n.jpg', /control/],
    ['x'.repeat(201), /200/],
  ])('refuses %j', (name, why) => {
    expect(() => sanitizeUploadFilename(name)).toThrow(why);
  });
});

describe('resolveUploadMime', () => {
  it.each([
    ['a.jpg', 'image/jpeg'],
    ['a.JPEG', 'image/jpeg'],
    ['a.png', 'image/png'],
    ['a.heic', 'image/heic'],
    ['a.pdf', 'application/pdf'],
    ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['a.unknownext', 'application/octet-stream'],
  ])('infers %s → %s from the extension', (name, mime) => {
    expect(resolveUploadMime(name)).toBe(mime);
  });

  it('prefers an explicit mimeType, normalised to a bare media type', () => {
    expect(resolveUploadMime('scan', 'Image/PNG; charset=UTF-8')).toBe('image/png');
  });

  it('refuses a mimeType that is not type/subtype', () => {
    expect(() => resolveUploadMime('a.jpg', 'jpeg')).toThrow(/mimeType/);
    expect(() => resolveUploadMime('a.jpg', 'image/jp eg')).toThrow(/mimeType/);
  });
});

describe('decodeBase64Content', () => {
  it('decodes standard base64, tolerating line wrapping and a data: URL prefix', () => {
    expect(decodeBase64Content(b64(JPEG), 'a.jpg')).toEqual(JPEG);
    const wrapped = b64('hello world, this is long enough to wrap').replace(/(.{8})/g, '$1\n');
    expect(decodeBase64Content(wrapped, 'a.txt').toString()).toBe('hello world, this is long enough to wrap');
    expect(decodeBase64Content(`data:image/jpeg;base64,${b64(JPEG)}`, 'a.jpg')).toEqual(JPEG);
  });

  it.each([
    ['not base64!', /not valid base64/],
    ['abc', /not valid base64/], // truncated: length not a multiple of 4
    ['ab=c', /not valid base64/],
    ['-_-_', /not valid base64/], // base64url alphabet
  ])('refuses %j, naming the file', (content, why) => {
    expect(() => decodeBase64Content(content, 'photo.jpg')).toThrow(why);
    expect(() => decodeBase64Content(content, 'photo.jpg')).toThrow(/photo\.jpg/);
  });

  it('refuses non-canonical padding bits rather than guessing', () => {
    // "QR==" and "QQ==" both decode to "A"; only the canonical spelling passes.
    expect(decodeBase64Content('QQ==', 'a.txt').toString()).toBe('A');
    expect(() => decodeBase64Content('QR==', 'a.txt')).toThrow(/not valid base64/);
  });

  it('refuses an empty file', () => {
    expect(() => decodeBase64Content('', 'a.jpg')).toThrow(/empty/);
  });

  it('refuses an over-size file before decoding it, naming the 25 MiB limit', () => {
    const tooBig = 'A'.repeat(Math.ceil((MAX_UPLOAD_BYTES + 3) / 3) * 4);
    expect(() => decodeBase64Content(tooBig, 'big.jpg')).toThrow(/25 MiB/);
  });

  it('accepts a file of exactly the limit', () => {
    const exact = Buffer.alloc(MAX_UPLOAD_BYTES, 1).toString('base64');
    expect(decodeBase64Content(exact, 'max.bin').length).toBe(MAX_UPLOAD_BYTES);
  });
});

describe('resolveInlineUpload', () => {
  it('returns a typed Blob, the sanitized name, mime and size', async () => {
    const up = resolveInlineUpload({ filename: ' Sam.jpg ', contentBase64: b64(JPEG) });
    expect(up).toMatchObject({ fileName: 'Sam.jpg', mimeType: 'image/jpeg', sizeBytes: JPEG.length });
    expect(up.blob.type).toBe('image/jpeg');
    expect(Buffer.from(await up.blob.arrayBuffer())).toEqual(JPEG);
  });

  it('uses an explicit mimeType over the extension', () => {
    expect(resolveInlineUpload({ filename: 'scan', contentBase64: b64('%PDF-1.7'), mimeType: 'application/pdf' }).mimeType)
      .toBe('application/pdf');
  });
});

describe('upload slots and blob keys', () => {
  it('mints a PUT slot whose key round-trips to the original filename', () => {
    const now = Date.now();
    const slot = mintUploadSlot(STORE, { filename: 'Sam Think Sheet 11-3.jpg' });
    expect(slot.filename).toBe('Sam Think Sheet 11-3.jpg');
    expect(slot.mimeType).toBe('image/jpeg');
    expect(slot.method).toBe('PUT');
    expect(slot.blobKey).toMatch(/^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9_-]+$/);
    expect(slot.uploadUrl.startsWith('https://host.example/b/reg_0123456789abcdef01234567/uploads/')).toBe(true);
    expect(fileNameFromBlobKey(slot.blobKey)).toBe('Sam Think Sheet 11-3.jpg');
    expect(Date.parse(slot.expiresAt) - now).toBeLessThanOrEqual(UPLOAD_SLOT_TTL_MS + 1000);
    // The curl line must send the SAME content type the URL was signed for.
    expect(slot.curl).toContain("-H 'Content-Type: image/jpeg'");
    expect(slot.curl).toContain('--data-binary @');
    expect(slot.curl).toContain(slot.uploadUrl);
  });

  it('mints a fresh key per slot, even for the same filename', () => {
    expect(mintUploadSlot(STORE, { filename: 'a.jpg' }).blobKey).not.toBe(mintUploadSlot(STORE, { filename: 'a.jpg' }).blobKey);
  });

  it('validates the filename and mime before minting', () => {
    expect(() => mintUploadSlot(STORE, { filename: '../a.jpg' })).toThrow(/bare filename/);
    expect(() => mintUploadSlot(STORE, { filename: 'a.jpg', mimeType: 'nope' })).toThrow(/mimeType/);
  });

  it.each([
    'exp/123/x.zip',
    'calendar/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/x.ics',
    'uploads/not-a-uuid/YS5qcGc',
    'uploads/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/YS5qcGc/extra',
    'uploads/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/',
  ])('refuses a key it did not mint: %s', (key) => {
    expect(() => fileNameFromBlobKey(key)).toThrow(/uploadSlots/);
  });

  it('refuses a well-formed key whose encoded name is not a safe filename', () => {
    const evil = Buffer.from('../../etc/passwd').toString('base64url');
    expect(() => fileNameFromBlobKey(`uploads/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/${evil}`)).toThrow(/bare filename/);
  });
});

describe('blobObjectToUpload', () => {
  const key = mintUploadSlot(STORE, { filename: 'Sam.jpg' }).blobKey;

  it('builds an upload from the stored bytes and the signed content type', () => {
    const up = blobObjectToUpload(key, { key, bytes: new Uint8Array(JPEG), contentType: 'image/jpeg' });
    expect(up).toMatchObject({ fileName: 'Sam.jpg', mimeType: 'image/jpeg', sizeBytes: JPEG.length });
  });

  it('falls back to the extension when the store reports no content type', () => {
    expect(blobObjectToUpload(key, { key, bytes: new Uint8Array(JPEG) }).mimeType).toBe('image/jpeg');
  });

  it('refuses an empty or over-size object', () => {
    expect(() => blobObjectToUpload(key, { key, bytes: new Uint8Array(0) })).toThrow(/empty/);
    expect(() => blobObjectToUpload(key, { key, bytes: { length: MAX_UPLOAD_BYTES + 1 } as Uint8Array })).toThrow(/25 MiB/);
  });
});

describe('isHostedDeployment / hostedPathRefusal', () => {
  it('is hosted when mcp-host injected MCP_DATA_DIR or a blob store', () => {
    expect(isHostedDeployment({})).toBe(false);
    expect(isHostedDeployment({ MCP_DATA_DIR: '/data/state/reg_x' })).toBe(true);
    expect(isHostedDeployment({ MCP_BLOB_BASE_URL: 'https://h/b/reg' })).toBe(true);
    expect(isHostedDeployment({ MCP_DATA_DIR: '${MCP_DATA_DIR}' })).toBe(false);
  });

  it('sees a blob store only when both variables are set', () => {
    expect(hasBlobStoreEnv({ MCP_BLOB_BASE_URL: 'https://h/b/reg' })).toBe(false);
    expect(hasBlobStoreEnv({ MCP_BLOB_SIGNING_KEY: 'k' })).toBe(false);
    expect(hasBlobStoreEnv({ MCP_BLOB_BASE_URL: 'https://h/b/reg', MCP_BLOB_SIGNING_KEY: 'k' })).toBe(true);
  });

  it('points at uploadSlots when a blob store exists, and at inline either way', () => {
    expect(hostedPathRefusal(true).message).toMatch(/remote.*can't read files on your machine/);
    expect(hostedPathRefusal(true).message).toMatch(/uploadSlots/);
    expect(hostedPathRefusal(true).message).toMatch(/inline/);
    expect(hostedPathRefusal(false).message).not.toMatch(/uploadSlots/);
    expect(hostedPathRefusal(false).message).toMatch(/inline/);
  });
});

describe('uploadPending', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function ctx(deleteStatus = 204) {
    const client = new OFWClient();
    let nextId = 100;
    vi.spyOn(client, 'request').mockImplementation(async () => ({ fileId: nextId++, fileName: 'f', shareClass: 'PRIVATE' }));
    const blobs = new Map<string, Buffer>();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const key = decodeURIComponent(new URL(String(input)).pathname.split('/b/reg_0123456789abcdef01234567/')[1]!);
      if (init?.method === 'DELETE') return new Response(null, { status: deleteStatus });
      const bytes = blobs.get(key);
      return bytes ? new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/jpeg' } }) : new Response('', { status: 404 });
    }));
    return { client, cache: OFWCache.open(':memory:'), blobs };
  }

  it('refuses a blob whose bytes changed after the preview bound them, uploading nothing', async () => {
    const c = ctx();
    const key = mintUploadSlot(STORE, { filename: 'a.jpg' }).blobKey;
    c.blobs.set(key, JPEG);
    const stale: PendingAttachment = { fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 6, sha256: '0'.repeat(64), blobKey: key };
    await expect(uploadPending([stale], { client: c.client, cache: c.cache, store: STORE, nothingWas: 'sent' }))
      .rejects.toThrow(/a\.jpg changed in the upload store after it was previewed\. Nothing was sent\.$/);
    expect(c.client.request).not.toHaveBeenCalled();
  });

  it('turns a failed blob delete into a warning beside the upload', async () => {
    const c = ctx(500);
    const key = mintUploadSlot(STORE, { filename: 'a.jpg' }).blobKey;
    c.blobs.set(key, JPEG);
    const out = await uploadPending(
      [{ fileName: 'a.jpg', mimeType: null, sizeBytes: null, sha256: null, blobKey: key }],
      { client: c.client, cache: c.cache, store: STORE, nothingWas: 'saved' },
    );
    expect(out.uploaded.map((u) => u.fileId)).toEqual([100]);
    expect(out.warnings[0]).toMatch(/a\.jpg was uploaded \(fileId 100\).*could not be deleted.*HTTP 500/);
  });
});

describe('uploadPending — failure label follows the share class', () => {
  it('names SHARED when the batch was uploading SHARED', async () => {
    const client = new OFWClient();
    let n = 0;
    vi.spyOn(client, 'request').mockImplementation(async () => {
      if (++n === 2) throw new Error('boom');
      return { fileId: 100, fileName: 'a.jpg', shareClass: 'SHARED' };
    });
    const cache = OFWCache.open(':memory:');
    const p = (name: string): PendingAttachment => ({
      fileName: name, mimeType: 'image/jpeg', sizeBytes: 6, sha256: null,
      inline: { blob: new Blob([new Uint8Array(JPEG)]), fileName: name, mimeType: 'image/jpeg', sizeBytes: 6 },
    });
    await expect(uploadPending([p('a.jpg'), p('b.jpg')], { client, cache, store: undefined, nothingWas: 'sent', shareClass: 'SHARED' }))
      .rejects.toThrow(/Already uploaded to My Files \(SHARED\): a\.jpg \(fileId 100\)/);
  });
});
