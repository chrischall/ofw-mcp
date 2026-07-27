// The delivery ladder's extraction rung.
//
// `ofw_download_attachment` fetches bytes successfully and then has to hand the
// caller something it can actually read. A host renders four image types
// inline and rejects every other embedded resource outright ("Resources of
// type 'application/vnd.…sheet' are not currently supported"), so for a
// spreadsheet, PDF, Word or PowerPoint attachment the bytes are delivered and
// unreadable at the same time. Rendering is a display concern; content is a
// data concern, and this module is what keeps the second from being decided by
// the first: whatever the host can draw, the FILE's text comes back as text.

import { extractXlsx, extractDelimited } from './spreadsheet.js';
import { extractDocx } from './document.js';
import { extractPptx } from './presentation.js';
import { extractPdf } from './pdf.js';
import type { Extracted, PartSelector } from './types.js';

export type { Extracted, PartSelector } from './types.js';

/** Formats this module can turn into text. `null` means "no extractor". */
export type ExtractKind = 'xlsx' | 'csv' | 'tsv' | 'docx' | 'pptx' | 'pdf' | 'text';

const MIME_KINDS: Record<string, ExtractKind> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'application/json': 'text',
  'application/xml': 'text',
  'application/xhtml+xml': 'text',
  'application/javascript': 'text',
  'application/x-yaml': 'text',
};

const EXT_KINDS: Record<string, ExtractKind> = {
  '.xlsx': 'xlsx', '.xlsm': 'xlsx',
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.pdf': 'pdf',
  '.csv': 'csv',
  '.tsv': 'tsv', '.tab': 'tsv',
  '.txt': 'text', '.md': 'text', '.json': 'text', '.xml': 'text',
  '.html': 'text', '.htm': 'text', '.log': 'text', '.yaml': 'text', '.yml': 'text',
  '.ics': 'text', '.vcf': 'text', '.srt': 'text',
};

/**
 * Which extractor handles this attachment, by MIME then by extension. The
 * extension is a real fallback, not a formality: OFW serves binaries with a
 * `charset` bolted on and sometimes with no useful type at all.
 */
export function extractKindFor(mimeType: string, fileName: string): ExtractKind | null {
  const byMime = MIME_KINDS[mimeType];
  if (byMime) return byMime;
  const dot = fileName.lastIndexOf('.');
  const byExt = dot === -1 ? undefined : EXT_KINDS[fileName.slice(dot).toLowerCase()];
  if (byExt) return byExt;
  // Any other text/* type (text/plain, text/markdown, text/html, …) is text.
  return mimeType.startsWith('text/') ? 'text' : null;
}

/**
 * Build a part selector from a `"1-3,5"` / `"Summary,2026"` spec. Numbers are
 * 1-based positions; anything else matches a sheet or slide/page label. An
 * empty spec selects everything rather than nothing — a filter that silently
 * excluded all content would look exactly like an empty file.
 */
export function parsePartSpec(spec: string): PartSelector {
  const ranges: Array<[number, number]> = [];
  const names = new Set<string>();
  for (const token of spec.split(',').map((t) => t.trim()).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) { ranges.push([Number(range[1]), Number(range[2])]); continue; }
    // A bare number is a position AND a possible name: spreadsheet tabs are
    // routinely named for a year ("2026"), and reading that token as a position
    // only would make the obvious `parts: "2026"` select nothing at all.
    if (/^\d+$/.test(token)) ranges.push([Number(token), Number(token)]);
    names.add(token.toLowerCase());
  }
  if (ranges.length === 0 && names.size === 0) return () => true;
  return (index, name) =>
    ranges.some(([from, to]) => index + 1 >= from && index + 1 <= to)
    || names.has(name.toLowerCase());
}

/** Cut `text` to `budget` characters on a line boundary where possible. */
function clip(text: string, budget: number): string {
  const cut = text.slice(0, budget);
  const lastBreak = cut.lastIndexOf('\n');
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
}

function omissionNote(label: string): string {
  return `${label} (omitted: response character budget)`;
}

/**
 * Trim an extraction to `maxChars`, recording exactly what was dropped. A
 * truncated payload that does not say so is worse than a short one: the caller
 * reads a partial custody schedule as the whole schedule.
 */
