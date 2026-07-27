// PowerPoint (.pptx) text extraction: one entry per slide, plus the speaker
// notes attached to it.
//
// Notes parts are numbered independently of slides (notesSlide2.xml can belong
// to slide 5), so the notes link is followed through the slide's relationship
// part rather than guessed from the file name.

import { readZip } from './zip.js';
import { decodeXmlEntities, elements } from './xml.js';
import { readRels } from './ooxml.js';
import type { PresentationExtract, SlideExtract, PartSelector } from './types.js';

export interface PresentationOptions {
  select?: PartSelector;
}

const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/;

/** Text of every `<a:p>` paragraph in a slide/notes part, one per line. */
function slideText(xml: string): string {
  const lines: string[] = [];
  for (const p of elements(xml, 'a:p')) {
    let line = '';
    for (const t of elements(p.inner, 'a:t')) line += decodeXmlEntities(t.inner);
    if (line !== '') lines.push(line);
  }
  return lines.join('\n');
}

/** Extract text and speaker notes from every (selected) slide. */
export async function extractPptx(
  bytes: Buffer, opts: PresentationOptions = {},
): Promise<PresentationExtract> {
  const zip = await readZip(bytes);
  const paths = zip.names()
    .map((name) => ({ name, n: Number(SLIDE_PATH.exec(name)?.[1]) }))
    .filter((e) => Number.isFinite(e.n))
    // slide10 sorts before slide2 lexically; presentation order is numeric.
    .sort((a, b) => a.n - b.n);
  if (paths.length === 0) throw new Error('no slides found in the .pptx archive');

  const slides: SlideExtract[] = [];
  const omitted: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const { name } = paths[i];
    const number = i + 1;
    if (opts.select && !opts.select(i, `slide ${number}`)) {
      omitted.push(`slide ${number}`);
      continue;
    }
    /* v8 ignore next -- `name` came from zip.names(), so readText cannot be null here */
    const text = slideText((await zip.readText(name)) ?? '');
    const notesRel = (await readRels(zip, name)).find((r) => r.type.endsWith('/notesSlide'));
    const notesXml = notesRel ? await zip.readText(notesRel.target) : null;
    const notes = notesXml === null ? '' : slideText(notesXml);
    slides.push({ number, text, ...(notes ? { notes } : {}) });
  }

  return {
    kind: 'presentation',
    slides,
    ...(omitted.length ? { omitted } : {}),
  };
}
