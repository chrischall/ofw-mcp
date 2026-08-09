// A minimal, dependency-free ZIP reader.
//
// OOXML attachments (.xlsx/.docx/.pptx) are ZIP containers of XML parts, so
// reading one is the first step of every office-document extractor. This is
// deliberately not a general ZIP library: it reads the central directory,
// slices an entry's bytes, and inflates DEFLATE members via the WHATWG
// `DecompressionStream` — a web standard available in Node ≥18 and in
// sandboxed runtimes alike, so the
// same code runs on the stdio server and a hosted deployment. Using
// `node:zlib` here would tie this to Node; adding a userland inflate
// dependency would bloat it. Neither is necessary.

import { inflateBounded, MAX_DECOMPRESSED_BYTES } from './inflate.js';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;

/**
 * Hard ceiling on a single decompressed member (32 MiB). An attachment is a
 * co-parent-supplied file, so a zip bomb is a real (if unlikely) input, and the
 * memory budget of a constrained runtime is what is being protected.
 *
 * The cap is enforced on the bytes as they arrive ({@link inflateBounded}), NOT
 * on the size the archive declares for itself. The declared size is checked too
 * — it rejects an HONEST oversized member without inflating anything — but it
 * is an optimization, not the guarantee: a central directory is free to claim
 * 1 KB in front of a member that expands to a gigabyte.
 */
export const ZIP_MAX_UNCOMPRESSED_BYTES = MAX_DECOMPRESSED_BYTES;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** A parsed archive. Member bytes are decompressed lazily, then memoized. */
export interface ZipArchive {
  /** Entry names, in central-directory order. */
  names(): string[];
  has(name: string): boolean;
  /** Decompressed bytes for `name`, or null when the archive has no such entry. */
  read(name: string): Promise<Buffer | null>;
  /** {@link read}, decoded as UTF-8 (BOM stripped). */
  readText(name: string): Promise<string | null>;
}

/** Locate the end-of-central-directory record, scanning back past any comment. */
function findEocd(bytes: Buffer): number {
  // The comment field is a uint16, so the record starts at most 22+65535 bytes
  // from the end. Scan backwards for the signature.
  const earliest = Math.max(0, bytes.length - (22 + 0xffff));
  for (let i = bytes.length - 22; i >= earliest; i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a ZIP archive (no end-of-central-directory record)');
}

export interface ZipOptions {
  /** Per-member decompression cap. Defaults to {@link ZIP_MAX_UNCOMPRESSED_BYTES}. */
  maxUncompressedBytes?: number;
}

export async function readZip(bytes: Buffer, opts: ZipOptions = {}): Promise<ZipArchive> {
  const limit = opts.maxUncompressedBytes ?? ZIP_MAX_UNCOMPRESSED_BYTES;
  const eocd = findEocd(bytes);
  const count = bytes.readUInt16LE(eocd + 10);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  if (cdOffset === ZIP64_SENTINEL || count === 0xffff) {
    throw new Error('ZIP64 archives are not supported');
  }

  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error(`corrupt ZIP central directory at offset ${p}`);
    }
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    const name = bytes.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, {
      name,
      method: bytes.readUInt16LE(p + 10),
      compressedSize: bytes.readUInt32LE(p + 20),
      uncompressedSize: bytes.readUInt32LE(p + 24),
      localOffset: bytes.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const cache = new Map<string, Buffer>();

  async function read(name: string): Promise<Buffer | null> {
    const cached = cache.get(name);
    if (cached) return cached;
    const entry = entries.get(name);
    if (!entry) return null;
    // Cheap pre-check for an honest oversized member. A lying header falls
    // through to the streaming cap below, which is the real guarantee.
    if (entry.uncompressedSize > limit) {
      throw new Error(
        `ZIP member ${name} is too large to extract (${entry.uncompressedSize} bytes)`,
      );
    }
    // The central directory records the local header's offset, but the local
    // header carries its OWN name/extra lengths (they can differ from the
    // central copy), so the data offset must be computed from it.
    const lo = entry.localOffset;
    if (bytes.readUInt32LE(lo) !== LOCAL_SIG) {
      throw new Error(`corrupt ZIP local header for ${name}`);
    }
    const start = lo + 30 + bytes.readUInt16LE(lo + 26) + bytes.readUInt16LE(lo + 28);
    const raw = bytes.subarray(start, start + entry.compressedSize);
    let out: Buffer;
    if (entry.method === 0) out = Buffer.from(raw);
    else if (entry.method === 8) out = await inflateBounded(raw, 'deflate-raw', limit, `ZIP member ${name}`);
    else throw new Error(`unsupported ZIP compression method ${entry.method} for ${name}`);
    cache.set(name, out);
    return out;
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    async readText(name) {
      const buf = await read(name);
      if (!buf) return null;
      const text = buf.toString('utf8');
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    },
  };
}
