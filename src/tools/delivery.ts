// The attachment delivery ladder.
//
// A successful fetch must always produce retrievable content. "The host cannot
// render this type" is a DISPLAY limit, and letting it become a DATA limit is
// the bug this module exists to close: `ofw_download_attachment` used to fetch
// a 10 KB custody-schedule spreadsheet, hand back an EmbeddedResource, and have
// the host reject it with "Resources of type '…spreadsheetml.sheet' are not
// currently supported" — leaving the caller holding nothing at all.
//
// Every inline delivery now walks the same rungs and returns the first that
// works:
//
//   1. host-renderable image  → ImageContent (the model sees the picture)
//   2. extractable document   → the FILE'S TEXT, as text (see src/extract)
//   3. raw bytes              → base64 EmbeddedResource, as before
//
// Rungs 1 and 3 are bounded by MAX_INLINE_BYTES (10 MiB raw; see below).
// Rung 3 never disappears, so nothing regresses; rung 2 is what makes a
// spreadsheet, PDF, Word or PowerPoint attachment readable at all. When a rung
// is skipped or fails, the response says so by name in `deliveryAttempts` —
// a caller must never be left guessing why it got bytes instead of content.

import { extractAttachment, type Extracted } from '../extract/index.js';
import { isHostRenderableImage } from './attachments.js';

/**
 * Upper bound on the RAW bytes this tool will return inline (as ImageContent
 * or a base64 EmbeddedResource). Extracted text is not subject to it — that is
 * already bounded by `maxChars`.
 *
 * Why 10 MiB: mcp-host, the hosted runtime that runs this MCP for claude.ai,
 * caps any single child result at 14 MiB of serialized JSON-RPC
 * (`CHILD_RESULT_MAX_BYTES`, chrischall/mcp-host#952) and replaces anything
 * larger with a generic "result too large" tool error. 10 MiB raw is ~13.3 MiB
 * as base64, which with the JSON-RPC envelope still fits under 14 MiB — so this
 * bound fires first, with a message that says what to do instead. claude.ai
 * itself accepts images up to 10 MB each (measured 2026-09-27), and before
 * #952 anything over 10 MiB killed the child process outright. Real traffic
 * for this tool has peaked at ~3 MB, so normal use never reaches it.
 */
export const MAX_INLINE_BYTES = 10 * 1024 * 1024;

/** Which rung of the ladder produced the content in this response. */
export type DeliveredVia = 'image' | 'extracted' | 'blob' | 'disk';

export interface DeliveryOptions {
  /**
   * Force extraction on (`true`) or off (`false`). Undefined means "extract
   * when the host cannot render the file itself", which is the default.
   */
  extract?: boolean;
  maxChars?: number;
  parts?: string;
}

export interface ExtractionOutcome {
  extracted?: Extracted;
  truncated?: boolean;
  /** Why no content came back — recorded in the response, never swallowed. */
  reason?: string;
}

/**
 * Attempt extraction, converting every failure into a REASON rather than an
 * exception: a format we cannot read must still be delivered as bytes, and the
 * caller is owed the explanation either way.
 */
