// Bounded decompression, shared by the ZIP reader and the PDF stream decoder.
//
// Both formats let the FILE state how big a member expands to, and both are
// read from co-parent-supplied attachments. A declared size is therefore a
// hint, never a guarantee: a ZIP central directory can claim 1 KB in front of a
// member that expands to a gigabyte, and a PDF stream dictionary declares
// nothing about its inflated length at all. Checking the declared number before
// inflating rejects an HONEST oversized member cheaply — it does nothing about
// a lying one.
//
// So the real cap is enforced on the bytes as they actually arrive: read the
// decompressed stream chunk by chunk, and abort the moment the running total
// passes the limit. Peak memory is then bounded by the limit rather than by
// whatever the file felt like claiming.

/** 32 MiB. Sized to fit comfortably inside a constrained memory budget. */
export const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

/**
 * Thrown when decompression is aborted for exceeding its cap. Distinct from a
 * decode failure so callers can tell "this file is hostile or absurd" from
 * "this stream is corrupt" — the first deserves to be reported, the second is
 * routinely survivable.
 */
export class DecompressionLimitError extends Error {
  constructor(label: string, limit: number) {
    super(`${label} expands past the ${limit}-byte decompression cap`);
    this.name = 'DecompressionLimitError';
  }
}

/**
 * Inflate `data`, aborting if the OUTPUT exceeds `limit` bytes.
 *
 * `deflate-raw` is the ZIP member format; `deflate` is the zlib-wrapped form a
 * PDF `/FlateDecode` stream uses. Both go through the WHATWG
 * `DecompressionStream` so this runs unchanged wherever the standard exists.
 */
export async function inflateBounded(
  data: Buffer, format: 'deflate-raw' | 'deflate', limit: number, label: string,
): Promise<Buffer> {
  const stream = new Blob([data as unknown as BlobPart]).stream()
    .pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      // Stop pulling: the rest of the payload is never allocated.
      await reader.cancel();
      throw new DecompressionLimitError(label, limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
