import { describe, it, expect } from 'vitest';
import { decodeXmlEntities, elements, attr, textOf } from '../../src/extract/xml.js';

describe('decodeXmlEntities', () => {
  it('decodes the five predefined entities', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'))
      .toBe(`a & b <c> "d" 'e'`);
  });

  it('decodes decimal and hex numeric character references', () => {
    expect(decodeXmlEntities('&#65;&#x42;&#x1F600;')).toBe('AB\u{1F600}');
  });

  it('leaves an unknown entity untouched rather than mangling it', () => {
    expect(decodeXmlEntities('50 &nbsp; percent')).toBe('50 &nbsp; percent');
  });

  it('passes through text with no entities', () => {
    expect(decodeXmlEntities('plain text')).toBe('plain text');
  });
});

describe('elements', () => {
  it('yields the inner content of each matching element', () => {
    const xml = '<root><row r="1"><c>a</c></row><row r="2"><c>b</c></row></root>';
    expect([...elements(xml, 'row')].map((e) => e.inner))
      .toEqual(['<c>a</c>', '<c>b</c>']);
  });

  it('yields an empty inner for a self-closing element', () => {
    const found = [...elements('<a><c r="A1"/></a>', 'c')];
    expect(found).toHaveLength(1);
    expect(found[0].inner).toBe('');
    expect(attr(found[0].attrs, 'r')).toBe('A1');
  });

  it('does not match a longer tag that starts with the same characters', () => {
    // The classic OOXML trap: <w:pPr> must not be scanned as a <w:p>.
    const xml = '<w:body><w:pPr><w:x/></w:pPr><w:p><w:t>hi</w:t></w:p></w:body>';
    expect([...elements(xml, 'w:p')].map((e) => e.inner)).toEqual(['<w:t>hi</w:t>']);
  });

  it('does not let a self-closing tag with attributes swallow its sibling', () => {
    // Regression: a greedy attribute run ate the "/" of the first <xf/>, so the
    // match ran on to the SECOND element's </xf> and both collapsed into one —
    // shifting every style index in a real workbook by one.
    const xml = '<cellXfs><xf numFmtId="0" xfId="0"/><xf numFmtId="16"><alignment/></xf>'
      + '<xf numFmtId="44" /></cellXfs>';
    expect([...elements(xml, 'xf')].map((e) => attr(e.attrs, 'numFmtId')))
      .toEqual(['0', '16', '44']);
  });

  it('yields nothing when the tag is absent', () => {
    expect([...elements('<a/>', 'zzz')]).toEqual([]);
  });
});

describe('attr', () => {
  it('reads double- and single-quoted attribute values', () => {
    expect(attr('r="A1" t=\'s\'', 'r')).toBe('A1');
    expect(attr('r="A1" t=\'s\'', 't')).toBe('s');
  });

  it('decodes entities inside the value', () => {
    expect(attr('name="Q1 &amp; Q2"', 'name')).toBe('Q1 & Q2');
  });

  it('returns null for a missing attribute and for an attribute that is only a prefix', () => {
    expect(attr('r="A1"', 't')).toBeNull();
    // `s` must not match the `s` inside `style`.
    expect(attr('style="x"', 's')).toBeNull();
  });
});

describe('textOf', () => {
  it('concatenates and decodes every occurrence of the tag', () => {
    expect(textOf('<si><t>Hello</t><t> &amp; bye</t></si>', 't')).toBe('Hello & bye');
  });

  it('ignores attributes on the text tag', () => {
    expect(textOf('<si><t xml:space="preserve"> pad </t></si>', 't')).toBe(' pad ');
  });

  it('returns an empty string when the tag never appears', () => {
    expect(textOf('<si/>', 't')).toBe('');
  });
});
