// Shared OOXML plumbing: part-path resolution and relationship lookup.
//
// Every OOXML format points from one part to another through a `_rels` file
// (`r:id="rId3"` → `Target="worksheets/sheet3.xml"`), and the target is
// relative to the REFERRING part's directory. Guessing the target from the id
// number instead works right up until a document has been edited enough for the
// numbering to drift, which is why this indirection is followed properly.

import type { ZipArchive } from './zip.js';
import { elements, attr } from './xml.js';

/** Resolve a relationship target against the referring part's directory. */
export function resolvePartPath(baseDir: string, target: string): string {
  // A leading "/" means package-absolute.
  if (target.startsWith('/')) return target.slice(1);
  const segments = (baseDir + target).split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/** The directory of a part path, with a trailing slash (`""` at the root). */
export function dirOf(partPath: string): string {
  const i = partPath.lastIndexOf('/');
  return i === -1 ? '' : partPath.slice(0, i + 1);
}

export interface Relationship {
  id: string;
  /** Package path, already resolved against the referring part. */
  target: string;
  type: string;
}

/** Read the `_rels` companion of `partPath`. Empty when the part has none. */
export async function readRels(zip: ZipArchive, partPath: string): Promise<Relationship[]> {
  const dir = dirOf(partPath);
  const base = partPath.slice(dir.length);
  const xml = await zip.readText(`${dir}_rels/${base}.rels`);
  if (!xml) return [];
  const rels: Relationship[] = [];
  for (const el of elements(xml, 'Relationship')) {
    const id = attr(el.attrs, 'Id');
    const target = attr(el.attrs, 'Target');
    /* v8 ignore next -- a Relationship without Id/Target is malformed OOXML; skipping keeps one bad entry from failing the whole read */
    if (!id || !target) continue;
    rels.push({ id, target: resolvePartPath(dir, target), type: attr(el.attrs, 'Type') ?? '' });
  }
  return rels;
}

/**
 * Locate a top-level part: the conventional path when present, otherwise the
 * first entry whose name ends with the same file name. Producers other than
 * Microsoft's occasionally use a different directory.
 */
export function findPart(zip: ZipArchive, conventional: string, fileName: string): string | null {
  if (zip.has(conventional)) return conventional;
  return zip.names().find((n) => n.endsWith(`/${fileName}`) || n === fileName) ?? null;
}
