import { describe, it, expect } from 'vitest';
import { resolvePartPath, dirOf, readRels, findPart } from '../../src/extract/ooxml.js';
import { readZip } from '../../src/extract/zip.js';
import { makeZip } from './_zip.js';

describe('resolvePartPath', () => {
  it('resolves a relative target against the referring part directory', () => {
    expect(resolvePartPath('xl/', 'worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
  });

  it('resolves a parent-relative target', () => {
    expect(resolvePartPath('ppt/slides/', '../notesSlides/notesSlide2.xml'))
      .toBe('ppt/notesSlides/notesSlide2.xml');
  });

  it('treats a leading slash as package-absolute', () => {
    expect(resolvePartPath('ppt/slides/', '/ppt/media/image1.png')).toBe('ppt/media/image1.png');
  });

  it('drops redundant "." and empty segments', () => {
    expect(resolvePartPath('xl/', './/worksheets//sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
  });
});

describe('dirOf', () => {
  it('returns the directory with a trailing slash', () => {
    expect(dirOf('xl/worksheets/sheet1.xml')).toBe('xl/worksheets/');
  });

  it('returns an empty string for a root-level part', () => {
    expect(dirOf('workbook.xml')).toBe('');
  });
});

describe('readRels', () => {
  it('returns an empty list when the part has no rels companion', async () => {
    const zip = await readZip(makeZip([{ name: 'xl/workbook.xml', data: '<workbook/>' }]));
    expect(await readRels(zip, 'xl/workbook.xml')).toEqual([]);
  });

  it('resolves each relationship target against the referring part', async () => {
    const zip = await readZip(makeZip([
      { name: 'xl/workbook.xml', data: '<workbook/>' },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: '<Relationships><Relationship Id="rId1" Type="http://x/worksheet" Target="worksheets/s1.xml"/></Relationships>',
      },
    ]));
    expect(await readRels(zip, 'xl/workbook.xml')).toEqual([
      { id: 'rId1', target: 'xl/worksheets/s1.xml', type: 'http://x/worksheet' },
    ]);
  });

  it('defaults a relationship with no Type to an empty type', async () => {
    const zip = await readZip(makeZip([
      { name: 'a.xml', data: '<a/>' },
      { name: '_rels/a.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="b.xml"/></Relationships>' },
    ]));
    expect((await readRels(zip, 'a.xml'))[0]).toMatchObject({ target: 'b.xml', type: '' });
  });
});

describe('findPart', () => {
  it('prefers the conventional path', async () => {
    const zip = await readZip(makeZip([
      { name: 'xl/workbook.xml', data: '<a/>' },
      { name: 'other/workbook.xml', data: '<b/>' },
    ]));
    expect(findPart(zip, 'xl/workbook.xml', 'workbook.xml')).toBe('xl/workbook.xml');
  });

  it('finds a root-level part when the conventional path is absent', async () => {
    const zip = await readZip(makeZip([{ name: 'workbook.xml', data: '<a/>' }]));
    expect(findPart(zip, 'xl/workbook.xml', 'workbook.xml')).toBe('workbook.xml');
  });

  it('returns null when nothing matches', async () => {
    const zip = await readZip(makeZip([{ name: 'x.xml', data: '<a/>' }]));
    expect(findPart(zip, 'xl/workbook.xml', 'workbook.xml')).toBeNull();
  });
});
