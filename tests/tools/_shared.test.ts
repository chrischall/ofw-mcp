import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { OFWClient } from '../../src/client.js';
import { deriveRead, draftReplyTarget, expandPath, hasRealView, jsonResponse, mapRecipients, postMessageAndRefetch, textResponse, UnconfirmedWriteError, verifyWriteLanded, withReadState } from '../../src/tools/_shared.js';
import { sampleMessageRow } from '../_fixtures.js';

describe('jsonResponse', () => {
  it('wraps a payload as a single text content block with NO formatting whitespace', () => {
    // Indentation was 23% of a 135 KB message page — roughly 8,000 tokens a
    // call — and nothing downstream reads it. This server has no `raw` rung
    // (tools/project.ts), so every response is minified.
    const result = jsonResponse({ foo: 'bar', n: 1 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('{"foo":"bar","n":1}');
  });

  it('never touches whitespace INSIDE a value — a message body is content', () => {
    // The distinction the whole rule turns on. A text-level minifier would
    // collapse the blank line between paragraphs of every OFW message, which
    // is most of what this server returns.
    const body = 'Line one.\n\n  Indented continuation.\n\nThanks   ';
    const text = jsonResponse({ body }).content[0].text;
    expect(JSON.parse(text).body).toBe(body);
    expect(text.split('\n')).toHaveLength(1);
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
    // Live OFW payloads key the id as `userId` (e.g. 2000001), not `id` — an
    // earlier reader looked at `id`, which is absent, so every recipient came
    // out with `userId: 0` and no "find my own recipient" match could succeed.
    expect(mapRecipients([
      { user: { userId: 2000001, name: 'Chris' }, viewed: { dateTime: '2026-07-17T08:37:57' } },
    ])).toEqual([
      { userId: 2000001, name: 'Chris', viewedAt: '2026-07-17T08:37:57' },
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
  const SELF = 2000001;

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

    it('falls back to the inbox list\'s own `read` flag when nothing else says read', () => {
      const row = sampleMessageRow({
        folder: 'inbox', fetchedBodyAt: null, listData: { read: true, showNeverViewed: true }, recipients: [],
      });
      expect(deriveRead(row)).toBe(true);
    });

    it('does NOT treat showNeverViewed:false as read on an inbox row — fails closed', () => {
      // The live shape of a brand-new UNREAD inbox message: OFW's inbox list
      // carries read:false beside showNeverViewed:false. showNeverViewed is the
      // sender-side "recipient never viewed" badge, not our unread state, so
      // reading it as "read" let a fetch through that stamped First Viewed.
      const row = sampleMessageRow({
        folder: 'inbox', fetchedBodyAt: null, listData: { read: false, showNeverViewed: false },
        recipients: [{ userId: SELF, name: 'Parent A', viewedAt: null }],
      });
      expect(deriveRead(row)).toBe(false);
    });

    it('reads a missing or non-boolean inbox `read` flag as UNREAD', () => {
      for (const listData of [{ showNeverViewed: false }, { read: 'true', showNeverViewed: false }, {}]) {
        const row = sampleMessageRow({ folder: 'inbox', fetchedBodyAt: null, listData, recipients: [] });
        expect(deriveRead(row)).toBe(false);
      }
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

    it('also honours the scraped `read` flag, as before', () => {
      const row = sampleMessageRow({
        folder: 'sent', fetchedBodyAt: null, listData: { read: true, showNeverViewed: true }, recipients: [],
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
      recipients: [{ userId: 2000001, name: 'Chris', viewedAt: '2026-07-17T08:37:57' }],
    });
    const out = withReadState(row);
    expect(out.read).toBe(true);
    expect(out.listData).toEqual({ read: true, showNeverViewed: false, other: 'kept' });
  });

  it('reports unread and keeps the flags consistent (unread case)', () => {
    const row = sampleMessageRow({
      folder: 'inbox', fetchedBodyAt: null, listData: { other: 'kept' },
      recipients: [{ userId: 2000001, name: 'Chris', viewedAt: null }],
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

describe('postMessageAndRefetch — unknown vs definitive failures', () => {
  const post = (err: unknown) => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValueOnce(err);
    return postMessageAndRefetch(client, {}, z.looseObject({}), 'test');
  };

  it('wraps a non-Error rejection as an unconfirmed write, keeping its text', async () => {
    const e = await post('socket hang up').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnconfirmedWriteError);
    expect((e as UnconfirmedWriteError).message).toBe('socket hang up');
    expect((e as UnconfirmedWriteError).postedId).toBeNull();
  });

  it('treats 408 Request Timeout as unknown, not a rejection', async () => {
    await expect(post(new Error('OFW API error: 408 Request Timeout for POST /pub/v3/messages')))
      .rejects.toBeInstanceOf(UnconfirmedWriteError);
  });

  it('passes a definitive rejection (4xx, repeated 429) through unchanged', async () => {
    const rejected = new Error('OFW API error: 403 Forbidden for POST /pub/v3/messages');
    await expect(post(rejected)).rejects.toBe(rejected);
    const limited = new Error('Rate limited by OFW API');
    await expect(post(limited)).rejects.toBe(limited);
  });
});

describe('draftReplyTarget', () => {
  it('takes the first echo that names a target, from either spelling', () => {
    expect(draftReplyTarget([{ replyToId: null, inReplyTo: 7 }, { replyToId: 8 }], 9)).toEqual({ replyToId: 7, replyToSource: 'server' });
    expect(draftReplyTarget([{}, { replyToId: 8 }], 9)).toEqual({ replyToId: 8, replyToSource: 'server' });
  });

  it('keeps the fallback when no echo reports the linkage either way', () => {
    // A bare replyToId:null and a missing key are both "not echoed".
    expect(draftReplyTarget([{ replyToId: null }, {}], 9)).toEqual({ replyToId: 9, replyToSource: 'cache' });
  });

  it('never resurrects a target an echo POSITIVELY dropped', () => {
    expect(draftReplyTarget([{ inReplyTo: null }], 9)).toEqual({ replyToId: null, replyToSource: null });
    expect(draftReplyTarget([{}, { showContext: false }], 9)).toEqual({ replyToId: null, replyToSource: null });
  });

  it('reports no target when there is neither an echo nor a fallback', () => {
    expect(draftReplyTarget([{}], null)).toEqual({ replyToId: null, replyToSource: null });
  });
});
