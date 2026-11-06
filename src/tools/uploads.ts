// Getting a file's bytes to OurFamilyWizard from a caller that shares no
// filesystem with this server.
//
// `ofw_upload_attachment` used to accept only a `path` on the SERVER's disk.
// On mcp-host the caller is a claude.ai session somewhere else entirely, so no
// path it can name exists here, and every upload failed — first as a raw
// ENOENT on an upload directory nobody had created, and even with that
// directory there was no way for the caller to put a file in it.
//
// Two ways in, by size:
//
//  - **Blob upload slots** (hosted, the main path). The server mints a signed
//    PUT URL on mcp-host's per-registration blob store (`uploadSlots`); the
//    caller `curl`s the file to it; the server reads the object back
//    (`blobKeys`) and DELETES it once OFW has the file (`BlobStore.consume`).
//    No base64 in the tool call, so no request-size ceiling, and no photo
//    left sitting in the bucket until the 30-day retention prune.
//  - **Inline base64** (`inline`). Works on any deployment, but every byte
//    rides inside one JSON-RPC request — mcp-host caps that at ~9.9 MiB — and
//    a model must emit the base64 as tool-call text. Fine for a small file or
//    a client with no shell; wrong for a batch of phone photos.
//
// Both converge on a {@link ResolvedUpload}, the same shape a disk `path`
// resolves to, so everything after this point — the My Files POST, the
// SHARED confirmation, the attachment cache — is one code path.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseLenient } from '@chrischall/mcp-utils';
import {
  checkUploadSize as sharedCheckUploadSize,
  decodeBase64Strict,
  inlineFileSchema,
  MAX_UPLOAD_FILES,
  mintUploadSlot as sharedMintUploadSlot,
  resolveUploadMime,
  sanitizeUploadFilename,
  UPLOAD_KEY_PREFIX,
  UPLOAD_SLOT_DEFAULT_TTL_MS,
  uploadFileNameFromKey,
  uploadSlotRequestSchema,
} from '@chrischall/mcp-utils/export';
import type {
  BlobObject, BlobStore, InlineFile, UploadSlot as SharedUploadSlot, UploadSlotRequest,
} from '@chrischall/mcp-utils/export';
import type { OFWClient } from '../client.js';
import type { CacheStore } from '../cache/store.js';
import { MAX_UPLOAD_BYTES, mimeFromName, normalizeMimeType, type ResolvedUpload } from './attachments.js';
import { formatInstant } from '../timestamps.js';

// The filename / MIME / base64 / slot rules are the fleet's, from
// @chrischall/mcp-utils/export (3.6), which was lifted out of this file. The
// names below keep this module's API so callers and tests did not move; the
// only local policy is the 25 MiB cap and the offset-bearing expiresAt.

/** Most files one call may upload (inline array, blobKeys, uploadSlots). */
export const MAX_FILES_PER_CALL = MAX_UPLOAD_FILES;

/** How long an upload slot's PUT URL works. */
export const UPLOAD_SLOT_TTL_MS = UPLOAD_SLOT_DEFAULT_TTL_MS;

/** Object-key prefix for caller uploads — the only keys `blobKeys` accepts. */
export const UPLOAD_BLOB_PREFIX = UPLOAD_KEY_PREFIX;

export { inlineFileSchema, resolveUploadMime, sanitizeUploadFilename, uploadSlotRequestSchema };
export type { InlineFile, UploadSlotRequest };

/** Refuse an empty file or one over the 25 MiB upload cap, naming the limit. */
export function checkUploadSize(fileName: string, size: number): void {
  sharedCheckUploadSize(fileName, size, MAX_UPLOAD_BYTES);
}

