import { describe, it, expect, vi } from 'vitest';
import { tryExtract, buildInlineDelivery, MAX_INLINE_BYTES } from '../../src/tools/delivery.js';

// The ladder's own behaviour is exercised end-to-end through
// ofw_download_attachment in messages.test.ts; this file covers the failure
// paths that a real attachment cannot easily produce.
vi.mock('../../src/extract/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/extract/index.js')>();
  return {
    ...actual,
    extractAttachment: vi.fn(async (bytes: Buffer, mimeType: string, fileName: string, opts) => {
      if (fileName === 'throws-a-string.txt') throw 'not an Error object';
      return actual.extractAttachment(bytes, mimeType, fileName, opts);
    }),
  };
});

describe('tryExtract', () => {
  it('reports a thrown non-Error value as the reason rather than crashing', async () => {
    const outcome = await tryExtract(Buffer.from('x'), 'text/plain', 'throws-a-string.txt', {});
    expect(outcome.extracted).toBeUndefined();
    expect(outcome.reason).toBe('extraction failed: not an Error object');
  });

  it('returns the extraction and its truncation flag on success', async () => {
    const outcome = await tryExtract(Buffer.from('hello'), 'text/plain', 'a.txt', {});
    expect(outcome).toEqual({ extracted: { kind: 'text', text: 'hello' }, truncated: false });
  });
});

describe('buildInlineDelivery', () => {
  it('renders a host-renderable image rather than extracting it', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const { content } = await buildInlineDelivery({
      fileId: 1, fileName: 'kid.png', mimeType: 'image/png', bytes, forcedInline: false, options: {},
    });
    expect(JSON.parse((content[0] as { text: string }).text).deliveredVia).toBe('image');
    expect(content[1].type).toBe('image');
  });
});

// mcp-host caps one child result at 14 MiB of serialized JSON-RPC
// (chrischall/mcp-host#952). The tool bounds inline bytes itself so an
// oversized attachment fails with a message that says what to do instead.
describe('buildInlineDelivery — inline byte cap', () => {
  const pngOfSize = (n: number): Buffer => {
    const b = Buffer.alloc(n);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    return b;
  };

  it('is 10 MiB raw', () => {
    expect(MAX_INLINE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('inlines an image of exactly MAX_INLINE_BYTES', async () => {
    const bytes = pngOfSize(MAX_INLINE_BYTES);
    const { content } = await buildInlineDelivery({
      fileId: 1, fileName: 'big.png', mimeType: 'image/png', bytes, forcedInline: false, options: {},
    });
    expect(content[1].type).toBe('image');
  });

  it('refuses to inline an image one byte over the cap, naming the size and the cap', async () => {
    const bytes = pngOfSize(MAX_INLINE_BYTES + 1);
    await expect(buildInlineDelivery({
      fileId: 1, fileName: 'huge.png', mimeType: 'image/png', bytes, forcedInline: false, options: {},
    })).rejects.toThrow(/huge\.png.*10485761 bytes.*10 MiB/s);
  });

  it('inlines a raw (extract:false) blob of exactly MAX_INLINE_BYTES', async () => {
    const bytes = Buffer.alloc(MAX_INLINE_BYTES, 0x61);
    const { content } = await buildInlineDelivery({
      fileId: 2, fileName: 'a.txt', mimeType: 'text/plain', bytes, forcedInline: false,
      options: { extract: false },
    });
    expect(content[1].type).toBe('resource');
  });

  it('refuses a raw (extract:false) blob over the cap and points at extraction instead', async () => {
    const bytes = Buffer.alloc(MAX_INLINE_BYTES + 1, 0x61);
    await expect(buildInlineDelivery({
      fileId: 2, fileName: 'a.txt', mimeType: 'text/plain', bytes, forcedInline: false,
      options: { extract: false },
    })).rejects.toThrow(/omit extract:false/);
  });

  it('still extracts an over-cap file: extracted text is bounded by maxChars, not the byte cap', async () => {
    const bytes = Buffer.alloc(MAX_INLINE_BYTES + 1, 0x61);
    const { content } = await buildInlineDelivery({
      fileId: 3, fileName: 'a.txt', mimeType: 'text/plain', bytes, forcedInline: false, options: {},
    });
    expect(JSON.parse((content[0] as { text: string }).text).deliveredVia).toBe('extracted');
  });

  it('refuses an over-cap blob with no extractor, suggesting disk mode only when disk exists', async () => {
    const bytes = Buffer.alloc(MAX_INLINE_BYTES + 1);
    const input = {
      fileId: 4, fileName: 'clip.mov', mimeType: 'video/quicktime', bytes, forcedInline: false, options: {},
    };
    await expect(buildInlineDelivery({ ...input, diskAvailable: true })).rejects.toThrow(/inline:false/);
    await expect(buildInlineDelivery({ ...input, diskAvailable: false })).rejects.not.toThrow(/inline:false/);
    await expect(buildInlineDelivery({ ...input, diskAvailable: false })).rejects.toThrow(/OurFamilyWizard/);
  });
});
