import { describe, it, expect } from 'vitest';
import {
  normalizeMimeType, sniffImageMime, resolveDownloadMime, isHostRenderableImage, mimeFromName,
} from '../../src/tools/attachments.js';

describe('normalizeMimeType', () => {
  it('strips a charset parameter off an image type', () => {
    expect(normalizeMimeType('image/png;charset=UTF-8')).toBe('image/png');
  });

  it('strips a name parameter and surrounding whitespace, lowercasing', () => {
    expect(normalizeMimeType('  Application/PDF ; name="x.pdf" ')).toBe('application/pdf');
  });

  it('returns octet-stream for null, undefined, and empty input', () => {
    expect(normalizeMimeType(null)).toBe('application/octet-stream');
    expect(normalizeMimeType(undefined)).toBe('application/octet-stream');
    expect(normalizeMimeType('')).toBe('application/octet-stream');
  });

  it('returns octet-stream when the type part is empty (leading semicolon)', () => {
    expect(normalizeMimeType(';charset=UTF-8')).toBe('application/octet-stream');
  });
});

describe('sniffImageMime', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg')]);
  const gif = Buffer.from('GIF89a-data');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPdata')]);

  it('detects PNG', () => expect(sniffImageMime(png)).toBe('image/png'));
  it('detects JPEG', () => expect(sniffImageMime(jpeg)).toBe('image/jpeg'));
  it('detects GIF', () => expect(sniffImageMime(gif)).toBe('image/gif'));
  it('detects WEBP', () => expect(sniffImageMime(webp)).toBe('image/webp'));

  it('returns null for a long non-image buffer (RIFF container that is not WEBP)', () => {
    // ≥12 bytes so every length guard is true; RIFF header but AVI payload.
    expect(sniffImageMime(Buffer.from('RIFF0000AVI xxxx'))).toBeNull();
  });

  it('returns null for a long buffer that is not a RIFF container', () => {
    expect(sniffImageMime(Buffer.from('not-an-image-at-all'))).toBeNull();
  });

  it('returns null for a buffer too short to match any signature', () => {
    expect(sniffImageMime(Buffer.from([0x00, 0x01]))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('resolveDownloadMime', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('prefers the magic-number sniff over a lying header and extension', () => {
    expect(resolveDownloadMime(png, 'text/plain;charset=UTF-8', 'x.txt')).toBe('image/png');
  });

  it('falls back to the parameter-stripped header when sniff fails', () => {
    const bytes = Buffer.from('%PDF-1.7');
    expect(resolveDownloadMime(bytes, 'application/pdf; name=x.pdf', 'x.pdf')).toBe('application/pdf');
  });

  it('falls back to the filename extension when sniff and header are both unusable', () => {
    const bytes = Buffer.from('plain bytes');
    expect(resolveDownloadMime(bytes, null, 'notes.md')).toBe('text/markdown');
  });

  it('ends at octet-stream for an unknown extension and no header', () => {
    expect(resolveDownloadMime(Buffer.from('x'), null, 'mystery.qqq')).toBe('application/octet-stream');
  });
});

describe('isHostRenderableImage', () => {
  it('is true for the four host-renderable image types', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(isHostRenderableImage(m)).toBe(true);
    }
  });

  it('is false for non-renderable images and other types', () => {
    expect(isHostRenderableImage('image/heic')).toBe(false);
    expect(isHostRenderableImage('application/pdf')).toBe(false);
  });
});

describe('mimeFromName (existing helper, sanity)', () => {
  it('maps known and unknown extensions', () => {
    expect(mimeFromName('a.png')).toBe('image/png');
    expect(mimeFromName('a.unknownext')).toBe('application/octet-stream');
  });
});