/** Strict base64 → bytes, capped at the upload limit (see `decodeBase64Strict`). */
export function decodeBase64Content(content: string, fileName: string): Buffer {
  const bytes = decodeBase64Strict(content, { fileName, maxBytes: MAX_UPLOAD_BYTES });
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** An `inline` entry → the upload it describes, validated end to end. */
export function resolveInlineUpload(file: InlineFile): ResolvedUpload {
  const fileName = sanitizeUploadFilename(file.filename);
  const mimeType = resolveUploadMime(fileName, file.mimeType);
  const bytes = decodeBase64Content(file.contentBase64, fileName);
  return { blob: new Blob([new Uint8Array(bytes)], { type: mimeType }), fileName, mimeType, sizeBytes: bytes.length };
}

/**
 * The filename an upload key was minted for. Only the exact
 * `uploads/<uuid>/<base64url(name)>` shape is accepted, so `blobKeys` can
 * never be pointed at another object in this registration's store (a
 * calendar export, an export zip) and pass it off as an upload.
 */
export function fileNameFromBlobKey(key: string): string {
  try {
    return uploadFileNameFromKey(key, { prefix: UPLOAD_BLOB_PREFIX });
  } catch (e) {
    // The shared message is tool-agnostic; name the tool that mints keys here.
    const message = (e as Error).message;
    if (!message.includes('is not an upload key')) throw e;
    throw new Error(`blobKey ${JSON.stringify(key)} is not an upload key. Pass the blobKey exactly as ofw_upload_attachment's uploadSlots returned it.`);
  }
}

/** One upload slot, as this server reports it (expiresAt with the display offset). */
export type UploadSlot = Omit<SharedUploadSlot, 'expiresAtMs'>;

/** Mint one signed PUT slot for a caller upload. */
export function mintUploadSlot(store: BlobStore, req: UploadSlotRequest): UploadSlot {
  const { expiresAtMs, ...slot } = sharedMintUploadSlot(store, req, { prefix: UPLOAD_BLOB_PREFIX, ttlMs: UPLOAD_SLOT_TTL_MS });
  return { ...slot, expiresAt: formatInstant(new Date(expiresAtMs)).iso };
}

/** A consumed blob object → the upload it holds. */
export function blobObjectToUpload(key: string, object: BlobObject): ResolvedUpload {
  const fileName = fileNameFromBlobKey(key);
  checkUploadSize(fileName, object.bytes.length);
  // The stored type is the one the PUT signature committed to, i.e. the one
  // this server minted the slot for.
  const mimeType = normalizeMimeType(object.contentType ?? mimeFromName(fileName));
  return {
    blob: new Blob([object.bytes as Uint8Array<ArrayBuffer>], { type: mimeType }),
    fileName,
    mimeType,
    sizeBytes: object.bytes.length,
  };
}

// ── The My Files upload ──────────────────────────────────────────────────

export const UploadedFileSchema = z.looseObject({
  fileId: z.number(),
  fileName: z.string().optional(),
  label: z.string().optional(),
  fileType: z.string().optional(),
  sizeInBytes: z.number().optional(),
  shareClass: z.string().optional(),
});

export interface UploadOptions {
  shareClass: 'PRIVATE' | 'SHARED';
  label?: string;
  description?: string;
}

/** What one upload landed as on OFW. */
export interface UploadedFile {
  fileId: number;
  /** The name OFW stored the file under. */
  fileName: string;
  mimeType: string;
  /** The size OFW reports (falls back to `bytes`). */
  sizeBytes: number;
  /** The bytes this server actually sent. */
  bytes: number;
  shareClass: string;
}

/**
 * POST one resolved upload to OFW's My Files, the multipart shape of the OFW
 * web UI's own request, and cache its metadata under the not-yet-linked
 * `messageId: 0` sentinel so a later download or send can name it. The
 * response is parsed STRICTLY: an unusable fileId cached here would be
 * attached to a message later.
 */
export async function uploadToMyFiles(
  client: OFWClient,
  cache: CacheStore,
  upload: ResolvedUpload,
  opts: UploadOptions,
): Promise<UploadedFile> {
  const { blob, fileName, mimeType, sizeBytes } = upload;
  const form = new FormData();
  form.append('file', blob, fileName);
  form.append('source', 'message');
  form.append('description', opts.description ?? fileName);
  form.append('label', opts.label ?? fileName);
  form.append('fileName', fileName);
  form.append('shareClass', opts.shareClass);

  const meta = parseLenient(
    UploadedFileSchema,
    await client.request('POST', '/pub/v3/myfiles/multipart', form),
    { label: 'ofw-mcp', context: 'POST /pub/v3/myfiles/multipart (ofw_upload_attachment)', mode: 'strict' },
  );
  const stored = {
    fileName: meta.fileName ?? fileName,
    mimeType: meta.fileType ?? mimeType,
    sizeBytes: typeof meta.sizeInBytes === 'number' ? meta.sizeInBytes : sizeBytes,
  };
  await cache.upsertAttachmentForMessage({
    fileId: meta.fileId,
    fileName: stored.fileName,
    label: meta.label ?? opts.label ?? fileName,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    metadata: meta,
    messageId: 0,
  });
  return { fileId: meta.fileId, ...stored, bytes: sizeBytes, shareClass: meta.shareClass ?? opts.shareClass };
}

/** SHA-256 of an upload's bytes, hex — what a confirmation binds. */
export async function sha256Hex(blob: Blob): Promise<string> {
  return createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
}

/** Refuse a call naming more than {@link MAX_FILES_PER_CALL} files. */
export function checkFileCount(count: number, what: string): void {
  if (count > MAX_FILES_PER_CALL) {
    throw new Error(`${what}: at most ${MAX_FILES_PER_CALL} files per call (got ${count}). Split them across calls.`);
  }
}

/** The blob store, or a refusal that says what to use instead. */
export function requireBlobStore(store: BlobStore | undefined, what: string): BlobStore {
  if (store) return store;
  throw new Error(`${what} needs the blob store an mcp-host deployment provides, and this server has no blob store (it is a local install). Pass a \`path\` inside the upload directory, or the bytes with \`inline\`.`);
}

// ── Attaching in one step (ofw_save_draft / ofw_send_message) ────────────

export const inlineAttachmentsParam = z.array(inlineFileSchema).max(MAX_FILES_PER_CALL).describe(
  'Files to attach, supplied as base64 BYTES ({filename, contentBase64, mimeType?}). Each is uploaded to My Files '
  + '(PRIVATE when a draft holds it; SHARED when sent, as the web app attaches files) and attached alongside any myFileIDs. Use for small files; on a hosted deployment, larger files (phone photos) go faster '
  + 'through ofw_upload_attachment uploadSlots + blobKeys here. Every entry is validated before anything is uploaded.',
).optional();

export const blobKeysParam = z.array(z.string()).max(MAX_FILES_PER_CALL).describe(
  'Hosted deployments: blobKeys from ofw_upload_attachment uploadSlots whose files you have already PUT. Each is uploaded to '
  + 'My Files (PRIVATE when a draft holds it; SHARED when sent), attached alongside any myFileIDs, and deleted from the upload store.',
).optional();

/** One new attachment, validated, not yet uploaded. */
export interface PendingAttachment {
  fileName: string;
  mimeType: string | null;
  /** Null for a blob that has not been read (no confirmation to bind). */
  sizeBytes: number | null;
  sha256: string | null;
  inline?: ResolvedUpload;
  blobKey?: string;
}

/**
 * Validate every new attachment BEFORE anything is uploaded, so a bad entry
 * fails the call with nothing half-done. With `readBlobs`, blob objects are
 * read (not consumed) so a confirmation can bind their exact bytes.
 */
export async function planAttachments(
  input: { inline?: InlineFile[]; blobKeys?: string[] },
  opts: { store: BlobStore | undefined; readBlobs: boolean },
): Promise<PendingAttachment[]> {
  const inline = input.inline ?? [];
  const keys = input.blobKeys ?? [];
  checkFileCount(inline.length + keys.length, 'inlineAttachments + blobKeys');
  const pending: PendingAttachment[] = [];
  for (const file of inline) {
    const upload = resolveInlineUpload(file);
    pending.push({ fileName: upload.fileName, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, sha256: await sha256Hex(upload.blob), inline: upload });
  }
  if (keys.length > 0) {
    const store = requireBlobStore(opts.store, 'blobKeys');
    for (const blobKey of keys) {
      const fileName = fileNameFromBlobKey(blobKey);
      if (!opts.readBlobs) {
        pending.push({ fileName, mimeType: null, sizeBytes: null, sha256: null, blobKey });
        continue;
      }
      const upload = blobObjectToUpload(blobKey, await store.get(blobKey, { maxBytes: MAX_UPLOAD_BYTES }));
      pending.push({ fileName, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, sha256: await sha256Hex(upload.blob), blobKey });
    }
  }
  return pending;
}

/** What a preview shows of the new attachments. */
export function describePending(pending: PendingAttachment[]): Array<Record<string, unknown>> {
  return pending.map((p) => ({ fileName: p.fileName, mimeType: p.mimeType, sizeBytes: p.sizeBytes, sha256: p.sha256, upload: 'PRIVATE, on approval' }));
}

/**
 * Upload the planned attachments, in order, under `ctx.shareClass` (PRIVATE
 * when a draft holds them; SHARED at send, as the web app attaches files). A blob is consumed —
 * deleted once OFW has it; a failed delete is a warning, never a failure. Any
 * upload failure stops the batch and throws, naming what DID upload, so the
 * caller can retry with those fileIds instead of uploading them twice.
 */
export async function uploadPending(
  pending: PendingAttachment[],
  ctx: { client: OFWClient; cache: CacheStore; store: BlobStore | undefined; nothingWas: string; shareClass: 'PRIVATE' | 'SHARED' },
): Promise<{ uploaded: UploadedFile[]; warnings: string[] }> {
  const uploaded: UploadedFile[] = [];
  const warnings: string[] = [];
  for (const p of pending) {
    try {
      if (p.inline) {
        uploaded.push(await uploadToMyFiles(ctx.client, ctx.cache, p.inline, { shareClass: ctx.shareClass }));
        continue;
      }
      const out = await ctx.store!.consume(p.blobKey!, async (object) => {
        const upload = blobObjectToUpload(p.blobKey!, object);
        if (p.sha256 !== null && (await sha256Hex(upload.blob)) !== p.sha256) {
          throw new Error(`${p.fileName} changed in the upload store after it was previewed`);
        }
        return uploadToMyFiles(ctx.client, ctx.cache, upload, { shareClass: ctx.shareClass });
      }, { maxBytes: MAX_UPLOAD_BYTES });
      uploaded.push(out.result);
      if (!out.deleted) {
        warnings.push(`${p.fileName} was uploaded (fileId ${out.result.fileId}) but its copy in the upload store could not be deleted (${out.deleteError}); it expires with the store's retention.`);
      }
    } catch (e) {
      const done = uploaded.map((u) => `${u.fileName} (fileId ${u.fileId})`);
      throw new Error(
        `Attachment ${p.fileName} could not be uploaded: ${(e as Error).message}. Nothing was ${ctx.nothingWas}.`
        + (done.length > 0
          ? ` Already uploaded to My Files (PRIVATE): ${done.join(', ')} — pass those fileIds in myFileIDs when you retry instead of uploading them again.`
          : ''),
      );
    }
  }
  return { uploaded, warnings };
}

// ── Hosted detection ─────────────────────────────────────────────────────
// Defined beside the code that needs them without importing this module
// (config.ts, attachments.ts), re-exported here as part of the upload surface.
export { hasBlobStoreEnv, isHostedDeployment } from '../config.js';
export { hostedPathRefusal } from './attachments.js';
