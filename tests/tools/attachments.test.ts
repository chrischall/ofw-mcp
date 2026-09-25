import { describe, it, expect, vi, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mcpUtils from '@chrischall/mcp-utils';

// Pass-through mock so a test can intercept fileBlob (the open) while the real
// implementation still runs by default.
const fileBlobHook = vi.hoisted(() => ({ before: undefined as undefined | (() => void) }));
vi.mock('@chrischall/mcp-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chrischall/mcp-utils')>();
  return {
    ...actual,
    fileBlob: vi.fn((...args: Parameters<typeof actual.fileBlob>) => {
      fileBlobHook.before?.();
      return actual.fileBlob(...args);
    }),
  };
});
import {
  normalizeMimeType, sniffImageMime, resolveDownloadMime, isHostRenderableImage, mimeFromName,
  NodeAttachmentIO,
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

describe('NodeAttachmentIO.writeDownload', () => {
  it('rethrows a write failure that is not "already exists"', () => {
    const root = mkdtempSync(join(tmpdir(), 'ofw-io-'));
    const ro = join(root, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      expect(() => new NodeAttachmentIO().writeDownload(join(ro, 'f.bin'), Buffer.from('x'), { root, overwrite: false }))
        .toThrow(/EACCES/);
    } finally {
      chmodSync(ro, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// PRIV-1: the directory listing is itself sensitive — entries are named
// `<fileId>-<filename>` with filenames the co-parent chose (evaluations,
// medical forms). 0600 bytes in a 0755 directory still expose those names to
// every local user.
describe('NodeAttachmentIO.writeDownload — private directories (PRIV-1)', () => {
  const mode = (p: string) => statSync(p).mode & 0o777;

  it('creates the attachments root and any subdirectory 0700, and the file 0600', () => {
    const base = mkdtempSync(join(tmpdir(), 'ofw-io-'));
    const root = join(base, 'attachments');
    try {
      const dest = join(root, 'sub', '123-report.pdf');
      new NodeAttachmentIO().writeDownload(dest, Buffer.from('x'), { root, overwrite: false });
      expect(mode(root)).toBe(0o700);
      expect(mode(join(root, 'sub'))).toBe(0o700);
      expect(mode(dest)).toBe(0o600);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('tightens an existing DEFAULT attachments dir (~/Downloads/ofw-mcp) left world-listable by an older version', () => {
    const home = mkdtempSync(join(tmpdir(), 'ofw-home-'));
    const prevHome = process.env.HOME;
    const prevDir = process.env.OFW_ATTACHMENTS_DIR;
    process.env.HOME = home;
    delete process.env.OFW_ATTACHMENTS_DIR;
    const root = join(home, 'Downloads', 'ofw-mcp');
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o755);
    try {
      new NodeAttachmentIO().writeDownload(join(root, '1-a.pdf'), Buffer.from('x'), { root, overwrite: false });
      expect(mode(root)).toBe(0o700);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevDir !== undefined) process.env.OFW_ATTACHMENTS_DIR = prevDir;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('leaves the mode of an existing directory the user configured alone (it may be shared on purpose)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ofw-io-'));
    chmodSync(root, 0o755);
    try {
      new NodeAttachmentIO().writeDownload(join(root, '1-a.pdf'), Buffer.from('x'), { root, overwrite: false });
      expect(mode(root)).toBe(0o755);
      expect(mode(join(root, '1-a.pdf'))).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('NodeAttachmentIO.resolveUpload — confinement re-checked at open time', () => {
  const savedUploadDir = process.env.OFW_UPLOAD_DIR;
  afterEach(() => {
    fileBlobHook.before = undefined;
    vi.mocked(mcpUtils.fileBlob).mockClear();
    if (savedUploadDir === undefined) delete process.env.OFW_UPLOAD_DIR;
    else process.env.OFW_UPLOAD_DIR = savedUploadDir;
  });

  it('passes the realpath of the upload root to fileBlob as allowedRoots', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ofw-upload-roots-'));
    try {
      const root = join(base, 'uploads');
      mkdirSync(root);
      writeFileSync(join(root, 'form.pdf'), 'pdf');
      process.env.OFW_UPLOAD_DIR = root;
      const upload = await new NodeAttachmentIO().resolveUpload('form.pdf');
      expect(upload.fileName).toBe('form.pdf');
      expect(vi.mocked(mcpUtils.fileBlob)).toHaveBeenCalledWith(
        realpathSync(join(root, 'form.pdf')),
        expect.objectContaining({ allowedRoots: [realpathSync(root)] }),
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('refuses a file swapped for an outside symlink between the check and the open', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ofw-upload-race-'));
    try {
      const root = join(base, 'uploads');
      mkdirSync(root);
      const secret = join(base, 'secret.txt');
      writeFileSync(secret, 'top secret');
      const target = join(root, 'form.pdf');
      writeFileSync(target, 'pdf');
      process.env.OFW_UPLOAD_DIR = root;
      // The swap lands after resolveUpload's own checks, just before the open.
      fileBlobHook.before = () => {
        unlinkSync(target);
        symlinkSync(secret, target);
      };
      await expect(new NodeAttachmentIO().resolveUpload('form.pdf'))
        .rejects.toThrow(/outside the allowed directories/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
