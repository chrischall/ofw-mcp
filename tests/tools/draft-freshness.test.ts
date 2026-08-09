import { describe, it, expect, vi } from 'vitest';
import { OFWClient } from '../../src/client.js';
import {
  draftRevision,
  fetchServerDraft,
  fetchMessageSnapshot,
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

  it('derives the reply target from inReplyTo when replyToId is null (both spellings of the threading echo)', async () => {
    // OFW reports the reply target as replyToId on some payloads and as
    // inReplyTo on others. The snapshot must derive ONE value from whichever
    // is present, so the revision hashed here matches the one ofw_save_draft
    // computed from the same server state.
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValue({
      subject: 'Pickup', body: 'server body',
      replyToId: null, inReplyTo: 538672434, recipients: [],
    });
    await expect(fetchServerDraft(c, 5)).resolves.toMatchObject({ replyToId: 538672434 });
  });

  it('does not hard-fail on either spelling of folder.id (strict boundary)', async () => {
    // This schema is parsed strict — a throw here ABORTS ofw_save_draft /
    // ofw_delete_draft. OFW types this id as a string on the folders listing
    // and a number on message detail, so both must parse, and both must
    // normalize to the same string for comparison.
    for (const id of ['3', 3]) {
      const c = new OFWClient();
      vi.spyOn(c, 'request').mockResolvedValue({
        subject: 'Pickup', body: 'server body', replyToId: null, recipients: [],
        folder: { id, name: 'Drafts' },
      });
      const snap = await fetchMessageSnapshot(c, 5);
      expect(snap?.folderId).toBe('3');
      expect(snap?.folderName).toBe('Drafts');
    }
  });

  it('reports a null folderId when OFW omits the folder entirely', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValue({ subject: 'S', body: 'B' });
    const snap = await fetchMessageSnapshot(c, 5);
    expect(snap?.folderId).toBeNull();
    expect(snap?.folderName).toBeNull();
    expect(snap?.dateTime).toBeNull();
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

  it('does NOT refuse when only connector-authored metadata (replyToId) drifted, token path', () => {
    // The false positive this fix targets: a caller captured its revision from
    // its own save, then OFW normalized the draft's replyToId. The body/subject/
    // recipients are untouched, so this is the connector's own mutation, not a
    // third-party edit — it must not read as STALE.
    const cached = content({ replyToId: 537280390 });
    const v = checkDraftFreshness({
      server: content({ replyToId: null }), // OFW dropped the reply link
      cached,
      expectedRevision: draftRevision(cached), // the pre-normalization revision
    });
    expect(v.verdict).toBe('FRESH');
    expect(v.metadataOnly).toBe(true);
    expect(v.changedFields).toEqual(['replyToId']);
  });

  it('does NOT refuse a metadata-only drift on the no-token path either', () => {
    const v = checkDraftFreshness({
      server: content({ replyToId: 99 }),
      cached: content({ replyToId: null }),
    });
    expect(v.verdict).toBe('FRESH');
    expect(v.metadataOnly).toBe(true);
    expect(v.changedFields).toEqual(['replyToId']);
  });

  it('STILL refuses when a substantive field diverges alongside metadata (token path)', () => {
    // Regression guard: relaxing metadata must not weaken the real protection.
    const cached = content();
    const v = checkDraftFreshness({
      server: content({ body: 'edited elsewhere', replyToId: 99 }),
      cached,
      expectedRevision: draftRevision(cached),
    });
    expect(v.verdict).toBe('STALE');
    expect(v.metadataOnly).toBeUndefined();
    expect(v.changedFields).toContain('body');
  });

  it('STILL refuses a substantive divergence on the no-token path', () => {
    const v = checkDraftFreshness({
      server: content({ body: 'edited elsewhere', replyToId: 99 }),
      cached: content(),
    });
    expect(v.verdict).toBe('STALE');
    expect(v.changedFields).toContain('body');
  });

  it('does not grant a metadata pass when the token is not the cached revision', () => {
    // A token that does not match our cache is not evidence of what the caller
    // edited from, so we cannot prove the drift is metadata-only — refuse.
    const v = checkDraftFreshness({
      server: content({ replyToId: 99 }),
      cached: content({ replyToId: null }),
      expectedRevision: 'r1:someothervalue',
    });
    expect(v.verdict).toBe('STALE');
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
