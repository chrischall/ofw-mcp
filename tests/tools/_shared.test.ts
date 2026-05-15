import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAbsolute } from 'node:path';
import { expandPath, jsonResponse, mapRecipients, textResponse } from '../../src/tools/_shared.js';

describe('jsonResponse', () => {
  it('wraps a payload as a single text content block with pretty-printed JSON', () => {
    const result = jsonResponse({ foo: 'bar', n: 1 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('{\n  "foo": "bar",\n  "n": 1\n}');
  });

  it('serializes arrays and nested objects', () => {
    const result = jsonResponse([{ a: 1 }, { a: 2 }]);
    expect(JSON.parse(result.content[0].text)).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('textResponse', () => {
  it('wraps a string as a single text content block (no JSON-encoding)', () => {
    const result = textResponse('plain message');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'plain message' });
  });
});

describe('mapRecipients', () => {
  it('returns [] for null / undefined / empty input', () => {
    expect(mapRecipients(null)).toEqual([]);
    expect(mapRecipients(undefined)).toEqual([]);
    expect(mapRecipients([])).toEqual([]);
  });

  it('maps the standard OFW recipient shape into the cache Recipient shape', () => {
    expect(mapRecipients([
      { user: { id: 1, name: 'Alice' }, viewed: { dateTime: '2026-05-01T00:00:00Z' } },
      { user: { id: 2, name: 'Bob' }, viewed: null },
    ])).toEqual([
      { userId: 1, name: 'Alice', viewedAt: '2026-05-01T00:00:00Z' },
      { userId: 2, name: 'Bob', viewedAt: null },
    ]);
  });

  it('defaults userId to 0 and name to empty string when user is missing (defensive)', () => {
    // OFW occasionally returns recipients with a partial or missing user — the
    // null-safe fallbacks here exist to keep cache writes from blowing up.
    expect(mapRecipients([
      { user: undefined, viewed: { dateTime: '2026-05-01T00:00:00Z' } },
      { user: { id: undefined, name: undefined } },
      {},
    ])).toEqual([
      { userId: 0, name: '', viewedAt: '2026-05-01T00:00:00Z' },
      { userId: 0, name: '', viewedAt: null },
      { userId: 0, name: '', viewedAt: null },
    ]);
  });
});

describe('expandPath', () => {
  let originalHome: string | undefined;

  beforeEach(() => { originalHome = process.env.HOME; });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('expands ~/ to $HOME', () => {
    process.env.HOME = '/home/alice';
    expect(expandPath('~/Downloads/file.pdf')).toBe('/home/alice/Downloads/file.pdf');
  });

  it('treats absolute paths as-is', () => {
    expect(expandPath('/tmp/foo/bar.txt')).toBe('/tmp/foo/bar.txt');
  });

  it('resolves relative paths against cwd to an absolute path', () => {
    const result = expandPath('relative/path.txt');
    expect(isAbsolute(result)).toBe(true);
    expect(result.endsWith('/relative/path.txt')).toBe(true);
  });

  it('does not strip the leading slash when HOME is unset (regression guard)', () => {
    delete process.env.HOME;
    // With HOME unset the join collapses to an absolute path starting at /
    // — the path stays absolute rather than becoming a relative one.
    expect(isAbsolute(expandPath('~/foo'))).toBe(true);
  });
});
