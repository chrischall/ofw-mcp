import { describe, it, expect } from 'vitest';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { inflateBounded, DecompressionLimitError, MAX_DECOMPRESSED_BYTES } from '../../src/extract/inflate.js';

describe('inflateBounded', () => {
  it('inflates a raw DEFLATE payload', async () => {
    const body = Buffer.from('hello '.repeat(100));
    expect((await inflateBounded(deflateRawSync(body), 'deflate-raw', 1000, 'x')).equals(body)).toBe(true);
  });

  it('inflates a zlib-wrapped payload', async () => {
    const body = Buffer.from('pdf stream body');
    expect((await inflateBounded(deflateSync(body), 'deflate', 1000, 'x')).equals(body)).toBe(true);
  });

  it('refuses a payload that expands past the cap, whatever it claimed', async () => {
    // 1 MiB of zeros compresses to about a kilobyte: the compressed size says
    // nothing about the expanded size, which is the entire point of the cap.
    const bomb = deflateRawSync(Buffer.alloc(1024 * 1024));
    expect(bomb.length).toBeLessThan(4096);
    await expect(inflateBounded(bomb, 'deflate-raw', 4096, 'bomb.bin'))
      .rejects.toThrow(DecompressionLimitError);
    await expect(inflateBounded(bomb, 'deflate-raw', 4096, 'bomb.bin'))
      .rejects.toThrow(/bomb\.bin expands past the 4096-byte decompression cap/);
  });

  it('allows a payload that lands exactly on the cap', async () => {
    const body = Buffer.alloc(1000, 0x41);
    const out = await inflateBounded(deflateRawSync(body), 'deflate-raw', 1000, 'exact');
    expect(out.length).toBe(1000);
  });

  it('propagates a genuine decode failure', async () => {
    await expect(inflateBounded(Buffer.from('not deflate data at all'), 'deflate-raw', 1000, 'junk'))
      .rejects.toThrow();
  });

  it('exposes a 32 MiB default cap', () => {
    expect(MAX_DECOMPRESSED_BYTES).toBe(32 * 1024 * 1024);
  });
});
