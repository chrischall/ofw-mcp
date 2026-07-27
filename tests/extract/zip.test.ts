import { describe, it, expect } from 'vitest';
import { readZip, ZIP_MAX_UNCOMPRESSED_BYTES } from '../../src/extract/zip.js';
import { makeZip } from './_zip.js';

describe('readZip', () => {
  it('lists entry names in central-directory order', async () => {
    const zip = await readZip(makeZip([
      { name: 'a.xml', data: '<a/>' },
      { name: 'dir/b.xml', data: '<b/>' },
    ]));
    expect(zip.names()).toEqual(['a.xml', 'dir/b.xml']);
    expect(zip.has('dir/b.xml')).toBe(true);
    expect(zip.has('nope.xml')).toBe(false);
  });

  it('reads a DEFLATE entry back to its original bytes', async () => {
    // Repetitive payload so deflate actually compresses (method 8 exercised).
    const body = 'hello '.repeat(500);
    const zip = await readZip(makeZip([{ name: 'big.txt', data: body, method: 8 }]));
    expect((await zip.readText('big.txt'))).toBe(body);
  });

  it('reads a STORED entry back to its original bytes', async () => {
    const zip = await readZip(makeZip([{ name: 'raw.bin', data: Buffer.from([1, 2, 3, 4]), method: 0 }]));
    const bytes = await zip.read('raw.bin');
    expect(bytes && [...bytes]).toEqual([1, 2, 3, 4]);
  });

  it('returns null for an entry that is not in the archive', async () => {
    const zip = await readZip(makeZip([{ name: 'a.xml', data: '<a/>' }]));
    expect(await zip.read('missing.xml')).toBeNull();
    expect(await zip.readText('missing.xml')).toBeNull();
  });

  it('locates the end-of-central-directory record behind a trailing comment', async () => {
    const zip = await readZip(makeZip([{ name: 'a.txt', data: 'ok' }], { comment: 'x'.repeat(300) }));
    expect(await zip.readText('a.txt')).toBe('ok');
  });

  it('rejects a buffer with no end-of-central-directory record', async () => {
    await expect(readZip(Buffer.from('not a zip at all'))).rejects.toThrow(/not a ZIP/i);
  });

  it('rejects a ZIP64 archive rather than reading a wrong offset', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'ok' }]);
    // Central-directory offset sentinel: 0xffffffff means "see the ZIP64 record".
    zip.writeUInt32LE(0xffffffff, zip.length - 6);
    await expect(readZip(zip)).rejects.toThrow(/ZIP64/i);
  });

  it('rejects an unsupported compression method', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'ok', method: 0 }]);
    // Patch the method field in the central directory header (offset +10).
    const cdStart = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(12, cdStart + 10); // 12 = bzip2, which we do not implement
    const archive = await readZip(zip);
    await expect(archive.read('a.txt')).rejects.toThrow(/compression method 12/i);
  });

  it('rejects a corrupt local file header', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'ok', method: 0 }]);
    zip.writeUInt32LE(0xdeadbeef, 0); // clobber the local header signature
    const archive = await readZip(zip);
    await expect(archive.read('a.txt')).rejects.toThrow(/local header/i);
  });

  it('refuses an entry whose declared size exceeds the decompression cap', async () => {
    const zip = makeZip([{ name: 'bomb.txt', data: 'small', method: 0 }]);
    const cdStart = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(ZIP_MAX_UNCOMPRESSED_BYTES + 1, cdStart + 24); // uncompressed size
    const archive = await readZip(zip);
    await expect(archive.read('bomb.txt')).rejects.toThrow(/too large/i);
  });

  it('rejects a central directory whose entry header signature is wrong', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'ok' }]);
    const cdStart = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(0x02014b51, cdStart);
    await expect(readZip(zip)).rejects.toThrow(/central directory/i);
  });

  it('strips a UTF-8 BOM when decoding text', async () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<x/>', 'utf8')]);
    const zip = await readZip(makeZip([{ name: 'a.xml', data: bom }]));
    expect(await zip.readText('a.xml')).toBe('<x/>');
  });

  it('caches a decompressed entry so repeated reads inflate once', async () => {
    const zip = await readZip(makeZip([{ name: 'a.txt', data: 'twice' }]));
    const first = await zip.read('a.txt');
    const second = await zip.read('a.txt');
    expect(second).toBe(first); // identical Buffer instance, not just equal
  });
});
