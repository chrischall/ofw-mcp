import { describe, it, expect } from 'vitest';
import {
  extractAttachment, extractKindFor, parsePartSpec, applyCharBudget, DEFAULT_MAX_CHARS,
} from '../../src/extract/index.js';
import type { Extracted } from '../../src/extract/types.js';
import { makeXlsx, xlsxSheetData, makeDocx, makePptx } from './_ooxml.js';
import { makePdf, showText } from './_pdf.js';
import { makeZip } from './_zip.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('extractKindFor', () => {
  it('maps the office MIME types', () => {
    expect(extractKindFor(XLSX_MIME, 'x.bin')).toBe('xlsx');
    expect(extractKindFor('application/pdf', 'x.bin')).toBe('pdf');
    expect(extractKindFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x')).toBe('docx');
    expect(extractKindFor('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'x')).toBe('pptx');
  });

  it('falls back to the file extension when the MIME type is useless', () => {
    expect(extractKindFor('application/octet-stream', 'Schedule.XLSX')).toBe('xlsx');
    expect(extractKindFor('application/octet-stream', 'notes.md')).toBe('text');
    expect(extractKindFor('application/octet-stream', 'data.tsv')).toBe('tsv');
  });

  it('treats any other text/* type as text', () => {
    expect(extractKindFor('text/plain', 'memo')).toBe('text');
    expect(extractKindFor('text/markdown', 'memo')).toBe('text');
  });

  it('returns null for a format with no extractor', () => {
    expect(extractKindFor('application/zip', 'archive.zip')).toBeNull();
    expect(extractKindFor('image/heic', 'photo.heic')).toBeNull();
    expect(extractKindFor('application/octet-stream', 'no-extension')).toBeNull();
    // Legacy binary Office formats are not OOXML and have no extractor here.
    expect(extractKindFor('application/msword', 'old.doc')).toBeNull();
  });
});

describe('parsePartSpec', () => {
  it('selects by 1-based position and range', () => {
    const select = parsePartSpec('1-2,4');
    expect([0, 1, 2, 3].map((i) => select(i, `p${i}`))).toEqual([true, true, false, true]);
  });

  it('selects by name, case-insensitively', () => {
    const select = parsePartSpec('Summary');
    expect(select(9, 'summary')).toBe(true);
    expect(select(9, 'Other')).toBe(false);
  });

  it('treats a bare number as a position OR a name, so a "2026" tab is reachable', () => {
    const select = parsePartSpec('2026');
    expect(select(0, '2026')).toBe(true); // matched by name
    expect(select(2025, 'anything')).toBe(true); // matched by position
    expect(select(0, '2027')).toBe(false);
  });

  it('selects everything for an empty or blank spec', () => {
    expect(parsePartSpec('')(5, 'x')).toBe(true);
    expect(parsePartSpec('  , ')(5, 'x')).toBe(true);
  });
});

describe('applyCharBudget', () => {
  it('leaves an extraction that fits alone', () => {
    const input: Extracted = { kind: 'text', text: 'short' };
    expect(applyCharBudget(input, 100)).toBe(input);
  });

  it('clips text on a line boundary and flags it', () => {
    const input: Extracted = { kind: 'document', text: 'line one\nline two\nline three' };
    const out = applyCharBudget(input, 20);
    expect(out).toMatchObject({ text: 'line one\nline two', truncated: true });
  });

  it('clips mid-line when there is no line boundary to fall back on', () => {
    const out = applyCharBudget({ kind: 'text', text: 'abcdefghij' }, 4);
    expect(out).toMatchObject({ text: 'abcd', truncated: true });
  });

  it('keeps whole sheets, clips the one that straddles the budget, omits the rest', () => {
    const input: Extracted = {
      kind: 'spreadsheet',
      sheets: [
        { name: 'A', rows: 1, cols: 1, csv: '12345' },
        { name: 'B', rows: 3, cols: 1, csv: 'aaaa\nbbbb\ncccc' },
        { name: 'C', rows: 1, cols: 1, csv: 'zzzz' },
      ],
    };
    const out = applyCharBudget(input, 15);
    expect(out.kind === 'spreadsheet' && out.sheets.map((s) => s.name)).toEqual(['A', 'B']);
    expect(out.kind === 'spreadsheet' && out.sheets[1]).toMatchObject({ csv: 'aaaa\nbbbb', rows: 2, truncated: true });
    expect(out.truncated).toBe(true);
    expect(out.kind === 'spreadsheet' && out.omitted).toEqual(['C (omitted: response character budget)']);
  });

  it('reports zero rows when the budget leaves no complete row', () => {
    const input: Extracted = {
      kind: 'spreadsheet',
      sheets: [{ name: 'A', rows: 2, cols: 1, csv: 'aaaaaaaa\nbbbb' }],
    };
    const out = applyCharBudget(input, 0);
    expect(out.kind === 'spreadsheet' && out.sheets).toEqual([]);
    expect(out.kind === 'spreadsheet' && out.omitted).toEqual(['A (omitted: response character budget)']);
  });

  it('preserves omissions the extractor already recorded', () => {
    const input: Extracted = {
      kind: 'spreadsheet',
      sheets: [{ name: 'A', rows: 1, cols: 1, csv: 'x' }],
      omitted: ['Hidden'],
      truncated: true,
    };
    const out = applyCharBudget(input, 100);
    expect(out.kind === 'spreadsheet' && out.omitted).toEqual(['Hidden']);
    expect(out.truncated).toBe(true);
  });

  it('trims slides and drops their notes when the budget runs out', () => {
    const input: Extracted = {
      kind: 'presentation',
      slides: [
        { number: 1, text: 'first', notes: 'note one' },
        { number: 2, text: 'second slide text', notes: 'note two' },
        { number: 3, text: 'third' },
      ],
    };
    const out = applyCharBudget(input, 20);
    expect(out.kind === 'presentation' && out.slides.map((s) => s.number)).toEqual([1, 2]);
    expect(out.kind === 'presentation' && out.slides[1].notes).toBeUndefined();
    expect(out.kind === 'presentation' && out.omitted).toEqual(['slide 3 (omitted: response character budget)']);
    expect(out.truncated).toBe(true);
  });

  it('trims pages and records the omitted ones', () => {
    const input: Extracted = {
      kind: 'pdf',
      textLayer: true,
      pages: [
        { number: 1, text: 'page one' },
        { number: 2, text: 'page two is longer' },
        { number: 3, text: 'page three' },
      ],
    };
    const out = applyCharBudget(input, 12);
    expect(out.kind === 'pdf' && out.pages.map((p) => p.number)).toEqual([1, 2]);
    expect(out.kind === 'pdf' && out.pages[1].text).toBe('page');
    expect(out.kind === 'pdf' && out.omitted).toEqual(['page 3 (omitted: response character budget)']);
  });

  it('leaves a presentation and a PDF that fit untouched', () => {
    const slides: Extracted = { kind: 'presentation', slides: [{ number: 1, text: 'a', notes: 'b' }] };
    expect(applyCharBudget(slides, 100)).toMatchObject({ truncated: false });
    const pdf: Extracted = { kind: 'pdf', textLayer: true, pages: [{ number: 1, text: 'a' }] };
    expect(applyCharBudget(pdf, 100)).toMatchObject({ truncated: false });
  });
});

describe('extractAttachment', () => {
  it('extracts an .xlsx workbook end to end (repro: a holiday-schedule attachment)', async () => {
    const bytes = makeXlsx({
      sharedStrings: ['Holiday', 'Parent'],
      sheets: [{
        name: '2026',
        rows: xlsxSheetData([
          [{ ref: 'A1', t: 's', v: '0' }, { ref: 'B1', t: 's', v: '1' }],
          [{ ref: 'A2', t: 'inlineStr', inner: '<is><t>Thanksgiving</t></is>' }, { ref: 'B2', t: 'inlineStr', inner: '<is><t>Mother</t></is>' }],
        ]),
      }],
    });
    const out = await extractAttachment(bytes, XLSX_MIME, 'Hall_Holiday_Schedules_2026_-_2027.xlsx');
    expect(out).toMatchObject({
      kind: 'spreadsheet',
      sheets: [{ name: '2026', rows: 2, cols: 2, csv: 'Holiday,Parent\nThanksgiving,Mother' }],
      truncated: false,
    });
  });

  it('passes a part spec through to the sheet selector', async () => {
    const bytes = makeXlsx({
      sheets: [
        { name: '2026', rows: xlsxSheetData([[{ ref: 'A1', v: '1' }]]) },
        { name: '2027', rows: xlsxSheetData([[{ ref: 'A1', v: '2' }]]) },
      ],
    });
    const out = await extractAttachment(bytes, XLSX_MIME, 'x.xlsx', { parts: '2027' });
    expect(out).toMatchObject({ sheets: [{ name: '2027' }], omitted: ['2026'] });
  });

  it('honours maxChars', async () => {
    const bytes = makeXlsx({
      sheets: [{ name: 'S', rows: xlsxSheetData([[{ ref: 'A1', v: '111111' }], [{ ref: 'A2', v: '222222' }]]) }],
    });
    const out = await extractAttachment(bytes, XLSX_MIME, 'x.xlsx', { maxChars: 7 });
    expect(out?.truncated).toBe(true);
  });

  it('extracts CSV and TSV', async () => {
    const csv = await extractAttachment(Buffer.from('a,b\n1,2'), 'text/csv', 'x.csv');
    expect(csv).toMatchObject({ sheets: [{ name: 'x.csv', rows: 2, cols: 2, csv: 'a,b\n1,2' }] });
    const tsv = await extractAttachment(Buffer.from('a\tb'), 'application/octet-stream', 'x.tsv');
    expect(tsv).toMatchObject({ sheets: [{ csv: 'a,b' }] });
  });

  it('decodes plain text and strips a UTF-8 BOM', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo', 'utf8')]);
    expect(await extractAttachment(bytes, 'text/plain', 'memo.txt')).toEqual({ kind: 'text', text: 'héllo' });
  });

  it('extracts a .docx and a .pptx', async () => {
    const docx = await extractAttachment(
      makeDocx('<w:p><w:r><w:t>Agreed terms</w:t></w:r></w:p>'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'terms.docx',
    );
    expect(docx).toMatchObject({ kind: 'document', text: 'Agreed terms' });

    const pptx = await extractAttachment(
      makePptx([{ paragraphs: ['Deck title'], notes: ['say hello'] }]),
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx',
    );
    expect(pptx).toMatchObject({ kind: 'presentation', slides: [{ number: 1, text: 'Deck title', notes: 'say hello' }] });
  });

  it('extracts a PDF text layer', async () => {
    const out = await extractAttachment(
      makePdf({ pages: [showText('Proposed parenting time')], compress: true }),
      'application/pdf', 'proposal.pdf',
    );
    expect(out).toMatchObject({ kind: 'pdf', textLayer: true, pages: [{ number: 1, text: 'Proposed parenting time' }] });
  });

  it('returns null for a format with no extractor so the caller can fall through', async () => {
    expect(await extractAttachment(makeZip([{ name: 'a', data: 'b' }]), 'application/zip', 'a.zip')).toBeNull();
  });

  it('propagates an extraction failure instead of pretending the file was empty', async () => {
    await expect(extractAttachment(Buffer.from('not a zip'), XLSX_MIME, 'broken.xlsx'))
      .rejects.toThrow(/not a ZIP/i);
  });

  it('exposes a default character budget', () => {
    expect(DEFAULT_MAX_CHARS).toBeGreaterThan(1000);
  });
});
