import { describe, it, expect, beforeEach } from 'vitest';
import { OFWCache } from '../../src/cache/node.js';
import { clearReplyToSource, getReplyToSource, replyToSourceField, setReplyToSource } from '../../src/tools/reply-source.js';

describe('reply-source meta', () => {
  let cache: OFWCache;
  beforeEach(() => { cache = OFWCache.open(':memory:'); });

  it('clearing removes the row, not just its value', async () => {
    await setReplyToSource(cache, 1, 'cache');
    await clearReplyToSource(cache, 1);
    expect(await cache.getMeta('draft_reply_source:1')).toBeNull();
    // Clearing what was never set is fine: a draft may predate the key.
    await expect(clearReplyToSource(cache, 2)).resolves.toBeUndefined();
  });

  it('round-trips a cache-sourced target', async () => {
    await setReplyToSource(cache, 1, 'cache');
    expect(await getReplyToSource(cache, 1, 100)).toBe('cache');
    expect(await replyToSourceField(cache, 1, 100)).toEqual({ replyToSource: 'cache' });
  });

  it('reads a server-sourced, cleared or never-recorded target as server', async () => {
    await setReplyToSource(cache, 1, 'server');
    await setReplyToSource(cache, 2, null);
    expect(await getReplyToSource(cache, 1, 100)).toBe('server');
    expect(await getReplyToSource(cache, 2, 100)).toBe('server');
    expect(await getReplyToSource(cache, 3, 100)).toBe('server');
  });

  it('has no source for a draft without a reply target', async () => {
    await setReplyToSource(cache, 1, 'cache');
    expect(await getReplyToSource(cache, 1, null)).toBeNull();
    expect(await replyToSourceField(cache, 1, null)).toEqual({});
  });
});
