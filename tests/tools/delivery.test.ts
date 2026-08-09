import { describe, it, expect, vi } from 'vitest';
import { tryExtract, buildInlineDelivery } from '../../src/tools/delivery.js';

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
