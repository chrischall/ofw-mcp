import { describe, expect, it, vi, afterEach } from 'vitest';
import { compactMessage, compactDraft, viewMessages, viewDrafts, MESSAGE_VIEWS } from '../../src/tools/project.js';
import type { MessageRow, DraftRow } from '../../src/cache/store.js';

afterEach(() => vi.restoreAllMocks());

/** A row shaped like the ones the cache actually holds (verified against 1,335 live rows). */
function row(over: Partial<MessageRow> = {}): MessageRow & { read: boolean } {
  return {
    id: 533130648,
    folder: 'inbox',
    subject: 'Tyler Place 2027',
    // Empty on EVERY cached row ever observed — inbox and sent alike.
    fromUser: '',
    sentAt: '2026-07-10T23:38:50',
    recipients: [{ userId: 3039201, name: 'Chris Hall', viewedAt: null }],
    body: 'I sent a text today.\n\nThanks ',
    fetchedBodyAt: '2026-07-12T01:57:43.445Z',
    replyToId: null,
    chainRootId: null,
    read: true,
    listData: {
      id: 533130648,
      subject: 'Tyler Place 2027',
      date: { dateTime: '2026-07-10T23:38:50', displayDate: '7/10/2026', weekday: 'Friday' },
      showNeverViewed: false,
      recipients: [{ user: { name: 'Chris Hall', userId: 3039201, displayInitials: 'CH', color: '#3366CC' } }],
      folder: 13471258,
      draft: false,
      preview: 'I sent a text today...',
      files: 1,
      read: true,
      replied: false,
      canReply: true,
      author: { userId: 3039202, name: 'Alison Hall', displayInitials: 'AH', color: '#66AA00' },
    },
    ...over,
  } as MessageRow & { read: boolean };
}

