import { describe, it, expect } from 'vitest';
import { extractDocx } from '../../src/extract/document.js';
import { extractPptx } from '../../src/extract/presentation.js';
import { makeDocx, makePptx } from './_ooxml.js';
import { makeZip } from './_zip.js';

const para = (text: string, style?: string): string =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;

describe('extractDocx', () => {
  it('returns paragraph text in document order', async () => {
    const out = await extractDocx(makeDocx(para('First line.') + para('Second line.')));
    expect(out.kind).toBe('document');
    expect(out.text).toBe('First line.\n\nSecond line.');
  });

  it('marks headings by level and keeps list items as bullets', async () => {
    const body = para('Custody Schedule', 'Title')
      + para('2026', 'Heading1')
      + para('Thanksgiving', 'Heading2')
      + para('Mother has the children', 'ListParagraph');
    const { text } = await extractDocx(makeDocx(body));
    expect(text.split('\n\n')).toEqual([
      '# Custody Schedule',
      '# 2026',
      '## Thanksgiving',
      '- Mother has the children',
    ]);
  });

  it('joins runs within a paragraph and honours tabs and breaks', async () => {
    const body = '<w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">b </w:t>'
      + '<w:br/><w:t>c</w:t></w:r></w:p>';
    const { text } = await extractDocx(makeDocx(body));
    expect(text).toBe('a\tb \nc');
  });

  it('renders a table as pipe-delimited rows', async () => {
    const cell = (t: string): string => `<w:tc><w:tcPr/><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
    const body = para('Before')
      + `<w:tbl><w:tblPr/><w:tr><w:trPr/>${cell('Holiday')}${cell('Parent')}</w:tr>`
      + `<w:tr>${cell('Thanksgiving')}${cell('Mother')}</w:tr></w:tbl>`
      + para('After');
    const { text } = await extractDocx(makeDocx(body));
    expect(text).toBe(
      'Before\n\n| Holiday | Parent |\n| Thanksgiving | Mother |\n\nAfter',
    );
  });

  it('joins multi-paragraph table cells onto one line', async () => {
    const body = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>one</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    expect((await extractDocx(makeDocx(body))).text).toBe('| one two |');
  });

  it('drops an empty paragraph inside a table cell', async () => {
    const body = '<w:tbl><w:tr><w:tc><w:p/><w:p><w:r><w:t>only</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    expect((await extractDocx(makeDocx(body))).text).toBe('| only |');
  });

  it('decodes entities and drops empty paragraphs', async () => {
    const body = para('Kids &amp; schedules') + '<w:p/>' + para('End');
    expect((await extractDocx(makeDocx(body))).text).toBe('Kids & schedules\n\nEnd');
  });

  it('ignores an unknown paragraph style', async () => {
    expect((await extractDocx(makeDocx(para('plain', 'BodyTextIndent')))).text).toBe('plain');
  });

  it('rejects an archive with no document part', async () => {
    await expect(extractDocx(makeZip([{ name: 'x.xml', data: '<x/>' }])))
      .rejects.toThrow(/document part/i);
  });

  it('finds a document part stored under a non-standard directory', async () => {
    const bytes = makeZip([{ name: 'w/document.xml', data: `<w:document><w:body>${para('hi')}</w:body></w:document>` }]);
    expect((await extractDocx(bytes)).text).toBe('hi');
  });
});

describe('extractPptx', () => {
  it('extracts per-slide text in slide order', async () => {
    const out = await extractPptx(makePptx([
      { paragraphs: ['Parenting Plan', '2026 - 2027'] },
      { paragraphs: ['Holidays'] },
    ]));
    expect(out.kind).toBe('presentation');
    expect(out.slides).toEqual([
      { number: 1, text: 'Parenting Plan\n2026 - 2027' },
      { number: 2, text: 'Holidays' },
    ]);
  });

  it('follows the slide rels to attach the right speaker notes', async () => {
    const out = await extractPptx(makePptx([
      { paragraphs: ['Slide one'], notes: ['Remember to mention pickup times'] },
      { paragraphs: ['Slide two'], notes: ['Second set of notes'] },
    ]));
    expect(out.slides[0].notes).toBe('Remember to mention pickup times');
    expect(out.slides[1].notes).toBe('Second set of notes');
  });

  it('omits notes when the slide has no notes relationship', async () => {
    const out = await extractPptx(makePptx([{ paragraphs: ['No notes here'], notes: ['x'] }], { omitRels: true }));
    expect(out.slides[0].notes).toBeUndefined();
  });

  it('orders slides numerically, not lexically', async () => {
    const slides = Array.from({ length: 11 }, (_, i) => ({ paragraphs: [`s${i + 1}`] }));
    const out = await extractPptx(makePptx(slides));
    expect(out.slides.map((s) => s.text)).toEqual(slides.map((s) => s.paragraphs[0]));
  });

  it('skips slides the caller did not select and records them as omitted', async () => {
    const out = await extractPptx(
      makePptx([{ paragraphs: ['one'] }, { paragraphs: ['two'] }, { paragraphs: ['three'] }]),
      { select: (i) => i === 1 },
    );
    expect(out.slides).toEqual([{ number: 2, text: 'two' }]);
    expect(out.omitted).toEqual(['slide 1', 'slide 3']);
  });

  it('skips empty paragraphs on a slide', async () => {
    const out = await extractPptx(makeZip([{
      name: 'ppt/slides/slide1.xml',
      data: '<p:sld><a:p/><a:p><a:r><a:t>kept</a:t></a:r></a:p></p:sld>',
    }]));
    expect(out.slides[0].text).toBe('kept');
  });

  it('rejects an archive with no slides', async () => {
    await expect(extractPptx(makeZip([{ name: 'ppt/presentation.xml', data: '<p/>' }])))
      .rejects.toThrow(/no slides/i);
  });
});
