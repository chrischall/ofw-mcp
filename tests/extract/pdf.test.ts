import { describe, it, expect } from 'vitest';
import { extractPdf, textFromContentStream } from '../../src/extract/pdf.js';
import { makePdf, showText } from './_pdf.js';

describe('extractPdf', () => {
  it('extracts text from an uncompressed content stream, page by page', async () => {
    const out = await extractPdf(makePdf({ pages: [showText('Page one text'), showText('Page two text')] }));
    expect(out.kind).toBe('pdf');
    expect(out.textLayer).toBe(true);
    expect(out.pages).toEqual([
      { number: 1, text: 'Page one text' },
      { number: 2, text: 'Page two text' },
    ]);
    expect(out.note).toBeUndefined();
  });

  it('inflates a FlateDecode content stream', async () => {
    const out = await extractPdf(makePdf({ pages: [showText('Compressed body')], compress: true }));
    expect(out.pages[0].text).toBe('Compressed body');
  });

  it('falls back to file order when there is no catalog to walk', async () => {
    const out = await extractPdf(makePdf({ pages: [showText('first'), showText('second')], noCatalog: true }));
    expect(out.pages.map((p) => p.text)).toEqual(['first', 'second']);
  });

  it('refuses an encrypted PDF with a specific message', async () => {
    await expect(extractPdf(makePdf({ pages: [showText('x')], encrypt: true })))
      .rejects.toThrow(/encrypted/i);
  });

  it('rejects a PDF with no page objects', async () => {
    await expect(extractPdf(Buffer.from('%PDF-1.7\ntrailer\n<< >>\n%%EOF')))
      .rejects.toThrow(/no pages/i);
  });

  it('reports a scanned PDF as having no text layer, with an OCR note', async () => {
    // A page whose content stream draws only an image.
    const out = await extractPdf(makePdf({ pages: ['q 612 0 0 792 0 0 cm /Im0 Do Q'] }));
    expect(out.textLayer).toBe(false);
    expect(out.pages[0].text).toBe('');
    expect(out.note).toMatch(/OCR/);
  });

  it('yields no text for a filter it cannot decode', async () => {
    const out = await extractPdf(makePdf({ pages: [showText('hidden')], filter: '/LZWDecode' }));
    expect(out.pages[0].text).toBe('');
  });

  it('survives a corrupt FlateDecode stream instead of failing the document', async () => {
    const out = await extractPdf(makePdf({ pages: [showText('unreadable')], corrupt: true }));
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0].text).toBe('');
  });

  it('skips a /Contents reference that points at a missing object', async () => {
    const out = await extractPdf(makePdf({ pages: [showText('gone')], danglingContents: true }));
    expect(out.pages[0].text).toBe('');
  });

  it('skips pages the caller did not select and records them as omitted', async () => {
    const pdf = makePdf({ pages: [showText('one'), showText('two'), showText('three')] });
    const out = await extractPdf(pdf, { select: (i) => i === 2 });
    expect(out.pages).toEqual([{ number: 3, text: 'three' }]);
    expect(out.omitted).toEqual(['page 1', 'page 2']);
  });

  it('terminates on a page tree that references itself', async () => {
    const pdf = Buffer.from(
      '%PDF-1.7\n'
      + '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
      + '2 0 obj\n<< /Type /Pages /Kids [2 0 R 3 0 R] >>\nendobj\n'
      + `3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n`
      + `4 0 obj\n<< /Length 40 >>\nstream\n${showText('looped')}\nendstream\nendobj\n`,
      'latin1',
    );
    const out = await extractPdf(pdf);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0].text).toBe('looped');
  });

  it('falls back to file order when the page tree resolves to nothing', async () => {
    const pdf = Buffer.from(
      '%PDF-1.7\n'
      + '1 0 obj\n<< /Type /Catalog /Pages 7 0 R >>\nendobj\n' // 7 does not exist
      + '3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n'
      + `4 0 obj\n<< >>\nstream\n${showText('orphan')}\nendstream\nendobj\n`,
      'latin1',
    );
    expect((await extractPdf(pdf)).pages[0].text).toBe('orphan');
  });

  it('falls back to file order when the catalog names no page tree', async () => {
    const pdf = Buffer.from(
      '%PDF-1.7\n'
      + '1 0 obj\n<< /Type /Catalog >>\nendobj\n'
      + '3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n'
      + `4 0 obj\n<< >>\nstream\n${showText('no tree')}\nendstream\nendobj\n`,
      'latin1',
    );
    expect((await extractPdf(pdf)).pages[0].text).toBe('no tree');
  });

  it('yields no text for a page object with no /Contents entry at all', async () => {
    const pdf = Buffer.from('%PDF-1.7\n3 0 obj\n<< /Type /Page >>\nendobj\n', 'latin1');
    const out = await extractPdf(pdf);
    expect(out.pages).toEqual([{ number: 1, text: '' }]);
    expect(out.textLayer).toBe(false);
  });

  it('reads a stream that has no endstream marker and an object with no endobj', async () => {
    const pdf = Buffer.from(
      '%PDF-1.7\n'
      + '3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n'
      + `4 0 obj\n<< >>\nstream\n${showText('unterminated')}`,
      'latin1',
    );
    expect((await extractPdf(pdf)).pages[0].text).toBe('unterminated');
  });

  it('yields no text for a page object that carries no content stream', async () => {
    const pdf = Buffer.from(
      '%PDF-1.7\n'
      + '3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n'
      + '4 0 obj\n<< /Nothing true >>\nendobj\n',
      'latin1',
    );
    expect((await extractPdf(pdf)).pages[0].text).toBe('');
  });
});

