import { describe, it, expect } from 'vitest';
import {
  findRecordArray, findTotal, offsetState, pageState, truncationSentinel, withPaginationFirst,
} from '../../src/tools/pagination.js';

describe('pageState', () => {
  it('decides hasMore from the OFFSET, not from returned-vs-total', () => {
    expect(pageState({ page: 1, size: 60, total: 391 })).toEqual({ hasMore: true, nextPage: 2 });
    expect(pageState({ page: 7, size: 60, total: 391 })).toEqual({ hasMore: false, nextPage: null });
    expect(pageState({ page: 1, size: 60, total: 60 })).toEqual({ hasMore: false, nextPage: null });
    // Past the end: an empty page must not advertise a next page that would
    // also be empty, forever.
    expect(pageState({ page: 9, size: 60, total: 3 })).toEqual({ hasMore: false, nextPage: null });
    expect(pageState({ page: 1, size: 60, total: 0 })).toEqual({ hasMore: false, nextPage: null });
  });
});

describe('truncationSentinel', () => {
  it('carries the remedy and nothing that could pass for a record', () => {
    const s = truncationSentinel({ shown: 60, total: 391, nextPage: 2, what: 'messages', argsHint: 'page:2' });
    expect(s._truncated).toBe(true);
    expect(s.shown).toBe(60);
    expect(s.total).toBe(391);
    expect(s.nextPage).toBe(2);
    expect(s.hint).toMatch(/NOT THE FULL RESULT SET/);
    expect(s.hint).toMatch(/page:2/);
    expect(Object.keys(s)).toEqual(['_truncated', 'shown', 'total', 'nextPage', 'hint']);
  });
});

describe('offsetState', () => {
  it('uses the total when the upstream reports one', () => {
    expect(offsetState({ start: 0, max: 20, returned: 20, total: 55 })).toEqual({ hasMore: true, nextStart: 20 });
    expect(offsetState({ start: 40, max: 20, returned: 15, total: 55 })).toEqual({ hasMore: false, nextStart: null });
  });

  it('without a total, treats a FULL page as probably-more and a short page as the end', () => {
    // The bias is one-directional on purpose: a wasted call beats a hidden page.
    expect(offsetState({ start: 0, max: 20, returned: 20, total: null })).toEqual({ hasMore: true, nextStart: 20 });
    expect(offsetState({ start: 0, max: 20, returned: 3, total: null })).toEqual({ hasMore: false, nextStart: null });
    expect(offsetState({ start: 0, max: 20, returned: 0, total: null })).toEqual({ hasMore: false, nextStart: null });
  });
});

describe('findRecordArray', () => {
  it('finds the rows whether the payload wraps them or IS them', () => {
    expect(findRecordArray({ data: [1, 2] })).toEqual({ key: 'data', rows: [1, 2] });
    expect(findRecordArray({ total: 9, entries: [1] })).toEqual({ key: 'entries', rows: [1] });
    expect(findRecordArray([1, 2, 3])).toEqual({ key: null, rows: [1, 2, 3] });
  });

  it('returns null when there is no array to find', () => {
    expect(findRecordArray({ total: 9 })).toBeNull();
    expect(findRecordArray(null)).toBeNull();
    expect(findRecordArray('nope')).toBeNull();
  });
});

describe('findTotal', () => {
  it('reads any of the common total spellings, and only numbers', () => {
    expect(findTotal({ total: 55 })).toBe(55);
    expect(findTotal({ totalCount: 12 })).toBe(12);
    expect(findTotal({ totalResults: 7 })).toBe(7);
    expect(findTotal({ count: 4 })).toBe(4);
    expect(findTotal({ total: '55' })).toBeNull();
    expect(findTotal({ total: Number.NaN })).toBeNull();
    expect(findTotal({ entries: [] })).toBeNull();
    expect(findTotal([1, 2])).toBeNull();
    expect(findTotal(null)).toBeNull();
  });
});

describe('withPaginationFirst', () => {
  it('spreads an OBJECT payload in behind the paging keys, renaming and dropping nothing', () => {
    const payload = { total: 55, entries: [{ id: 1 }], someUpstreamExtra: true };
    const out = withPaginationFirst({
      state: offsetState({ start: 0, max: 20, returned: 1, total: 55 }),
      start: 0, max: 20, returned: 1, total: 55,
      hint: 'Re-call with start:20.', payload, dataKey: 'entries',
    });

    // Paging first, records after — the property this whole change is for.
    const keys = Object.keys(out);
    expect(keys[0]).toBe('hasMore');
    expect(keys.indexOf('nextStart')).toBeLessThan(keys.indexOf('entries'));
    expect(keys.indexOf('paginationNote')).toBeLessThan(keys.indexOf('entries'));
    // Every upstream key survives.
    expect(out.entries).toEqual([{ id: 1 }]);
    expect(out.someUpstreamExtra).toBe(true);
    expect(out.nextStart).toBe(20);
    expect(out.paginationNote).toMatch(/PARTIAL/);
    expect(out.paginationNote).toMatch(/of 55/);
    expect(out.dataShapeNote).toBeUndefined();
    // The upstream's own `total` wins the key — same value we computed with.
    expect(out.total).toBe(55);
  });

  it('nests a BARE-ARRAY payload and says so, since an array cannot carry sibling keys', () => {
    const out = withPaginationFirst({
      state: offsetState({ start: 0, max: 20, returned: 20, total: null }),
      start: 0, max: 20, returned: 20, total: null,
      hint: 'Re-call with start:20.', payload: [{ id: 1 }], dataKey: 'expenses',
    });

    expect(out.expenses).toEqual([{ id: 1 }]);
    expect(out.dataShapeNote).toMatch(/bare array/);
    expect(out.total).toBeUndefined();
    expect(out.paginationNote).toMatch(/probably more/);
    expect(Object.keys(out).indexOf('hasMore')).toBeLessThan(Object.keys(out).indexOf('expenses'));
  });

  it('says plainly when the response reaches the end, with and without a total', () => {
    const withTotal = withPaginationFirst({
      state: offsetState({ start: 0, max: 20, returned: 3, total: 3 }),
      start: 0, max: 20, returned: 3, total: 3,
      hint: 'x', payload: { data: [] }, dataKey: 'expenses',
    });
    expect(withTotal.hasMore).toBe(false);
    expect(withTotal.paginationNote).toMatch(/reaches the end/);
    expect(withTotal.paginationNote).toMatch(/3 record\(s\) in total/);

    const noTotal = withPaginationFirst({
      state: offsetState({ start: 0, max: 20, returned: 3, total: null }),
      start: 0, max: 20, returned: 3, total: null,
      hint: 'x', payload: null, dataKey: 'expenses',
    });
    expect(noTotal.hasMore).toBe(false);
    expect(noTotal.paginationNote).toMatch(/came back short/);
    // A non-object, non-array payload still round-trips under the data key.
    expect(noTotal.expenses).toBeNull();
  });
});
