import { describe, it, expect, vi } from 'vitest';
import { OFWClient } from '../../src/client.js';
import {
  draftRevision,
  fetchServerDraft,
  checkDraftFreshness,
  staleDraftPayload,
  DraftFreshnessError,
} from '../../src/tools/draft-freshness.js';
import type { DraftContent } from '../../src/tools/draft-freshness.js';

function content(over: Partial<DraftContent> = {}): DraftContent {
  return {
    subject: 'Pickup',
    body: 'Can we move it to 5pm?',
    recipients: [{ userId: 42, name: 'Co Parent', viewedAt: null }],
    replyToId: null,
    ...over,
  };
}

describe('draftRevision', () => {
  it('is stable across calls for identical content', () => {
    expect(draftRevision(content())).toBe(draftRevision(content()));
  });

  it('is insensitive to recipient order, name and viewedAt', () => {
    const a = content({
      recipients: [
        { userId: 42, name: 'Co Parent', viewedAt: null },
        { userId: 7, name: 'Other', viewedAt: null },
      ],
    });
    const b = content({
      recipients: [
        { userId: 7, name: 'RENAMED', viewedAt: '2026-07-19T10:00:00' },
        { userId: 42, name: '', viewedAt: null },
      ],
    });
    expect(draftRevision(a)).toBe(draftRevision(b));
  });

  it('changes when body, subject, replyToId or the recipient set changes', () => {
    const base = draftRevision(content());
    expect(draftRevision(content({ body: 'different' }))).not.toBe(base);
    expect(draftRevision(content({ subject: 'different' }))).not.toBe(base);
    expect(draftRevision(content({ replyToId: 99 }))).not.toBe(base);
    expect(draftRevision(content({ recipients: [] }))).not.toBe(base);
  });

  it('does not collide across a field-boundary shift', () => {
    // Naive concatenation would make these two identical.
    const a = draftRevision(content({ subject: 'ab', body: 'c' }));
    const b = draftRevision(content({ subject: 'a', body: 'bc' }));
    expect(a).not.toBe(b);
  });
});

describe('fetchServerDraft', () => {
  it('normalizes the OFW detail response into DraftContent', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValue({
      subject: 'Pickup',
      body: 'server body',
      replyToId: 12,
      recipients: [{ user: { userId: 42, name: 'Co Parent' } }],
    });
    await expect(fetchServerDraft(c, 5)).resolves.toEqual({
      subject: 'Pickup',
      body: 'server body',
      replyToId: 12,
      recipients: [{ userId: 42, name: 'Co Parent', viewedAt: null }],
    });
  });

  it('treats an empty/null response body as missing rather than throwing', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValue(null);
    await expect(fetchServerDraft(c, 5)).resolves.toBeNull();
  });

  it('defaults every absent field rather than propagating undefined', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValue({});
    await expect(fetchServerDraft(c, 5)).resolves.toEqual({
      subject: '', body: '', replyToId: null, recipients: [],
    });
  });

  it('returns null when the draft no longer exists on OFW (404)', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockRejectedValue(
      new Error('OFW API error: 404 Not Found for GET /pub/v3/messages/5'),
    );
    await expect(fetchServerDraft(c, 5)).resolves.toBeNull();
  });

  it('rethrows a transient failure as DraftFreshnessError (never a silent pass)', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockRejectedValue(
      new Error('OFW API error: 503 Service Unavailable for GET /pub/v3/messages/5'),
    );
    await expect(fetchServerDraft(c, 5)).rejects.toBeInstanceOf(DraftFreshnessError);
  });
});