export function applyCharBudget(extracted: Extracted, maxChars: number): Extracted {
  switch (extracted.kind) {
    case 'text':
    case 'document': {
      if (extracted.text.length <= maxChars) return extracted;
      return { ...extracted, text: clip(extracted.text, maxChars), truncated: true };
    }
    case 'spreadsheet': {
      const sheets = [];
      const omitted = [...(extracted.omitted ?? [])];
      let budget = maxChars;
      let truncated = extracted.truncated ?? false;
      for (const sheet of extracted.sheets) {
        if (budget <= 0) { omitted.push(omissionNote(sheet.name)); truncated = true; continue; }
        if (sheet.csv.length <= budget) {
          sheets.push(sheet);
          budget -= sheet.csv.length;
          continue;
        }
        const csv = clip(sheet.csv, budget);
        sheets.push({ ...sheet, csv, rows: csv.split('\n').length, truncated: true });
        budget = 0;
        truncated = true;
      }
      return {
        ...extracted, sheets, truncated,
        ...(omitted.length ? { omitted } : {}),
      };
    }
    case 'presentation': {
      const slides = [];
      const omitted = [...(extracted.omitted ?? [])];
      let budget = maxChars;
      let truncated = extracted.truncated ?? false;
      for (const slide of extracted.slides) {
        const size = slide.text.length + (slide.notes?.length ?? 0);
        if (budget <= 0) { omitted.push(omissionNote(`slide ${slide.number}`)); truncated = true; continue; }
        if (size <= budget) { slides.push(slide); budget -= size; continue; }
        slides.push({ ...slide, text: clip(slide.text, budget), notes: undefined });
        budget = 0;
        truncated = true;
      }
      return { ...extracted, slides, truncated, ...(omitted.length ? { omitted } : {}) };
    }
    case 'pdf': {
      const pages = [];
      const omitted = [...(extracted.omitted ?? [])];
      let budget = maxChars;
      let truncated = extracted.truncated ?? false;
      for (const page of extracted.pages) {
        if (budget <= 0) { omitted.push(omissionNote(`page ${page.number}`)); truncated = true; continue; }
        if (page.text.length <= budget) { pages.push(page); budget -= page.text.length; continue; }
        pages.push({ ...page, text: clip(page.text, budget) });
        budget = 0;
        truncated = true;
      }
      return { ...extracted, pages, truncated, ...(omitted.length ? { omitted } : {}) };
    }
  }
}

export interface ExtractOptions {
  /** Ceiling on extracted characters. Over it, content is clipped and flagged. */
  maxChars?: number;
  /** Sheet/slide/page selection, e.g. `"1-2"` or `"2026"`. */
  parts?: string;
}

/** Default response budget: roughly 12k tokens of extracted text. */
export const DEFAULT_MAX_CHARS = 50_000;

function decodeText(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Extract readable content from an attachment, or return null when the format
 * has no extractor (a .zip, a .heic, an unknown binary) and the caller should
 * fall through to the next rung of the delivery ladder.
 *
 * Throws when a format that SHOULD be extractable cannot be read, so the
 * failure can be reported by name rather than swallowed.
 */
export async function extractAttachment(
  bytes: Buffer, mimeType: string, fileName: string, opts: ExtractOptions = {},
): Promise<Extracted | null> {
  const kind = extractKindFor(mimeType, fileName);
  if (kind === null) return null;
  const select = opts.parts === undefined ? undefined : parsePartSpec(opts.parts);

  let extracted: Extracted;
  switch (kind) {
    case 'xlsx': extracted = await extractXlsx(bytes, { select }); break;
    case 'csv': extracted = extractDelimited(decodeText(bytes), fileName, ','); break;
    case 'tsv': extracted = extractDelimited(decodeText(bytes), fileName, '\t'); break;
    case 'docx': extracted = await extractDocx(bytes); break;
    case 'pptx': extracted = await extractPptx(bytes, { select }); break;
    case 'pdf': extracted = await extractPdf(bytes, { select }); break;
    case 'text': extracted = { kind: 'text', text: decodeText(bytes) }; break;
  }
  return applyCharBudget(extracted, opts.maxChars ?? DEFAULT_MAX_CHARS);
}
