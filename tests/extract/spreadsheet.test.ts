import { describe, it, expect } from 'vitest';
import { extractXlsx, extractDelimited, excelSerialToIso } from '../../src/extract/spreadsheet.js';
import { makeXlsx, xlsxSheetData } from './_ooxml.js';
import { makeZip } from './_zip.js';

describe('extractXlsx', () => {
  it('extracts sheet names, dimensions and CSV from a shared-string workbook', async () => {
    const bytes = makeXlsx({
      sharedStrings: ['Holiday', 'Parent', 'Thanksgiving', 'Christmas'],
      sheets: [{
        name: '2026',
        rows: xlsxSheetData([
          [{ ref: 'A1', t: 's', v: '0' }, { ref: 'B1', t: 's', v: '1' }],
          [{ ref: 'A2', t: 's', v: '2' }, { ref: 'B2', v: '2026' }],
          [{ ref: 'A3', t: 's', v: '3' }, { ref: 'B3', v: '2027' }],
        ]),
      }],
    });

    const out = await extractXlsx(bytes);
    expect(out.kind).toBe('spreadsheet');
    expect(out.sheets).toHaveLength(1);
    const [sheet] = out.sheets;
    expect(sheet.name).toBe('2026');
    expect(sheet.rows).toBe(3);
    expect(sheet.cols).toBe(2);
    expect(sheet.csv).toBe('Holiday,Parent\nThanksgiving,2026\nChristmas,2027');
  });

  it('reads every cell type: inline string, formula string, boolean, error and number', async () => {
    const bytes = makeXlsx({
      sheets: [{
        name: 'Types',
        rows: xlsxSheetData([[
          { ref: 'A1', t: 'inlineStr', inner: '<is><t>inline</t></is>' },
          { ref: 'B1', t: 'str', inner: '<f>CONCAT("a","b")</f><v>ab</v>' },
          { ref: 'C1', t: 'b', v: '1' },
          { ref: 'D1', t: 'b', v: '0' },
          { ref: 'E1', t: 'e', v: '#DIV/0!' },
          { ref: 'F1', v: '12.5' },
        ]]),
      }],
    });

    const out = await extractXlsx(bytes);
    expect(out.sheets[0].csv).toBe('inline,ab,TRUE,FALSE,#DIV/0!,12.5');
  });

  it('returns a formula cell as its cached computed value, not the formula', async () => {
    const bytes = makeXlsx({
      sheets: [{ name: 'S', rows: xlsxSheetData([[{ ref: 'A1', inner: '<f>SUM(B1:B9)</f><v>42</v>' }]]) }],
    });
    expect((await extractXlsx(bytes)).sheets[0].csv).toBe('42');
  });

  it('renders date-formatted numbers as ISO dates and times', async () => {
    const bytes = makeXlsx({
      // style 0 = general, 1 = builtin date (14), 2 = custom date, 3 = builtin time (18)
      cellFormats: [0, 14, 164, 18],
      numFmts: { 164: 'yyyy\\-mm\\-dd' },
      sheets: [{
        name: 'Dates',
        rows: xlsxSheetData([[
          { ref: 'A1', s: 0, v: '44927' },
          { ref: 'B1', s: 1, v: '44927' },
          { ref: 'C1', s: 2, v: '44927.5' },
          { ref: 'D1', s: 3, v: '0.5' },
        ]]),
      }],
    });

    expect((await extractXlsx(bytes)).sheets[0].csv)
      .toBe('44927,2023-01-01,2023-01-01T12:00:00,12:00:00');
  });

  it('honours the 1904 date system', async () => {
    const bytes = makeXlsx({
      date1904: true,
      cellFormats: [14],
      sheets: [{ name: 'D', rows: xlsxSheetData([[{ ref: 'A1', s: 0, v: '43465' }]]) }],
    });
    expect((await extractXlsx(bytes)).sheets[0].csv).toBe('2023-01-01');
  });

  it('leaves a date-styled cell that is not a number alone', async () => {
    const bytes = makeXlsx({
      cellFormats: [14],
      sharedStrings: ['N/A'],
      sheets: [{ name: 'D', rows: xlsxSheetData([[{ ref: 'A1', s: 0, t: 's', v: '0' }]]) }],
    });
    expect((await extractXlsx(bytes)).sheets[0].csv).toBe('N/A');
  });

  it('pads gaps from sparse cell references and quotes CSV-hostile values', async () => {
    const bytes = makeXlsx({
      sharedStrings: ['a,b', 'quote"d', 'line\nbreak'],
      sheets: [{
        name: 'Sparse',
        rows: xlsxSheetData([
          [{ ref: 'A1', t: 's', v: '0' }, { ref: 'D1', t: 's', v: '1' }],
          [{ ref: 'B2', t: 's', v: '2' }],
        ]),
      }],
    });

    const [sheet] = (await extractXlsx(bytes)).sheets;
    expect(sheet.cols).toBe(4);
    expect(sheet.csv).toBe('"a,b",,,"quote""d"\n,"line\nbreak",,');
  });

  it('handles two-letter column references beyond Z', async () => {
    const bytes = makeXlsx({
      sheets: [{ name: 'Wide', rows: xlsxSheetData([[{ ref: 'AA1', v: '7' }]]) }],
    });
    const [sheet] = (await extractXlsx(bytes)).sheets;
    expect(sheet.cols).toBe(27);
    expect(sheet.csv.endsWith(',7')).toBe(true);
  });

  it('skips a cell whose reference is missing or unparseable rather than failing', async () => {
    const bytes = makeXlsx({
      // First cell has no `r` at all; second has one with no column letters.
      sheets: [{ name: 'Odd', rows: '<row r="1"><c><v>1</v></c><c r="1"><v>9</v></c><c r="B1"><v>2</v></c></row>' }],
    });
    expect((await extractXlsx(bytes)).sheets[0].csv).toBe(',2');
  });

  it('reports a row with no cells as an empty line', async () => {
    const bytes = makeXlsx({
      sheets: [{ name: 'Gap', rows: '<row r="1"><c r="A1"><v>1</v></c></row><row r="2"/>' }],
    });
    const [sheet] = (await extractXlsx(bytes)).sheets;
    expect(sheet.rows).toBe(2);
    expect(sheet.csv).toBe('1\n');
  });

  it('reads multiple sheets and follows r:id targets, including an absolute one', async () => {
    const bytes = makeXlsx({
      sheets: [
        { name: 'First', rows: xlsxSheetData([[{ ref: 'A1', v: '1' }]]) },
        { name: 'Second', rows: xlsxSheetData([[{ ref: 'A1', v: '2' }]]) },
      ],
    });
    const out = await extractXlsx(bytes);
    expect(out.sheets.map((s) => s.name)).toEqual(['First', 'Second']);
    expect(out.sheets.map((s) => s.csv)).toEqual(['1', '2']);
  });

  it('falls back to positional sheet parts when the workbook rels are missing', async () => {
    const bytes = makeXlsx({
      omitRels: true,
      sheets: [{ name: 'Only', rows: xlsxSheetData([[{ ref: 'A1', v: '5' }]]) }],
    });
    expect((await extractXlsx(bytes)).sheets[0].csv).toBe('5');
  });

  it('reports a sheet whose part is missing instead of dropping it silently', async () => {
    const bytes = makeXlsx({
      omitRels: true,
      sheets: [{ name: 'Ghost', rows: xlsxSheetData([[{ ref: 'A1', v: '1' }]]) }],
      // Overwrite: build an archive where the sheet part named by the fallback
      // does not exist by renaming it.
      extraParts: [{ name: 'xl/worksheets/renamed.xml', data: '<worksheet/>' }],
    });
    // Strip the real sheet1 part by rebuilding without it.
    const zipWithoutSheet = makeZip([
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Ghost" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    ]);
    void bytes;
    const out = await extractXlsx(zipWithoutSheet);
    expect(out.sheets).toEqual([]);
    expect(out.omitted).toEqual(['Ghost (sheet part not found in the workbook)']);
  });

  it('skips sheets the caller did not select and records them as omitted', async () => {
    const bytes = makeXlsx({
      sheets: [
        { name: 'Keep', rows: xlsxSheetData([[{ ref: 'A1', v: '1' }]]) },
        { name: 'Drop', rows: xlsxSheetData([[{ ref: 'A1', v: '2' }]]) },
      ],
    });
    const out = await extractXlsx(bytes, { select: (i, name) => name === 'Keep' && i === 0 });
    expect(out.sheets.map((s) => s.name)).toEqual(['Keep']);
    expect(out.omitted).toEqual(['Drop']);
  });

  it('stops at the cell budget and marks the sheet truncated', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => [{ ref: `A${i + 1}`, v: String(i) }]);
    const bytes = makeXlsx({ sheets: [{ name: 'Long', rows: xlsxSheetData(rows) }] });
    const out = await extractXlsx(bytes, { maxCells: 10 });
    const [sheet] = out.sheets;
    expect(sheet.rows).toBe(10);
    expect(sheet.truncated).toBe(true);
    expect(out.truncated).toBe(true);
    expect(sheet.csv.split('\n')).toHaveLength(10);
  });

  it('ignores a numFmt with an unusable id or no format code', async () => {
    const bytes = makeZip([
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="S" sheetId="1"/></sheets></workbook>' },
      {
        name: 'xl/styles.xml',
        data: '<styleSheet><numFmts><numFmt numFmtId="notanumber" formatCode="yyyy"/>'
          + '<numFmt numFmtId="165"/></numFmts><cellXfs><xf numFmtId="165"/><xf/></cellXfs></styleSheet>',
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: `<worksheet><sheetData>${xlsxSheetData([[{ ref: 'A1', s: 0, v: '44927' }, { ref: 'B1', s: 1, v: '44927' }]])}</sheetData></worksheet>`,
      },
    ]);
    // Neither style resolves to a date format, so both stay raw serials.
    expect((await extractXlsx(bytes)).sheets[0].csv).toBe('44927,44927');
  });

  it('renders a shared-string index that is out of range as empty', async () => {
    const bytes = makeXlsx({
      sharedStrings: ['only'],
      sheets: [{ name: 'S', rows: xlsxSheetData([[{ ref: 'A1', t: 's', v: '0' }, { ref: 'B1', t: 's', v: '9' }]]) }],
    });
    expect((await extractXlsx(bytes)).sheets[0].csv).toBe('only,');
  });

  it('falls back to the raw serial when a date-styled value is unrepresentable', async () => {
    const bytes = makeXlsx({
      cellFormats: [14],
      sheets: [{ name: 'S', rows: xlsxSheetData([[{ ref: 'A1', s: 0, v: '1e9' }]]) }],
    });
    expect((await extractXlsx(bytes)).sheets[0].csv).toBe('1e9');
  });

  it('rejects an archive with no workbook part', async () => {
    const bytes = makeZip([{ name: 'random.xml', data: '<x/>' }]);
    await expect(extractXlsx(bytes)).rejects.toThrow(/workbook part/i);
  });

  it('finds a workbook part stored under a non-standard directory', async () => {
    const bytes = makeZip([
      { name: 'spreadsheet/workbook.xml', data: '<workbook><sheets><sheet name="S" sheetId="1"/></sheets></workbook>' },
      { name: 'spreadsheet/worksheets/sheet1.xml', data: `<worksheet><sheetData>${xlsxSheetData([[{ ref: 'A1', v: '9' }]])}</sheetData></worksheet>` },
    ]);
    expect((await extractXlsx(bytes)).sheets[0].csv).toBe('9');
  });

  it('names an unnamed sheet positionally', async () => {
    const bytes = makeZip([
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet sheetId="1"/></sheets></workbook>' },
      { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${xlsxSheetData([[{ ref: 'A1', v: '3' }]])}</sheetData></worksheet>` },
    ]);
    expect((await extractXlsx(bytes)).sheets[0].name).toBe('Sheet1');
  });
});

describe('excelSerialToIso', () => {
  it('converts the 1900 epoch edge cases', () => {
    // Serial 1 is 1900-01-01, and serial 60 is Excel's phantom 1900-02-29 —
    // the reason serials below 60 need the off-by-one correction.
    expect(excelSerialToIso(1, false)).toBe('1900-01-01');
    expect(excelSerialToIso(61, false)).toBe('1900-03-01');
  });

  it('renders a fractional serial as a datetime and a sub-1 serial as a time', () => {
    expect(excelSerialToIso(44927.25, false)).toBe('2023-01-01T06:00:00');
    expect(excelSerialToIso(0.75, false)).toBe('18:00:00');
  });

  it('returns null for a serial outside the representable range', () => {
    expect(excelSerialToIso(1e9, false)).toBeNull();
  });
});

describe('extractDelimited', () => {
  it('parses quoted CSV, including embedded delimiters, quotes and newlines', () => {
    const out = extractDelimited('a,b\n"x,1","he said ""hi"""\n"multi\nline",z', 'data.csv', ',');
    expect(out.sheets[0].rows).toBe(3);
    expect(out.sheets[0].cols).toBe(2);
    expect(out.sheets[0].csv).toBe('a,b\n"x,1","he said ""hi"""\n"multi\nline",z');
  });

  it('converts a TSV to CSV', () => {
    const out = extractDelimited('name\tvalue\na\t1', 'data.tsv', '\t');
    expect(out.sheets[0].csv).toBe('name,value\na,1');
    expect(out.sheets[0].name).toBe('data.tsv');
  });

  it('tolerates CRLF line endings and a trailing newline', () => {
    const out = extractDelimited('a,b\r\nc,d\r\n', 'x.csv', ',');
    expect(out.sheets[0].rows).toBe(2);
    expect(out.sheets[0].csv).toBe('a,b\nc,d');
  });

  it('handles an empty document', () => {
    const out = extractDelimited('', 'empty.csv', ',');
    expect(out.sheets[0].rows).toBe(0);
    expect(out.sheets[0].cols).toBe(0);
    expect(out.sheets[0].csv).toBe('');
  });
});
