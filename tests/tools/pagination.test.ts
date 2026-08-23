import { describe, it, expect } from 'vitest';
import {
  offsetState, pageState, readUpstreamPaging, withPaginationFirst,
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

describe('readUpstreamPaging', () => {
  it('reads the live OFW envelope: journal reports totalElements and last', () => {
    // Shape captured from a live /pub/v1/journals response.
    expect(readUpstreamPaging({
      metadata: { currentPage: 1, totalPages: 0, totalElements: 0, perPage: 1, first: true, last: true },
      data: [],
    })).toEqual({ returned: 0, total: 0, last: true });
  });

  it('reads the live OFW envelope: expenses reports last but NO total, and `count` is not one', () => {
    // Shape captured from a live /pub/v2/expense/expenses response. `count`
    // sat next to an EMPTY data array — it tracks page size, not the result
    // count, so reading it as a total would report 20 expenses for 0 records.
    expect(readUpstreamPaging({
      data: [],
      metadata: { perPage: 20, currentPage: 1, page: 1, count: 20, first: true, last: true },
    })).toEqual({ returned: 0, total: null, last: true });
  });

  it('counts the records it did find, and degrades to nulls on an unrecognised shape', () => {
    expect(readUpstreamPaging({ data: [1, 2, 3], metadata: { last: false } }))
      .toEqual({ returned: 3, total: null, last: false });
    expect(readUpstreamPaging({ data: [1], metadata: { totalElements: 'nine', last: 'yes' } }))
      .toEqual({ returned: 1, total: null, last: null });
    expect(readUpstreamPaging({ data: 'not an array' })).toEqual({ returned: 0, total: null, last: null });
    expect(readUpstreamPaging({ message: 'no records' })).toEqual({ returned: 0, total: null, last: null });
    expect(readUpstreamPaging([1, 2])).toEqual({ returned: 0, total: null, last: null });
    expect(readUpstreamPaging(null)).toEqual({ returned: 0, total: null, last: null });
  });
});

describe('offsetState', () => {
  it("trusts OFW's own `last` over any inference", () => {
    // A FULL page that the server calls the last one is the last one — the
    // heuristic below would have said "probably more" and been wrong.
    expect(offsetState({ start: 0, max: 20, returned: 20, total: null, last: true }))
      .toEqual({ hasMore: false, nextStart: null });
    // And a SHORT page the server does not call last still continues.
    expect(offsetState({ start: 0, max: 20, returned: 3, total: null, last: false }))
      .toEqual({ hasMore: true, nextStart: 20 });
  });

  it('falls back to the total when there is no `last`', () => {
    expect(offsetState({ start: 0, max: 20, returned: 20, total: 55, last: null })).toEqual({ hasMore: true, nextStart: 20 });
    expect(offsetState({ start: 40, max: 20, returned: 15, total: 55, last: null })).toEqual({ hasMore: false, nextStart: null });
  });

  it('with neither, treats a FULL page as probably-more and a short page as the end', () => {
    // The bias is one-directional on purpose: a wasted call beats a hidden page.
    expect(offsetState({ start: 0, max: 20, returned: 20, total: null })).toEqual({ hasMore: true, nextStart: 20 });
    expect(offsetState({ start: 0, max: 20, returned: 3, total: null })).toEqual({ hasMore: false, nextStart: null });
  });
});

describe('withPaginationFirst', () => {
  it('spreads the envelope in behind the paging keys, renaming and dropping nothing', () => {
    const payload = { data: [{ id: 1 }], metadata: { last: false, totalElements: 55 } };
    const out = withPaginationFirst({
      state: offsetState({ start: 0, max: 20, returned: 1, total: 55, last: false }),
      start: 0, max: 20, returned: 1, total: 55,
      hint: 'Re-call with start:20.', payload,
    }) as Record<string, unknown>;

    // Paging first, records after — the property this whole change is for.
    const keys = Object.keys(out);
    expect(keys[0]).toBe('hasMore');
    expect(keys.indexOf('nextStart')).toBeLessThan(keys.indexOf('data'));
    expect(keys.indexOf('paginationNote')).toBeLessThan(keys.indexOf('data'));
    // Every upstream key survives, untouched.
    expect(out.data).toEqual([{ id: 1 }]);
    expect(out.metadata).toEqual({ last: false, totalElements: 55 });
    expect(out.nextStart).toBe(20);
    expect(out.paginationNote).toMatch(/PARTIAL/);
    expect(out.paginationNote).toMatch(/of 55/);
  });

  it('says plainly when the response reaches the end, with and without a total', () => {
    const withTotal = withPaginationFirst({
      state: offsetState({ start: 0, max: 20, returned: 3, total: 3, last: true }),
      start: 0, max: 20, returned: 3, total: 3, hint: 'x', payload: { data: [] },
    }) as Record<string, unknown>;
    expect(withTotal.hasMore).toBe(false);
    expect(withTotal.paginationNote).toMatch(/reaches the end/);
    expect(withTotal.paginationNote).toMatch(/3 record\(s\) in total/);
    expect(withTotal.total).toBe(3);

    const noTotal = withPaginationFirst({
      state: offsetState({ start: 0, max: 20, returned: 3, total: null, last: true }),
      start: 0, max: 20, returned: 3, total: null, hint: 'x', payload: { data: [] },
    }) as Record<string, unknown>;
    expect(noTotal.paginationNote).toMatch(/reaches the end/);
    expect(noTotal.total).toBeUndefined();
  });

  it('returns null for a payload that cannot carry sibling keys, so the caller passes it through', () => {
    // Never relocate records to add a field: a bare array or a scalar keeps
    // its exact top-level shape instead.
    const args = {
      state: offsetState({ start: 0, max: 20, returned: 0, total: null }),
      start: 0, max: 20, returned: 0, total: null, hint: 'x',
    };
    expect(withPaginationFirst({ ...args, payload: [{ id: 1 }] })).toBeNull();
    expect(withPaginationFirst({ ...args, payload: null })).toBeNull();
    expect(withPaginationFirst({ ...args, payload: 'nope' })).toBeNull();
  });
});
