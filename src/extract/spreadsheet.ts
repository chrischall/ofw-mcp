// Spreadsheet extraction: .xlsx/.xlsm (OOXML) and .csv/.tsv (delimited text).
//
// Both land on the same shape — a list of named sheets with a CSV rendering —
// so a caller reading a custody schedule does not care which one arrived.
//
// The values written out are Excel's own CACHED results: a formula cell stores
// both `<f>` (the formula) and `<v>` (what it last evaluated to), and `<v>` is
// what the co-parent saw on screen. Dates are the other translation that
// matters — Excel stores them as bare serial numbers, so a schedule extracted
// without style lookup reads as a column of five-digit integers.

import { readZip, type ZipArchive } from './zip.js';
import { elements, attr, textOf } from './xml.js';
import { readRels, findPart, dirOf, resolvePartPath } from './ooxml.js';
import type { SheetExtract, SpreadsheetExtract, PartSelector } from './types.js';

export interface SpreadsheetOptions {
  select?: PartSelector;
  /** Cell ceiling per sheet — bounds memory on a workbook with huge sheets. */
  maxCells?: number;
}

const DEFAULT_MAX_CELLS = 200_000;

// Built-in number formats that denote a date and/or time (ECMA-376 §18.8.30).
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Excel's serial-date epoch as a Unix-epoch offset, in days. */
const SERIAL_EPOCH_OFFSET = 25569;

/**
 * Convert an Excel serial number to an ISO string: `YYYY-MM-DD` for a whole
 * day, `…THH:MM:SS` when it carries a time, and `HH:MM:SS` for a time-only
 * value (serial < 1). Returns null when the serial is out of representable
 * range, so the caller can fall back to printing the raw number.
 */
export function excelSerialToIso(serial: number, date1904: boolean): string | null {
  // The 1904 system counts from a different epoch, exactly 1462 days later.
  const base = date1904 ? serial + 1462 : serial;
  // Excel's 1900 system contains a phantom 1900-02-29 (serial 60) inherited
  // from Lotus 1-2-3, so serials below it are one day ahead of real time.
  const corrected = Math.floor(base) < 60 ? base + 1 : base;
  const date = new Date(Math.round((corrected - SERIAL_EPOCH_OFFSET) * 86_400_000));
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  if (base < 1) return iso.slice(11, 19);
  return iso.slice(11, 19) === '00:00:00' ? iso.slice(0, 10) : iso.slice(0, 19);
}

/** True when a number format renders its value as a date or a time. */
function isDateFormat(numFmtId: number, formatCode: string | undefined): boolean {
  if (BUILTIN_DATE_FORMATS.has(numFmtId)) return true;
  if (!formatCode) return false;
  // Strip literals and colour/condition brackets before looking for date
  // tokens, so a currency format like [$-409]#,##0.00 is not read as a date.
  const bare = formatCode.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[ymdhs]/i.test(bare);
}

