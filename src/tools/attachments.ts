// The attachment-I/O boundary for the message tools.
//
// `ofw_upload_attachment` reads a local file off disk; `ofw_download_attachment`
// writes downloaded bytes to disk (and reads them back for the inline-reuse
// path). Those are the ONLY node:fs touch points in the message tools — they
// live behind this {@link AttachmentIO} interface so the stdio server can use
// the disk-backed {@link NodeAttachmentIO} while a deployment with no usable
// disk injects an inline, filesystem-free implementation.
// Keeping the interface here means src/tools/messages.ts imports nothing from
// node:fs.

import { existsSync, readFileSync, realpathSync, statSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative } from 'node:path';
import { fileBlob, expandPath } from '@chrischall/mcp-utils';

/** The upload source resolved from a tool-supplied file reference. */
export interface ResolvedUpload {
  /** File content as a Blob (streamed off disk on node). */
  blob: Blob;
  /** Base filename (no directory) — used for the OFW form + cache metadata. */
  fileName: string;
  /** Sniffed MIME type for the Blob's Content-Type. */
  mimeType: string;
  /** File size in bytes — the cache's size fallback when OFW omits it. */
  sizeBytes: number;
}

/**
 * The filesystem operations the message tools need, abstracted so a
 * deployment can supply an inline (no-disk) implementation.
 */
export interface AttachmentIO {
  /**
   * Whether this deployment can persist downloads to a local filesystem. False
   * on a hosted deployment, where inline is the ONLY channel to the bytes —
   * the download tool forces inline mode instead of erroring on a disk write
   * that would fail, so the caller is never left with neither a render nor bytes.
   */
  readonly supportsDisk: boolean;
  /**
   * Resolve an upload from the tool's `path` argument: read the file and
   * return its bytes-as-Blob plus filename/mime/size. Throws if the path is
   * missing or not a regular file.
   */
  resolveUpload(path: string): Promise<ResolvedUpload>;
  /**
   * Read previously-downloaded bytes for the inline-reuse fast path. Returns
   * null when the on-disk copy is gone/unreadable so the caller re-fetches.
   */
  readDownloaded(path: string): Buffer | null;
  /**
   * Persist downloaded bytes to `dest`, creating parent directories. `dest`
   * must resolve (symlinks included) inside `root`, and an existing file is
   * replaced only when `overwrite` is set.
   */
  writeDownload(dest: string, bytes: Buffer, opts: WriteDownloadOptions): void;
}

export interface WriteDownloadOptions {
  /** The only directory tree a download may land in. */
  root: string;
  /** Replace an existing file at `dest` (the tool's `force`). */
  overwrite: boolean;
}

/**
 * True when `candidate` is strictly inside `root` (both absolute). Lexical:
 * resolve symlinks first when that matters.
 */
export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The deepest ancestor of `path` (itself included) that exists on disk. */
function deepestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) current = dirname(current);
  return current;
}

// Lightweight mime sniff from extension. OFW re-derives mime from the filename
// server-side anyway, so this is just a polite Content-Type for the Blob.
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html', '.htm': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.ics': 'text/calendar',
};

export function mimeFromName(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

const OCTET_STREAM = 'application/octet-stream';

// The media types a host's inline image renderer accepts. Anything else — even
// a valid image type like image/heic — must go back as an EmbeddedResource, and
// a parameter suffix (image/png;charset=UTF-8) is rejected outright, which is
// exactly the bug this normalization boundary exists to prevent.
const HOST_RENDERABLE_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

/**
 * Strip a MIME type down to its bare `type/subtype`: drop any `;`-delimited
 * parameters (`charset`, `name`, …), lowercase, and trim. An empty/absent value
 * becomes `application/octet-stream`. OFW hands back `image/png;charset=UTF-8`
 * on binary attachments, and a host's image renderer rejects the parameter
 * suffix — so no derived MIME must ever carry one.
 */
export function normalizeMimeType(raw: string | null | undefined): string {
  if (!raw) return OCTET_STREAM;
  const bare = raw.split(';', 1)[0].trim().toLowerCase();
  return bare || OCTET_STREAM;
}

/**
 * Detect a host-renderable image type from the leading bytes (magic numbers).
 * OFW's `Content-Type` is unreliable for binaries (it tacks a text `charset`
 * onto them), so the actual bytes are the authoritative signal. Returns the
 * bare media type, or null when the bytes aren't a PNG/JPEG/GIF/WEBP.
 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_MAGIC)) return 'image/jpeg';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Resolve the MIME type to report for downloaded bytes, in priority order:
 * magic-number sniff (bytes never lie) → parameter-stripped upstream header →
 * filename extension. The result is always bare (never carries a `;` parameter).
 */
export function resolveDownloadMime(
  bytes: Buffer, headerMime: string | null | undefined, fileName: string,
): string {
  const sniffed = sniffImageMime(bytes);
  if (sniffed) return sniffed;
  const fromHeader = normalizeMimeType(headerMime);
  if (fromHeader !== OCTET_STREAM) return fromHeader;
  return mimeFromName(fileName);
}

/** True only for the bare media types a host renders as inline ImageContent. */
export function isHostRenderableImage(mime: string): boolean {
  return HOST_RENDERABLE_IMAGE_MIMES.has(mime);
}

/** Disk-backed attachment I/O for the stdio/desktop server. */
export class NodeAttachmentIO implements AttachmentIO {
  readonly supportsDisk = true;

  async resolveUpload(path: string): Promise<ResolvedUpload> {
    const abs = expandPath(path);
    const stat = statSync(abs); // throws if missing
    if (!stat.isFile()) throw new Error(`Not a file: ${abs}`);
    const fileName = basename(abs);
    const mimeType = mimeFromName(fileName);
    // fileBlob streams the file off disk (a file-backed Blob) instead of buffering it.
    const blob = await fileBlob(abs, { type: mimeType });
    return { blob, fileName, mimeType, sizeBytes: stat.size };
  }

  readDownloaded(path: string): Buffer | null {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  }

  writeDownload(dest: string, bytes: Buffer, { root, overwrite }: WriteDownloadOptions): void {
    // The bytes are co-parent-supplied, so where they land is the security
    // boundary. Check the REAL path of the nearest existing ancestor before
    // creating anything, so a symlinked directory inside the root cannot carry
    // the write (or even the mkdir) somewhere else.
    mkdirSync(root, { recursive: true });
    const realRoot = realpathSync(root);
    const parent = dirname(dest);
    const anchor = realpathSync(deepestExisting(parent));
    if (anchor !== realRoot && !isWithin(realRoot, anchor)) {
      throw new Error(`Refusing to write ${dest}: it resolves outside the attachments directory (${root}).`);
    }
    mkdirSync(parent, { recursive: true });
    if (overwrite) {
      // unlink removes a symlink itself, never its target.
      try { unlinkSync(dest); } catch { /* nothing there to replace */ }
    }
    try {
      // 'wx' fails on ANY existing entry, a symlink (even dangling) included,
      // so nothing already at `dest` is ever clobbered or followed.
      writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Refusing to overwrite ${dest}: a file already exists there. Pass force:true to replace it, or choose another saveTo.`);
      }
      throw e;
    }
  }
}
