// Word (.docx) text extraction.
//
// The goal is a readable transcript, not a faithful re-render: headings keep
// their level as `#` prefixes, list paragraphs keep their bullet, and table
// rows come back pipe-delimited. Structure is what makes an extracted custody
// schedule answerable ("which row is Thanksgiving?"); a flat wall of runs is
// not much better than the blob we are replacing.

import { readZip } from './zip.js';
import { decodeXmlEntities, elements, attr } from './xml.js';
import { findPart } from './ooxml.js';
import type { DocumentExtract } from './types.js';

// A run's text, a tab, or a break — matched in document order so an inline tab
// does not get hoisted out of position by a tags-then-text pass.
const RUN_CONTENT = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\s*\/>/g;

function paragraphText(inner: string): string {
  let text = '';
  for (let m = RUN_CONTENT.exec(inner); m !== null; m = RUN_CONTENT.exec(inner)) {
    if (m[1] !== undefined) text += decodeXmlEntities(m[1]);
    else text += m[2] === 'tab' ? '\t' : '\n';
  }
  RUN_CONTENT.lastIndex = 0;
  return text;
}

/** Prefix a paragraph according to its `<w:pStyle>`, if it has a known one. */
function styledParagraph(inner: string): string {
  const text = paragraphText(inner);
  if (text === '') return '';
  const style = /<w:pStyle\s[^>]*w:val="([^"]*)"/.exec(inner)?.[1] ?? '';
  const heading = /^Heading(\d)$/.exec(style);
  if (heading) return `${'#'.repeat(Math.min(Number(heading[1]), 6))} ${text}`;
  if (style === 'Title' || style === 'Subtitle') return `# ${text}`;
  if (style === 'ListParagraph') return `- ${text}`;
  return text;
}

function tableText(inner: string): string {
  const rows: string[] = [];
  for (const tr of elements(inner, 'w:tr')) {
    const cells: string[] = [];
    for (const tc of elements(tr.inner, 'w:tc')) {
      // A cell holds paragraphs; keep it on one line so the row stays a row.
      const parts: string[] = [];
      for (const p of elements(tc.inner, 'w:p')) {
        const text = paragraphText(p.inner);
        if (text !== '') parts.push(text);
      }
      cells.push(parts.join(' '));
    }
    rows.push(`| ${cells.join(' | ')} |`);
  }
  return rows.join('\n');
}

// Top-level block scan: a table swallows its own paragraphs (the match spans
// them), so the alternation yields tables and stray paragraphs in order without
// emitting a table's cell text twice.
// The paragraph arm mirrors `elements()`: a lazy attribute run that does not
// eat a self-closing slash, so `<w:p w14:paraId="…"/>` cannot swallow the
// following paragraph.
const BLOCK = /<w:tbl(?:\s[^>]*?)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*?)?(?:\s*\/>|>([\s\S]*?)<\/w:p>)/g;

/** Extract the text of a .docx document part. */
export async function extractDocx(bytes: Buffer): Promise<DocumentExtract> {
  const zip = await readZip(bytes);
  const path = findPart(zip, 'word/document.xml', 'document.xml');
  if (!path) throw new Error('no document part found in the .docx archive');
  /* v8 ignore next -- findPart only returns a name the archive contains, so readText cannot be null here */
  const xml = (await zip.readText(path)) ?? '';

  const blocks: string[] = [];
  for (let m = BLOCK.exec(xml); m !== null; m = BLOCK.exec(xml)) {
    // Group 1 is the paragraph's inner XML — undefined for a table match and
    // for a self-closing (empty) paragraph.
    const text = m[0].startsWith('<w:tbl') ? tableText(m[0]) : styledParagraph(m[1] ?? '');
    if (text !== '') blocks.push(text);
  }
  BLOCK.lastIndex = 0;
  return { kind: 'document', text: blocks.join('\n\n') };
}