/** Column index (0-based) from a cell reference like `AA12`. */
function columnIndex(ref: string): number | null {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return null;
  let index = 0;
  for (const ch of m[1]) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** Quote a CSV field per RFC 4180 when it contains a delimiter, quote or newline. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(rows: string[][], cols: number): string {
  return rows
    .map((row) => Array.from({ length: cols }, (_, i) => csvField(row[i] ?? '')).join(','))
    .join('\n');
}

interface WorkbookStyles {
  /** numFmtId per cell-format (`s` attribute) index. */
  dateStyles: boolean[];
}

async function readStyles(zip: ZipArchive, dir: string): Promise<WorkbookStyles> {
  const xml = await zip.readText(`${dir}styles.xml`);
  if (!xml) return { dateStyles: [] };
  const custom = new Map<number, string>();
  for (const el of elements(xml, 'numFmt')) {
    const id = Number(attr(el.attrs, 'numFmtId'));
    const code = attr(el.attrs, 'formatCode');
    if (Number.isFinite(id) && code !== null) custom.set(id, code);
  }
  const dateStyles: boolean[] = [];
  // Only <cellXfs> maps the `s` attribute; <cellStyleXfs> uses the same <xf>
  // tag, so scan inside the cellXfs block rather than the whole part.
  for (const block of elements(xml, 'cellXfs')) {
    for (const xf of elements(block.inner, 'xf')) {
      const id = Number(attr(xf.attrs, 'numFmtId') ?? '0');
      dateStyles.push(isDateFormat(id, custom.get(id)));
    }
  }
  return { dateStyles };
}

async function readSharedStrings(zip: ZipArchive, dir: string): Promise<string[]> {
  const xml = await zip.readText(`${dir}sharedStrings.xml`);
  if (!xml) return [];
  // <si> may hold a single <t> or a sequence of <r> runs each with its own
  // <t>; concatenating every <t> handles both.
  return [...elements(xml, 'si')].map((si) => textOf(si.inner, 't'));
}

interface CellContext {
  shared: string[];
  styles: WorkbookStyles;
  date1904: boolean;
}

function cellValue(attrs: string, inner: string, ctx: CellContext): string {
  const type = attr(attrs, 't') ?? 'n';
  if (type === 'inlineStr') return textOf(inner, 't');
  const raw = textOf(inner, 'v');
  switch (type) {
    case 's': {
      const index = Number(raw);
      return ctx.shared[index] ?? '';
    }
    case 'b':
      return raw === '1' ? 'TRUE' : 'FALSE';
    case 'str':
    case 'e':
      return raw;
    default: {
      const styleIndex = Number(attr(attrs, 's') ?? '-1');
      const numeric = Number(raw);
      if (ctx.styles.dateStyles[styleIndex] && raw !== '' && Number.isFinite(numeric)) {
        return excelSerialToIso(numeric, ctx.date1904) ?? raw;
      }
      return raw;
    }
  }
}

function parseSheet(xml: string, name: string, ctx: CellContext, maxCells: number): SheetExtract {
  const rows: string[][] = [];
  let cols = 0;
  let cells = 0;
  let truncated = false;
  for (const row of elements(xml, 'row')) {
    if (cells >= maxCells) {
      truncated = true;
      break;
    }
    const values: string[] = [];
    for (const cell of elements(row.inner, 'c')) {
      const ref = attr(cell.attrs, 'r');
      const index = ref === null ? null : columnIndex(ref);
      // A cell with no usable reference cannot be placed in a column; dropping
      // it is better than shifting every later value in the row.
      if (index === null) continue;
      values[index] = cellValue(cell.attrs, cell.inner, ctx);
      cells++;
      if (index + 1 > cols) cols = index + 1;
    }
    rows.push(values);
  }
  return { name, rows: rows.length, cols, csv: toCsv(rows, cols), ...(truncated ? { truncated } : {}) };
}

/** Extract every (selected) sheet of an .xlsx/.xlsm workbook. */
export async function extractXlsx(
  bytes: Buffer, opts: SpreadsheetOptions = {},
): Promise<SpreadsheetExtract> {
  const zip = await readZip(bytes);
  const workbookPath = findPart(zip, 'xl/workbook.xml', 'workbook.xml');
  if (!workbookPath) throw new Error('no workbook part found in the .xlsx archive');
  const dir = dirOf(workbookPath);
  /* v8 ignore next -- findPart only returns a name the archive contains, so readText cannot be null here */
  const workbookXml = (await zip.readText(workbookPath)) ?? '';

  const rels = await readRels(zip, workbookPath);
  const targetById = new Map(rels.map((r) => [r.id, r.target]));
  const ctx: CellContext = {
    shared: await readSharedStrings(zip, dir),
    styles: await readStyles(zip, dir),
    date1904: /<workbookPr[^>]*date1904="(1|true)"/i.test(workbookXml),
  };
  const maxCells = opts.maxCells ?? DEFAULT_MAX_CELLS;

  const sheets: SheetExtract[] = [];
  const omitted: string[] = [];
  let index = 0;
  for (const el of elements(workbookXml, 'sheet')) {
    const position = index++;
    const name = attr(el.attrs, 'name') ?? `Sheet${position + 1}`;
    if (opts.select && !opts.select(position, name)) {
      omitted.push(name);
      continue;
    }
    const relId = attr(el.attrs, 'r:id') ?? attr(el.attrs, 'id');
    // Fall back to the conventional positional path when the rels are absent
    // or do not name this sheet — some producers omit them entirely.
    const path = (relId && targetById.get(relId))
      ?? resolvePartPath(dir, `worksheets/sheet${position + 1}.xml`);
    const xml = await zip.readText(path);
    if (xml === null) {
      omitted.push(`${name} (sheet part not found in the workbook)`);
      continue;
    }
    sheets.push(parseSheet(xml, name, ctx, maxCells));
  }

  const truncated = sheets.some((s) => s.truncated);
  return {
    kind: 'spreadsheet',
    sheets,
    ...(omitted.length ? { omitted } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

/** Parse delimiter-separated text (RFC 4180 quoting) into rows of fields. */
function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let dirty = false; // distinguishes a trailing newline from a trailing empty row

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; dirty = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; dirty = true; continue; }
    if (ch === '\r') continue; // CRLF: the \n does the work
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = []; field = ''; dirty = false;
      continue;
    }
    field += ch;
    dirty = true;
  }
  if (dirty || field !== '') {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Extract .csv/.tsv text as a single-sheet spreadsheet. */
export function extractDelimited(
  text: string, name: string, delimiter: string,
): SpreadsheetExtract {
  const rows = parseDelimitedRows(text, delimiter);
  const cols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  return {
    kind: 'spreadsheet',
    sheets: [{ name, rows: rows.length, cols, csv: toCsv(rows, cols) }],
  };
}
