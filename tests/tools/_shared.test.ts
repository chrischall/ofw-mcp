import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAbsolute } from 'node:path';
import { deriveRead, expandPath, hasRealView, jsonResponse, mapRecipients, textResponse, verifyWriteLanded, withReadState } from '../../src/tools/_shared.js';
import { sampleMessageRow } from '../_fixtures.js';

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

  it('carries the real recipient id from the live `user.userId` field', () => {
    // Live OFW payloads key the id as `userId` (e.g. 3039201), not `id` — an
    // earlier reader looked at `id`, which is absent, so every recipient came
    // out with `userId: 0` and no "find my own recipient" match could succeed.
    expect(mapRecipients([
      { user: { userId: 3039201, name: 'Chris' }, viewed: { dateTime: '2026-07-17T08:37:57' } },
    ])).toEqual([
      { userId: 3039201, name: 'Chris', viewedAt: '2026-07-17T08:37:57' },
    ]);
  });

  it('falls back to the legacy `user.id` field when `userId` is absent', () => {
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

describe('verifyWriteLanded', () => {
  const sent = { subject: 'Pickup time', body: 'I can do 3pm on Friday.' };

  it('returns null when OFW echoes the content exactly', () => {
    expect(verifyWriteLanded('message', sent, { ...sent })).toBeNull();
  });

  it('returns null when OFW transforms by containment (subject prefix, original appended to body)', () => {
    expect(verifyWriteLanded('message', sent, {
      subject: 'RE: Pickup time',
      body: 'I can do 3pm on Friday.\n\n--- Original message ---\nCan you do Friday?',
    })).toBeNull();
  });

  it('warns on subject mismatch only', () => {
    const warning = verifyWriteLanded('draft', sent, { subject: 'something else', body: sent.body });
    expect(warning).toMatch(/the draft re-fetched from OFW does not contain the subject that was posted/);
  });

  it('warns on body mismatch only', () => {
    const warning = verifyWriteLanded('message', sent, { subject: sent.subject, body: 'dropped' });
    expect(warning).toMatch(/the message re-fetched from OFW does not contain the body that was posted/);
  });

  it('warns on both when the detail carries neither field', () => {
    const warning = verifyWriteLanded('message', sent, {});
    expect(warning).toMatch(/does not contain the subject and body that was posted/);
  });
});

describe('hasRealView', () => {
  it('is false for no recipients, null view, or the epoch-zero placeholder', () => {
    expect(hasRealView([])).toBe(false);
    expect(hasRealView([{ viewedAt: null }])).toBe(false);
    expect(hasRealView([{ viewedAt: '1970-01-01T00:00:00' }])).toBe(false);
  });
  it('is true when any recipient has a real view timestamp', () => {
    expect(hasRealView([{ viewedAt: null }, { viewedAt: '2026-06-16T15:49:20' }])).toBe(true);
  });
});

describe('deriveRead', () => {
  const SELF = 3039201;

  describe('inbox', () => {
    it('is true when a recipient has a viewedAt', () => {
      const row = sampleMessageRow({
        folder: 'inbox', fetchedBodyAt: null, listData: { read: false, showNeverViewed: true },
        recipients: [{ userId: SELF, name: 'Chris', viewedAt: '2026-07-17T08:37:57' }],
      });
      expect(deriveRead(row)).toBe(true);
    });

    it('counts ANY recipient view, including one that is not the account holder', () => {
      // Documented limitation, not an oversight. OFW co-parent threads are 1:1,
      // so the sole inbox recipient IS the account holder and any-recipient is
      // exactly right. Discriminating by id would need the account holder's
      // userId, which no non-mutating endpoint exposes: /pub/v2/profiles carries
      // no numeric id at all, and /pub/v1/users/useraccountstatus updates
      // last-seen status as a side effect (read receipts are evidentiary on OFW).
      // If OFW ever adds third-party recipients, revisit — see the removed
      // selfUserId branch in git history.
      const row = sampleMessageRow({
        folder: 'inbox', fetchedBodyAt: null, listData: {},
        recipients: [
          { userId: SELF, name: 'Chris', viewedAt: null },
          { userId: 999, name: 'Lawyer', viewedAt: '2026-07-17T08:37:57' },
        ],
      });
      expect(deriveRead(row)).toBe(true);
    });

    it('is true once the body has been fetched (OFW marks inbox read on body fetch)', () => {
      const row = sampleMessageRow({
        folder: 'inbox', fetchedBodyAt: '2026-07-17T12:37:57.957Z',
        listData: { read: false, showNeverViewed: true },
        recipients: [{ userId: SELF, name: 'Chris', viewedAt: null }],
      });
      expect(deriveRead(row)).toBe(true);
    });

    it('falls back to the scraped list flags when nothing else says read', () => {
      const row = sampleMessageRow({
        folder: 'inbox', fetchedBodyAt: null, listData: { showNeverViewed: false }, recipients: [],
      });
      expect(deriveRead(row)).toBe(true);
    });

    it('is false for an untouched, never-viewed inbox message', () => {
      const row = sampleMessageRow({
        folder: 'inbox', fetchedBodyAt: null, listData: { read: false, showNeverViewed: true },
        recipients: [{ userId: SELF, name: 'Chris', viewedAt: null }],
      });
      expect(deriveRead(row)).toBe(false);
    });

    it('ignores a stale userId: 0 left by the pre-fix recipient parser', () => {
      // Rows cached before the `user.userId` parse fix normalized every
      // recipient to userId 0. Read state must not depend on that field.
      const row = sampleMessageRow({
        folder: 'inbox', fetchedBodyAt: null, listData: {},
        recipients: [{ userId: 0, name: 'Chris', viewedAt: '2026-07-17T08:37:57' }],
      });
      expect(deriveRead(row)).toBe(true);
    });
  });

  describe('sent', () => {
    it('is true when a recipient has viewed the sent message', () => {
      const row = sampleMessageRow({
        folder: 'sent', fetchedBodyAt: '2026-06-15T00:01:00Z', listData: {},
        recipients: [{ userId: 999, name: 'Co-parent', viewedAt: '2026-06-16T15:49:20' }],
      });
      expect(deriveRead(row)).toBe(true);
    });

    it('is false when no recipient has viewed it — ignoring our own body fetch', () => {
      // fetchedBodyAt is always set for sent messages; it must NOT count as read.
      const row = sampleMessageRow({
        folder: 'sent', fetchedBodyAt: '2026-06-15T00:01:00Z', listData: { showNeverViewed: true },
        recipients: [{ userId: 999, name: 'Co-parent', viewedAt: null }],
      });
      expect(deriveRead(row)).toBe(false);
    });

    it('falls back to the scraped showNeverViewed flag', () => {
      const row = sampleMessageRow({
        folder: 'sent', fetchedBodyAt: null, listData: { showNeverViewed: false }, recipients: [],
      });
      expect(deriveRead(row)).toBe(true);
    });
  });

  it('treats a non-object listData as carrying no read signal', () => {
    const row = sampleMessageRow({
      folder: 'inbox', fetchedBodyAt: null, listData: null, recipients: [],
    });
    expect(deriveRead(row)).toBe(false);
  });
});

describe('withReadState', () => {
  it('adds a top-level `read` and forces listData flags to agree (read case)', () => {
    const row = sampleMessageRow({
      folder: 'inbox', fetchedBodyAt: '2026-07-17T12:37:57.957Z',
      listData: { read: false, showNeverViewed: true, other: 'kept' },
      recipients: [{ userId: 3039201, name: 'Chris', viewedAt: '2026-07-17T08:37:57' }],
    });
    const out = withReadState(row);
    expect(out.read).toBe(true);
    expect(out.listData).toEqual({ read: true, showNeverViewed: false, other: 'kept' });
  });

  it('reports unread and keeps the flags consistent (unread case)', () => {
    const row = sampleMessageRow({
      folder: 'inbox', fetchedBodyAt: null, listData: { other: 'kept' },
      recipients: [{ userId: 3039201, name: 'Chris', viewedAt: null }],
    });
    const out = withReadState(row);
    expect(out.read).toBe(false);
    expect(out.listData).toEqual({ read: false, showNeverViewed: true, other: 'kept' });
  });

  it('passes a non-object listData through untouched', () => {
    const row = sampleMessageRow({ folder: 'inbox', fetchedBodyAt: null, listData: null, recipients: [] });
    const out = withReadState(row);
    expect(out.read).toBe(false);
    expect(out.listData).toBeNull();
  });
});