describe('textFromContentStream', () => {
  it('turns a wide negative kern inside a TJ array into a space', () => {
    expect(textFromContentStream('BT [(Holiday)-500(Schedule)] TJ ET'))
      .toBe('Holiday Schedule\n');
  });

  it('skips whitespace and reads fractional kerns inside a TJ array', () => {
    expect(textFromContentStream('BT [ (Holiday) -500.25 (Schedule) ] TJ ET'))
      .toBe('Holiday Schedule\n');
  });

  it('recovers when a TJ array is never closed', () => {
    // Malformed stream: no "]" before the operator. The text still comes back.
    expect(textFromContentStream('BT [(a)-500(b) TJ ET')).toBe('a b\n');
  });

  it('keeps a narrow kern from inventing a space', () => {
    expect(textFromContentStream('BT [(Hol)-20(iday)] TJ ET')).toBe('Holiday\n');
  });

  it('decodes literal-string escapes, octal codes and nested parentheses', () => {
    expect(textFromContentStream(String.raw`BT (a\(b\)c \164 \\ (nested) \n x) Tj ET`))
      .toBe('a(b)c t \\ (nested) \n x\n');
  });

  it('honours a backslash line continuation', () => {
    expect(textFromContentStream('BT (one\\\ntwo) Tj ET')).toBe('onetwo\n');
  });

  it("treats ' and \" as newline-then-show operators", () => {
    expect(textFromContentStream(`BT (first) Tj (second) ' (third) " ET`))
      .toBe('first\nsecond\nthird\n');
  });

  it('decodes a UTF-16BE hex string with a byte-order mark', () => {
    const hex = Buffer.from('﻿Hi', 'utf16le').swap16().toString('hex');
    expect(textFromContentStream(`BT <${hex}> Tj ET`)).toBe('Hi\n');
  });

  it('decodes a two-byte CID hex string whose high bytes are zero', () => {
    expect(textFromContentStream('BT <00480065006c006c006f> Tj ET')).toBe('Hello\n');
  });

  it('reads a single-byte hex string as latin1 and pads an odd digit count', () => {
    expect(textFromContentStream('BT <414243> Tj ET')).toBe('ABC\n');
    expect(textFromContentStream('BT <41424> Tj ET')).toBe('AB@\n');
  });

  it('stops at an unterminated hex string instead of scanning to the end', () => {
    expect(textFromContentStream('BT (kept) Tj <0048')).toBe('kept');
  });

  it('ignores dictionary markers and inline positioning operators', () => {
    expect(textFromContentStream('BT /P <</MCID 0>> BDC (line one) Tj T* (line two) Tj EMC ET'))
      .toBe('line one\nline two\n');
  });

  it('returns an empty string for a stream that shows no text', () => {
    expect(textFromContentStream('q 1 0 0 1 0 0 cm /Im0 Do Q')).toBe('');
  });
});
