// PDF text-layer extraction.
//
// A PDF has no "text" — it has content streams full of positioning operators
// that draw glyphs. This reads the text-showing operators (Tj/TJ/'/") out of
// each page's content stream and reassembles a readable transcript. It is not
// a renderer: exotic font encodings without a ToUnicode map will come back as
// mojibake, and column layout is approximated by line breaks.
//
// What it must never do is fail silently. A scanned PDF has no text layer at
// all, and the honest answer for one is `textLayer: false` plus a note saying
// it needs OCR — not an empty string that reads like an empty document.

import {
  inflateBounded, DecompressionLimitError, MAX_DECOMPRESSED_BYTES,
} from './inflate.js';
import type { PdfExtract, PageExtract, PartSelector } from './types.js';

export interface PdfOptions {
  select?: PartSelector;
}

interface PdfObject {
  num: number;
  /** Object body as latin1 text — indices line up 1:1 with byte offsets. */
  body: string;
  /** Absolute byte offset of the body's start within the file. */
  start: number;
}

const OBJ_HEADER = /(\d+)\s+\d+\s+obj\b/g;

function parseObjects(text: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  for (let m = OBJ_HEADER.exec(text); m !== null; m = OBJ_HEADER.exec(text)) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endobj', start);
    objects.set(Number(m[1]), {
      num: Number(m[1]),
      body: text.slice(start, end === -1 ? undefined : end),
      start,
    });
  }
  OBJ_HEADER.lastIndex = 0;
  return objects;
}

/** Object numbers referenced by `N 0 R` tokens in a fragment. */
function refsIn(fragment: string): number[] {
  return [...fragment.matchAll(/(\d+)\s+\d+\s+R\b/g)].map((m) => Number(m[1]));
}

/**
 * Page objects in reading order: walk the catalog's page tree when it
 * resolves, otherwise fall back to the order the page objects appear in the
 * file (which matches reading order for any linearly-written PDF).
 */
function orderedPages(objects: Map<number, PdfObject>): PdfObject[] {
  const isPage = (o: PdfObject): boolean => /\/Type\s*\/Page[^s]/.test(o.body);
  const inFileOrder = [...objects.values()].filter(isPage).sort((a, b) => a.start - b.start);

  const catalog = [...objects.values()].find((o) => /\/Type\s*\/Catalog/.test(o.body));
  const rootRef = catalog ? refsIn(/\/Pages\s+[^/>]*/.exec(catalog.body)?.[0] ?? '')[0] : undefined;
  if (rootRef === undefined) return inFileOrder;

  const ordered: PdfObject[] = [];
  const seen = new Set<number>();
  const walk = (num: number): void => {
    // A malformed (or hostile) page tree can contain a cycle; visiting each
    // object at most once bounds the walk without rejecting the document.
    if (seen.has(num)) return;
    seen.add(num);
    const obj = objects.get(num);
    if (!obj) return;
    if (isPage(obj)) { ordered.push(obj); return; }
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(obj.body)?.[1];
    if (kids) for (const kid of refsIn(kids)) walk(kid);
  };
  walk(rootRef);
  return ordered.length > 0 ? ordered : inFileOrder;
}

/** Raw (still-encoded) bytes of a stream object, or null when it has none. */
function streamBytes(bytes: Buffer, obj: PdfObject): Buffer | null {
  const marker = /stream\r?\n/.exec(obj.body);
  if (!marker) return null;
  const from = obj.start + marker.index + marker[0].length;
  // /Length is frequently an indirect reference, so the end-of-stream marker is
  // the reliable boundary; a direct numeric /Length is used when present.
  const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(obj.body);
  if (declared) return bytes.subarray(from, from + Number(declared[1]));
  const end = bytes.indexOf('endstream', from, 'latin1');
  return bytes.subarray(from, end === -1 ? undefined : end);
}

/** Decode a stream's bytes, honouring FlateDecode. Null for filters we can't read. */
async function decodeStream(bytes: Buffer, obj: PdfObject): Promise<Buffer | null> {
  const raw = streamBytes(bytes, obj);
  if (!raw) return null;
  const filter = /\/Filter\s*(\/\w+|\[[^\]]*\])/.exec(obj.body)?.[1] ?? '';
  if (filter === '') return raw;
  if (!filter.includes('FlateDecode')) return null; // LZW/DCT/JPX: not text anyway
  try {
    // PDF stream dictionaries say nothing about inflated length, so the cap is
    // the only thing standing between a crafted stream and the memory budget.
    return await inflateBounded(raw, 'deflate', MAX_DECOMPRESSED_BYTES, 'PDF stream');
  } catch (err) {
    // A truncated or mis-bounded stream must not take the whole document down;
    // the page simply contributes no text. A cap breach is different in kind —
    // that is a hostile or absurd file, and silently returning a document with
    // pages quietly missing would be the worse answer.
    if (err instanceof DecompressionLimitError) throw err;
    return null;
  }
}