export async function tryExtract(
  bytes: Buffer, mimeType: string, fileName: string, opts: DeliveryOptions,
): Promise<ExtractionOutcome> {
  try {
    const extracted = await extractAttachment(bytes, mimeType, fileName, {
      maxChars: opts.maxChars,
      parts: opts.parts,
    });
    if (!extracted) {
      return { reason: `no text extractor for ${mimeType} (${fileName})` };
    }
    return { extracted, truncated: extracted.truncated ?? false };
  } catch (err) {
    // A malformed .xlsx is still an .xlsx: report why it could not be read and
    // fall through to the bytes, rather than failing the whole call.
    return { reason: `extraction failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** An MCP content block, narrowed to the three kinds this module emits. */
export type DeliveryContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } };

export interface InlineDeliveryInput {
  fileId: number;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  /** True when an explicit `inline:false` was overridden (no filesystem). */
  forcedInline: boolean;
  options: DeliveryOptions;
  /**
   * Whether disk mode (`inline:false`) can deliver the file instead. Only then
   * does an over-cap refusal suggest it; on a hosted deployment it cannot.
   */
  diskAvailable?: boolean;
}

/**
 * Refuse to inline more than {@link MAX_INLINE_BYTES}. This is a tool error
 * rather than a fallback: the only non-inline channel is disk mode, which the
 * hosted runtime (the one the cap protects) does not have, and silently
 * writing to disk when the caller asked for content would not be honest.
 */
function assertInlineSize(input: InlineDeliveryInput, rawRequested: boolean): void {
  const { bytes, fileName, fileId, diskAvailable } = input;
  if (bytes.length <= MAX_INLINE_BYTES) return;
  const hints: string[] = [];
  if (rawRequested) hints.push('omit extract:false to get the file\'s extracted text instead, if it is a readable document type');
  if (diskAvailable) hints.push('pass inline:false to save it to disk and get the path');
  hints.push('or open it directly in OurFamilyWizard');
  throw new Error(
    `Attachment ${fileId} (${fileName}) is ${bytes.length} bytes, over the ${MAX_INLINE_BYTES / (1024 * 1024)} MiB `
    + `limit for returning a file inline (a larger result would exceed the host's response size limit). `
    + `To get it: ${hints.join('; ')}.`,
  );
}

/**
 * Build the content blocks for an inline download by walking the ladder.
 * The first block is always a JSON meta block naming `deliveredVia`, so the
 * caller can tell how the content arrived without inspecting block types.
 */
export async function buildInlineDelivery(
  input: InlineDeliveryInput,
): Promise<{ content: DeliveryContent[] }> {
  const { fileId, fileName, mimeType, bytes, forcedInline, options } = input;
  const meta: Record<string, unknown> = {
    fileId, fileName, mimeType, sizeBytes: bytes.length, mode: 'inline',
  };
  if (forcedInline) meta.forcedInline = true;
  const block = (): DeliveryContent => ({ type: 'text', text: JSON.stringify(meta, null, 2) });

  // Rung 1 — the host renders these itself, and a picture beats a description.
  if (isHostRenderableImage(mimeType)) {
    assertInlineSize(input, false);
    meta.deliveredVia = 'image';
    return { content: [block(), { type: 'image', data: bytes.toString('base64'), mimeType }] };
  }

  // Rung 2 — extraction. Skipped only when the caller explicitly opts out.
  const attempts: string[] = [];
  if (options.extract === false) {
    attempts.push('extraction skipped (extract:false)');
  } else {
    const outcome = await tryExtract(bytes, mimeType, fileName, options);
    if (outcome.extracted) {
      meta.deliveredVia = 'extracted';
      meta.extracted = outcome.extracted;
      meta.truncated = outcome.truncated;
      // The bytes are deliberately NOT also attached: the extracted text is the
      // readable form, and a duplicate base64 blob would be the very payload
      // the host rejects — plus double the response size.
      meta.note = 'Content extracted from the file. Pass extract:false to get the raw bytes instead.';
      return { content: [block()] };
    }
    /* v8 ignore next -- tryExtract always sets `reason` when it returns no extraction */
    attempts.push(outcome.reason ?? 'extraction produced no content');
  }

  // Rung 3 — the bytes themselves. Always available up to MAX_INLINE_BYTES, so
  // a fetch that succeeded never ends with the caller holding nothing; beyond
  // it the caller gets a tool error that says how to reach the file instead.
  assertInlineSize(input, options.extract === false);
  meta.deliveredVia = 'blob';
  meta.deliveryAttempts = attempts;
  meta.note = 'Returned as raw bytes. Some hosts cannot render an embedded resource of this type; '
    + 'if it came back unreadable, the file has no text extractor here (see deliveryAttempts).';
  return {
    content: [block(), {
      type: 'resource',
      resource: {
        uri: `ofw://attachment/${fileId}/${encodeURIComponent(fileName)}`,
        mimeType,
        blob: bytes.toString('base64'),
      },
    }],
  };
}
