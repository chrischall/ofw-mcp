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
 * 64 MiB: the most one DOCUMENT may decompress in total, across all its
 * members or streams. The per-member cap alone does not bound memory: a
 * workbook of 100 sheets that each inflate to just under 32 MiB, or a PDF
 * whose every page references the same near-cap stream, would keep gigabytes
 * of output alive from a few kilobytes of attachment.
 */
export const MAX_TOTAL_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/** A running total of decompressed bytes for one document, shared by every read. */
export class DecompressionBudget {
  private used = 0;
  constructor(readonly limit: number = MAX_TOTAL_DECOMPRESSED_BYTES) {}

  /** Charge `bytes`; throws once the document's total passes the limit. */
  charge(bytes: number, label: string): void {
    this.used += bytes;
    if (this.used > this.limit) throw new DecompressionLimitError(label, this.limit, 'total');
  }
}

/**
 * Thrown when decompression is aborted for exceeding its cap. Distinct from a
 * decode failure so callers can tell "this file is hostile or absurd" from
 * "this stream is corrupt" — the first deserves to be reported, the second is
 * routinely survivable.
 */
export class DecompressionLimitError extends Error {
  constructor(label: string, limit: number, scope: 'member' | 'total' = 'member') {
    super(scope === 'total'
      ? `${label} pushes the document past its ${limit}-byte total decompression cap`
      : `${label} expands past the ${limit}-byte decompression cap`);
    this.name = 'DecompressionLimitError';
  }
}

/**
 * Inflate `data`, aborting if the OUTPUT exceeds `limit` bytes, or pushes the
 * document's shared `budget` (when given) past its total.
 *
 * `deflate-raw` is the ZIP member format; `deflate` is the zlib-wrapped form a
 * PDF `/FlateDecode` stream uses. Both go through the WHATWG
 * `DecompressionStream` so this runs unchanged wherever the standard exists.
 */
export async function inflateBounded(
  data: Buffer, format: 'deflate-raw' | 'deflate', limit: number, label: string,
  budget?: DecompressionBudget,
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
    try {
      budget?.charge(value.length, label);
    } catch (err) {
      await reader.cancel();
      throw err;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
