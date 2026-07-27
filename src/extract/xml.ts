// Just enough XML for OOXML part-reading.
//
// The office formats are machine-generated XML with a known, flat shape per
// part (rows of cells, runs of text), so a scanning reader beats pulling in a
// DOM parser that has to run in both Node and workerd. The one rule this file
// exists to enforce is that a tag match is anchored on the FULL tag name:
// naively scanning for `<w:p` also matches `<w:pPr>`, which silently turns
// paragraph properties into paragraphs.
//
// Known limitation: attribute values containing a literal `>` (legal but never
// emitted by Word/Excel/PowerPoint) would end an element match early.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/** Decode the predefined XML entities plus numeric character references. */
export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return String.fromCodePoint(code);
    }
    // An unrecognized entity is left verbatim: mangling it would be worse than
    // showing it, and OOXML only emits the five predefined ones.
    return NAMED_ENTITIES[body] ?? whole;
  });
}

export interface XmlElement {
  /** The raw attribute text, for {@link attr}. */
  attrs: string;
  /** Raw inner XML — empty for a self-closing element. */
  inner: string;
}

/**
 * Iterate every `<tag …>…</tag>` (and `<tag …/>`) in document order. Nested
 * elements of the SAME name are not supported (the match is non-greedy); none
 * of the parts read here nest — rows, cells, runs and paragraphs are all flat.
 */
export function* elements(xml: string, tag: string): Generator<XmlElement> {
  // The attribute run is LAZY and stops short of the closing `/`. A greedy
  // `[^>]*` swallows the slash of a self-closing tag, after which the `>` arm
  // matches and the scan runs on to the NEXT element's closing tag — merging
  // two siblings into one. That silently shifted every `<xf/>` style index in a
  // real workbook, so a General-formatted year printed as a 1905 date.
  const re = new RegExp(`<${tag}((?:\\s[^>]*?)?)(?:\\s*/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    yield { attrs: m[1], inner: m[2] ?? '' };
  }
}

/** Read one attribute out of an element's raw attribute text. */
export function attr(attrs: string, name: string): string | null {
  // The leading (^|\s) keeps `s="1"` from matching inside `style="…"`.
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  if (!m) return null;
  return decodeXmlEntities(m[2] ?? m[3]);
}

/** Concatenated, entity-decoded text of every `<tag>` element in `xml`. */
export function textOf(xml: string, tag: string): string {
  let out = '';
  for (const el of elements(xml, tag)) out += decodeXmlEntities(el.inner);
  return out;
}