/** Read a PDF literal string starting at `text[i]` === '(' — returns its end index. */
function readLiteral(text: string, i: number): { value: string; next: number } {
  let value = '';
  let depth = 1;
  let p = i + 1;
  for (; p < text.length; p++) {
    const ch = text[p];
    if (ch === '\\') {
      const esc = text[++p];
      const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      if (simple[esc]) { value += simple[esc]; continue; }
      const octal = /^[0-7]{1,3}/.exec(text.slice(p, p + 3))?.[0];
      if (octal) { value += String.fromCharCode(parseInt(octal, 8)); p += octal.length - 1; continue; }
      if (esc === '\n') continue; // line continuation
      value += esc;
      continue;
    }
    if (ch === '(') { depth++; value += ch; continue; }
    if (ch === ')') {
      depth--;
      if (depth === 0) break;
      value += ch;
      continue;
    }
    value += ch;
  }
  return { value, next: p };
}

/** Decode a `<...>` hex string, as UTF-16BE when it looks like one. */
function decodeHexString(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const buf = Buffer.from(padded, 'hex');
  if (buf.length >= 2 && buf.length % 2 === 0 && buf[0] === 0xfe && buf[1] === 0xff) {
    return buf.subarray(2).swap16().toString('utf16le');
  }
  // Simple CID fonts emit 2-byte codes whose high byte is zero; reading those
  // as latin1 would interleave NULs through every word.
  if (buf.length % 2 === 0 && buf.length > 0 && buf.every((b, i) => i % 2 === 1 || b === 0)) {
    return buf.swap16().toString('utf16le');
  }
  return buf.toString('latin1');
}

/**
 * Pull the shown text out of a content stream. Text-positioning operators
 * become line breaks, and the wide negative kerns inside a TJ array become
 * spaces (that is how most producers encode an inter-word gap).
 */
export function textFromContentStream(content: string): string {
  let out = '';
  let pending = '';
  let arrayDepth = 0;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '(') {
      const { value, next } = readLiteral(content, i);
      pending += value;
      i = next;
      continue;
    }
    // `<<` opens a dictionary (marked-content properties, inline images).
    // Skipping both angle brackets keeps the dictionary's own text from being
    // read as a hex string.
    if (ch === '<' && content[i + 1] === '<') { i++; continue; }
    if (ch === '<') {
      const end = content.indexOf('>', i);
      if (end === -1) break;
      pending += decodeHexString(content.slice(i + 1, end));
      i = end;
      continue;
    }
    if (ch === '[') { arrayDepth++; continue; }
    if (ch === ']') { arrayDepth = 0; continue; }
    if (arrayDepth > 0 && (ch === '-' || (ch >= '0' && ch <= '9'))) {
      const num = /^-?\d+(\.\d+)?/.exec(content.slice(i));
      /* v8 ignore next -- the leading char already guarantees a match */
      if (!num) continue;
      if (Number(num[0]) <= -100) pending += ' ';
      i += num[0].length - 1;
      continue;
    }
    if (/[A-Za-z'"*]/.test(ch)) {
      /* v8 ignore next -- the character class above guarantees this regex matches */
      const op = /^[A-Za-z*]+|^['"]/.exec(content.slice(i))?.[0] ?? ch;
      i += op.length - 1;
      if (op === 'Tj' || op === 'TJ') { out += pending; pending = ''; continue; }
      if (op === "'" || op === '"') { out += `\n${pending}`; pending = ''; continue; }
      if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'ET') { out += '\n'; continue; }
    }
  }
  return out;
}

/** Collapse the runs of blank lines that positioning operators leave behind. */
function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Extract the text layer of a PDF, page by page. */
export async function extractPdf(bytes: Buffer, opts: PdfOptions = {}): Promise<PdfExtract> {
  const text = bytes.toString('latin1');
  if (/\/Encrypt\b/.test(text)) {
    throw new Error('the PDF is encrypted; its text cannot be extracted');
  }
  const objects = parseObjects(text);
  const pageObjects = orderedPages(objects);
  if (pageObjects.length === 0) throw new Error('no pages found in the PDF');

  const pages: PageExtract[] = [];
  const omitted: string[] = [];
  for (let i = 0; i < pageObjects.length; i++) {
    const number = i + 1;
    if (opts.select && !opts.select(i, `page ${number}`)) {
      omitted.push(`page ${number}`);
      continue;
    }
    const contentsFragment = /\/Contents\s*(\d+\s+\d+\s+R|\[[^\]]*\])/.exec(pageObjects[i].body)?.[1] ?? '';
    let raw = '';
    for (const ref of refsIn(contentsFragment)) {
      const streamObj = objects.get(ref);
      if (!streamObj) continue;
      const decoded = await decodeStream(bytes, streamObj);
      if (decoded) raw += `${decoded.toString('latin1')}\n`;
    }
    pages.push({ number, text: tidy(textFromContentStream(raw)) });
  }

  const textLayer = pages.some((p) => p.text !== '');
  return {
    kind: 'pdf',
    pages,
    textLayer,
    ...(textLayer ? {} : {
      note: 'This PDF has no extractable text layer — it is most likely a scan or an image-only export. Reading it requires OCR, which this server does not perform.',
    }),
    ...(omitted.length ? { omitted } : {}),
  };
}