describe('checkDraftFreshness', () => {
  it('is FRESH when the server matches the cached base', () => {
    const v = checkDraftFreshness({ server: content(), cached: content() });
    expect(v.verdict).toBe('FRESH');
  });

  it('is STALE when the server body diverges from the cached base', () => {
    const v = checkDraftFreshness({
      server: content({ body: 'edited in the OFW web app' }),
      cached: content(),
    });
    expect(v.verdict).toBe('STALE');
    expect(v.changedFields).toContain('body');
  });

  it('names every diverged field, not just the body', () => {
    const v = checkDraftFreshness({
      server: content({
        subject: 'Changed', body: 'changed', replyToId: 9,
        recipients: [{ userId: 1, name: 'X', viewedAt: null }],
      }),
      cached: content(),
    });
    expect(v.verdict).toBe('STALE');
    expect(v.changedFields).toEqual(['subject', 'body', 'replyToId', 'recipients']);
  });

  it('compares multi-recipient sets order-independently', () => {
    const two = [
      { userId: 42, name: 'A', viewedAt: null },
      { userId: 7, name: 'B', viewedAt: null },
    ];
    expect(checkDraftFreshness({
      server: content({ recipients: two }),
      cached: content({ recipients: [...two].reverse() }),
    }).verdict).toBe('FRESH');

    expect(checkDraftFreshness({
      server: content({ recipients: two }),
      cached: content({ recipients: [two[0], { userId: 99, name: 'C', viewedAt: null }] }),
    }).changedFields).toContain('recipients');
  });

  it('reports no changedFields on a token mismatch with nothing cached to diff', () => {
    const v = checkDraftFreshness({
      server: content(),
      cached: null,
      expectedRevision: 'r1:deadbeef',
    });
    expect(v.verdict).toBe('STALE');
    expect(v.changedFields).toEqual([]);
  });

  it('is STALE when the cache has no base at all for the id', () => {
    const v = checkDraftFreshness({ server: content(), cached: null });
    expect(v.verdict).toBe('STALE');
    expect(v.reason).toMatch(/not in the local cache/i);
  });

  it('is MISSING when the server has no such draft', () => {
    const v = checkDraftFreshness({ server: null, cached: content() });
    expect(v.verdict).toBe('MISSING');
  });

  it('is STALE when expectedRevision does not match the server revision', () => {
    const v = checkDraftFreshness({
      server: content(),
      cached: content(),
      expectedRevision: 'r1:deadbeef',
    });
    expect(v.verdict).toBe('STALE');
    expect(v.reason).toMatch(/expectedRevision/);
  });

  it('is FRESH when expectedRevision matches the server revision', () => {
    const v = checkDraftFreshness({
      server: content(),
      cached: content(),
      expectedRevision: draftRevision(content()),
    });
    expect(v.verdict).toBe('FRESH');
  });

  it('accepts a matching expectedRevision even when the cache holds no base', () => {
    // The token is a stronger assertion than the cached copy: a caller that
    // read the draft, then had its cache evicted, must not be blocked.
    const v = checkDraftFreshness({
      server: content(),
      cached: null,
      expectedRevision: draftRevision(content()),
    });
    expect(v.verdict).toBe('FRESH');
  });

  it('lets a matching token override a stale cached base', () => {
    // A caller that can name the current server revision has demonstrably read
    // it — that is the whole point of the token. A stale cached copy alongside
    // it is not evidence of a conflict.
    const v = checkDraftFreshness({
      server: content(),
      cached: content({ body: 'stale cached copy' }),
      expectedRevision: draftRevision(content()),
    });
    expect(v.verdict).toBe('FRESH');
  });
});

describe('staleDraftPayload', () => {
  it('carries the server body so nothing is silently lost', () => {
    const server = content({ body: 'the edits made in the web app' });
    const payload = staleDraftPayload({
      error: 'STALE_DRAFT',
      draftId: 535580725,
      verdict: checkDraftFreshness({ server, cached: content() }),
      server,
      cached: content(),
    });
    expect(payload.error).toBe('STALE_DRAFT');
    expect(payload.draftId).toBe(535580725);
    expect(payload.serverBody).toBe('the edits made in the web app');
    expect(payload.cachedBody).toBe(content().body);
    expect(payload.serverRevision).toBe(draftRevision(server));
    expect(payload.recovery).toMatch(/expectedRevision/);
  });

  it('omits serverBody when the draft is gone from the server', () => {
    const payload = staleDraftPayload({
      error: 'MISSING_DRAFT',
      draftId: 1,
      verdict: checkDraftFreshness({ server: null, cached: content() }),
      server: null,
      cached: content(),
    });
    expect(payload.serverBody).toBeUndefined();
    expect(payload.cachedBody).toBe(content().body);
  });
});
