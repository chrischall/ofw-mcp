// The attachment-I/O boundary for the message tools.
//
// `ofw_upload_attachment` reads a local file off disk; `ofw_download_attachment`
// writes downloaded bytes to disk (and reads them back for the inline-reuse
// path). Those are the ONLY node:fs touch points in the message tools — they
// live behind this {@link AttachmentIO} interface so the stdio server can use
// the disk-backed {@link NodeAttachmentIO} while the hosted Cloudflare
// connector (a later task) injects an inline, filesystem-free implementation.
// Keeping the interface here means src/tools/messages.ts imports nothing from
// node:fs.

import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
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
 * The filesystem operations the message tools need, abstracted so a Worker
 * deployment can supply an inline (no-disk) implementation.
 */
export interface AttachmentIO {
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
  /** Persist downloaded bytes to `dest`, creating parent directories. */
  writeDownload(dest: string, bytes: Buffer): void;
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

/** Disk-backed attachment I/O for the stdio/desktop server. */
export class NodeAttachmentIO implements AttachmentIO {
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

  writeDownload(dest: string, bytes: Buffer): void {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  }
}
