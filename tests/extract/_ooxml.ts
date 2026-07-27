// Fixture builders for the OOXML extractors: they emit the same part layout
// Excel/Word/PowerPoint do, so the extractors are exercised against real
// archives (real ZIP, real DEFLATE, real part-to-part `r:id` indirection)
// rather than against a shape invented to match the parser.

import { makeZip, type ZipInput } from './_zip.js';

export interface SheetSpec {
  name: string;
  /** Raw `<row>` XML for the sheet's `<sheetData>`. */
  rows: string;
}

export function xlsxSheetData(
  cells: Array<Array<{ ref: string; t?: string; s?: number; v?: string; inner?: string }>>,
): string {
  return cells.map((row, i) => {
    const inner = row.map((c) => {
      const attrs = [`r="${c.ref}"`, c.t ? `t="${c.t}"` : '', c.s !== undefined ? `s="${c.s}"` : '']
        .filter(Boolean).join(' ');
      return `<c ${attrs}>${c.inner ?? (c.v !== undefined ? `<v>${c.v}</v>` : '')}</c>`;
    }).join('');
    return `<row r="${i + 1}">${inner}</row>`;
  }).join('');
}

export interface XlsxSpec {
  sheets: SheetSpec[];
  sharedStrings?: string[];
  /** numFmtId per style index, mirroring `<cellXfs>`. */
  cellFormats?: number[];
  /** Custom `numFmtId` → `formatCode` pairs. */
  numFmts?: Record<number, string>;
  date1904?: boolean;
  /** Drop the workbook rels part to exercise the positional-fallback path. */
  omitRels?: boolean;
  extraParts?: ZipInput[];
}

export function makeXlsx(spec: XlsxSpec): Buffer {
  const sheetTags = spec.sheets.map((s, i) =>
    `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const pr = spec.date1904 ? '<workbookPr date1904="1"/>' : '';
  const parts: ZipInput[] = [
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0"?><workbook>${pr}<sheets>${sheetTags}</sheets></workbook>`,
    },
    ...spec.sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: `<?xml version="1.0"?><worksheet><sheetData>${s.rows}</sheetData></worksheet>`,
    })),
  ];

  if (!spec.omitRels) {
    const rels = spec.sheets.map((_, i) =>
      `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
    parts.push({ name: 'xl/_rels/workbook.xml.rels', data: `<Relationships>${rels}</Relationships>` });
  }

  if (spec.sharedStrings) {
    const si = spec.sharedStrings.map((s) => `<si><t>${s}</t></si>`).join('');
    parts.push({ name: 'xl/sharedStrings.xml', data: `<sst count="${spec.sharedStrings.length}">${si}</sst>` });
  }

  if (spec.cellFormats) {
    const custom = Object.entries(spec.numFmts ?? {})
      .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code}"/>`).join('');
    const xfs = spec.cellFormats.map((id) => `<xf numFmtId="${id}" xfId="0"/>`).join('');
    parts.push({
      name: 'xl/styles.xml',
      data: `<styleSheet><numFmts>${custom}</numFmts><cellXfs count="${spec.cellFormats.length}">${xfs}</cellXfs></styleSheet>`,
    });
  }

  return makeZip([...parts, ...(spec.extraParts ?? [])]);
}

export function makeDocx(bodyXml: string, extra: ZipInput[] = []): Buffer {
  return makeZip([
    { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document><w:body>${bodyXml}</w:body></w:document>` },
    ...extra,
  ]);
}

export interface SlideSpec {
  /** Paragraph texts on the slide. */
  paragraphs: string[];
  /** Speaker-notes paragraphs, if any. */
  notes?: string[];
}

export function makePptx(slides: SlideSpec[], opts: { omitRels?: boolean } = {}): Buffer {
  const paras = (lines: string[]): string =>
    lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('');
  const parts: ZipInput[] = [];
  slides.forEach((slide, i) => {
    const n = i + 1;
    parts.push({
      name: `ppt/slides/slide${n}.xml`,
      data: `<p:sld><p:cSld><p:spTree>${paras(slide.paragraphs)}</p:spTree></p:cSld></p:sld>`,
    });
    if (slide.notes) {
      // Notes parts are numbered independently of slides, and are reachable
      // only through the slide's rels — so number them in reverse to prove the
      // extractor follows the relationship instead of matching on the number.
      const notesN = slides.length - i;
      parts.push({
        name: `ppt/notesSlides/notesSlide${notesN}.xml`,
        data: `<p:notes><p:cSld><p:spTree>${paras(slide.notes)}</p:spTree></p:cSld></p:notes>`,
      });
      if (!opts.omitRels) {
        parts.push({
          name: `ppt/slides/_rels/slide${n}.xml.rels`,
          data: `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${notesN}.xml"/></Relationships>`,
        });
      }
    }
  });
  return makeZip(parts);
}
