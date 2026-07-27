import { describe, it, expect } from 'vitest';
import { extractAttachment } from '../src/extract/index.js';
import { makeXlsx, xlsxSheetData } from './extract/_ooxml.js';
import { makePdf, showText } from './extract/_pdf.js';

// The reported failure was on the HOSTED connector, so the extraction layer has
// to work inside workerd, not just Node. The thing that could differ is
// decompression: OOXML members are raw DEFLATE and PDF streams are zlib, and
// both go through the WHATWG `DecompressionStream` rather than `node:zlib`
// precisely so this runtime can run them. A green Node suite would not catch a
// missing `deflate-raw` implementation here.
describe('attachment extraction under the Workers runtime', () => {
  it('inflates and reads an .xlsx workbook', async () => {
    const bytes = makeXlsx({
      sharedStrings: ['Holiday', 'Parent', 'Thanksgiving', 'Mother'],
      sheets: [{
        name: '2026',
        rows: xlsxSheetData([
          [{ ref: 'A1', t: 's', v: '0' }, { ref: 'B1', t: 's', v: '1' }],
          [{ ref: 'A2', t: 's', v: '2' }, { ref: 'B2', t: 's', v: '3' }],
        ]),
      }],
    });

    const out = await extractAttachment(
      bytes,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Hall_Holiday_Schedules_2026_-_2027.xlsx',
    );
    expect(out).toMatchObject({
      kind: 'spreadsheet',
      sheets: [{ name: '2026', csv: 'Holiday,Parent\nThanksgiving,Mother' }],
    });
  });

  it('inflates and reads a FlateDecode PDF content stream', async () => {
    const out = await extractAttachment(
      makePdf({ pages: [showText('Proposed parenting time')], compress: true }),
      'application/pdf', 'proposal.pdf',
    );
    expect(out).toMatchObject({ kind: 'pdf', textLayer: true, pages: [{ number: 1, text: 'Proposed parenting time' }] });
  });
});