describe('compactMessage', () => {
  it('drops listData, which is 58% of a page and 78% duplication', () => {
    const out = compactMessage(row());
    expect(out).not.toHaveProperty('listData');
  });

  it('keeps every field a caller can act on', () => {
    const out = compactMessage(row());
    expect(out).toMatchObject({
      id: 533130648,
      folder: 'inbox',
      subject: 'Tyler Place 2027',
      sentAt: '2026-07-10T23:38:50',
      read: true,
      replyToId: null,
      chainRootId: null,
      body: 'I sent a text today.\n\nThanks ',
      fetchedBodyAt: '2026-07-12T01:57:43.445Z',
    });
  });

  /**
   * The one field that was ONLY inside the blob. `fromUser` is the empty
   * string on all 1,335 rows in a real cache — inbox and sent — because OFW
   * puts the sender in the list payload's `author` and nowhere else. Deleting
   * listData without promoting this would have lost the sender's name from
   * every message, so compact is where that field starts working.
   */
  it('promotes the sender, which no top-level field has ever carried', () => {
    expect(compactMessage(row()).from).toBe('Alison Hall');
    expect(compactMessage(row()).fromUser).toBeUndefined();
  });

  it('prefers a real fromUser if OFW ever populates one', () => {
    expect(compactMessage(row({ fromUser: 'Someone Else' })).from).toBe('Someone Else');
  });

  it('says null rather than guessing when neither source names a sender', () => {
    expect(compactMessage(row({ listData: { files: 0 } })).from).toBeNull();
  });

  it('keeps the attachment count, which nothing else reports', () => {
    expect(compactMessage(row()).files).toBe(1);
  });

  it('normalises the attachment count OFW sends as an empty ARRAY (9 live rows do)', () => {
    expect(compactMessage(row({ listData: { files: [] } })).files).toBe(0);
  });

  it('keeps a VERIFIED zero rather than omitting it — 0 attachments is an answer', () => {
    expect(compactMessage(row({ listData: { files: 0 } })).files).toBe(0);
  });

  it('omits files entirely when OFW did not report it, never defaulting to 0', () => {
    // "We did not see a count" and "there are none" are different facts, and
    // the second one reads as verified.
    expect(compactMessage(row({ listData: {} }))).not.toHaveProperty('files');
  });

  it('keeps `replied`, which varies across 442 of 1,335 live rows', () => {
    expect(compactMessage(row()).replied).toBe(false);
  });

  it('drops the near-constant and the derivable', () => {
    const out = compactMessage(row());
    // canReply is true on 1,330 of 1,335; draft is answered by `folder`;
    // preview is a truncation of the body sitting beside it; showNeverViewed
    // is forced to agree with `read` before it is ever emitted.
    for (const key of ['canReply', 'draft', 'preview', 'showNeverViewed', 'archived', 'firstView']) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it('keeps the recipients the row already normalised, not OFW’s eight-field user objects', () => {
    expect(compactMessage(row()).recipients).toEqual([{ userId: 3039201, name: 'Chris Hall', viewedAt: null }]);
  });

  it('never alters a body — whitespace in a message is content', () => {
    const body = 'Line one.\n\n  Indented.\n\nTrailing:   ';
    expect(compactMessage(row({ body })).body).toBe(body);
  });

  it('survives a row whose listData is null or a legacy string', () => {
    expect(compactMessage(row({ listData: null })).from).toBeNull();
    expect(compactMessage(row({ listData: 'legacy' })).from).toBeNull();
  });
});

describe('compactDraft', () => {
  const draft = {
    id: 99,
    subject: 'Re: schedule',
    body: 'body text',
    recipients: [{ userId: 1, name: 'A', viewedAt: null }],
    replyToId: 42,
    modifiedAt: '2026-07-10T23:38:50',
    listData: { date: { dateTime: 'x', weekday: 'Friday' }, author: { name: 'Me' }, preview: 'body...' },
    revision: 'abc',
    draftKey: 'dk_1',
    cacheStatus: 'fresh',
  } as unknown as DraftRow & Record<string, unknown>;

  it('drops listData but keeps the fields a write must echo back', () => {
    const out = compactDraft(draft);
    expect(out).not.toHaveProperty('listData');
    // revision and draftKey are the concurrency token and the stable identity;
    // losing either to a projection would break every guarded write.
    expect(out).toMatchObject({ id: 99, revision: 'abc', draftKey: 'dk_1', cacheStatus: 'fresh', replyToId: 42 });
  });

  it('keeps the body in full — a draft IS its body', () => {
    expect(compactDraft(draft).body).toBe('body text');
  });
});

describe('the view selector', () => {
  it('offers compact and full, and NOT raw', () => {
    // A message row is assembled from the list endpoint and the detail GET,
    // so there is no single upstream payload to hand back.
    expect(MESSAGE_VIEWS).toEqual(['compact', 'full']);
  });

  it('projects for compact and passes the rows through for full', () => {
    const rows = [row()];
    expect(viewMessages('compact', rows)[0]).not.toHaveProperty('listData');
    expect(viewMessages('full', rows)[0]).toHaveProperty('listData');
    expect(viewMessages('full', rows)[0]).toBe(rows[0]);
  });

  it('returns the rows UNPROJECTED and warns when the projection trips', () => {
    // The property that makes compact-by-default survivable: a cache row that
    // is not the shape this projector expects yields everything, not a record
    // with holes in it that reads like a verified answer.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hostile = [Object.defineProperty({}, 'listData', { get() { throw new Error('boom'); } })] as unknown as MessageRow[];
    expect(viewMessages('compact', hostile)[0]).toBe(hostile[0]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ofw-mcp'));
  });

  it('projects the whole array or none of it, so one bad row cannot half-answer', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [row(), Object.defineProperty({}, 'listData', { get() { throw new Error('boom'); } })] as unknown as MessageRow[];
    expect(viewMessages('compact', rows)).toBe(rows);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('viewDrafts behaves the same way', () => {
    const drafts = [{ id: 1, subject: 's', body: 'b', recipients: [], replyToId: null, modifiedAt: 'x', listData: {} }] as DraftRow[];
    expect(viewDrafts('compact', drafts)[0]).not.toHaveProperty('listData');
    expect(viewDrafts('full', drafts)).toBe(drafts);
  });
});
