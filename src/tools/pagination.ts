/**
 * Pagination state that survives lossy consumption.
 *
 * The failure this module exists to prevent: a correct response was ignored.
 * Three wide date-range reads each returned `complete:false` alongside a `note`
 * and a `completeNote` spelling out that the page held 60 of 391 and how to get
 * the rest. The responses were large, so the client spilled them to a JSON file
 * and a script pulled out `total` and `messages` — dropping every field that
 * said "this is a slice". The caller then reported October 1-28 as unreachable.
 *
 * The tool cannot fix a cherry-picking script. It can stop being easy to
 * cherry-pick wrongly, which is what these helpers encode:
 *
 *  - **State before bulk.** Callers place the paging/freshness keys ahead of the
 *    data array, so a `head`, a truncated preview, or a partial read reaches
 *    "this is 60 of 391" before it reaches the first message body. Key order in
 *    JSON is free — an object literal's insertion order is what JSON.stringify
 *    emits — so this costs nothing and is pure upside.
 *  - **The remedy is a value, not an inference.** `complete:false` tells a
 *    reader something is wrong; `nextPage: 2` tells it what to do. A reader that
 *    understands neither prose nor booleans can still act on an integer.
 *  - **Truncation is in the data's own path.** {@link truncationSentinel} puts a
 *    marker in the array itself, so a consumer that iterates or slices the
 *    array — precisely what a field-extracting script does — trips over it.
 *    Applied only where an extra element cannot be mistaken for a record; see
 *    the callers for the per-tool judgement.
 */

/** Paging state for a `page`/`size` tool, derived from what the read returned. */
export interface PageState {
  /** True when items remain beyond this payload. */
  hasMore: boolean;
  /** The `page` value to pass to fetch the next slice. Null when nothing remains. */
  nextPage: number | null;
}

/**
 * Compute paging state for a 1-based `page`/`size` read.
 *
 * `hasMore` is decided from the OFFSET, not from `returned < total`: on a page
 * past the end of the result set, `returned` is 0 while `total` is large, and
 * comparing those two would advertise a `nextPage` that returns nothing forever.
 */
export function pageState(input: { page: number; size: number; total: number }): PageState {
  const hasMore = input.page * input.size < input.total;
  return { hasMore, nextPage: hasMore ? input.page + 1 : null };
}

/** The marker appended to a truncated array. Shaped so no field of it reads as a record's own. */
export interface TruncationSentinel {
  _truncated: true;
  shown: number;
  total: number;
  nextPage: number;
  hint: string;
}

/**
 * Build the sentinel element for a truncated array.
 *
 * Deliberately carries no `id`/`subject`/`sentAt`: a consumer that keys records
 * by id skips it rather than half-reading it as a message, while a consumer
 * that counts or prints elements sees it. `_truncated` leads with an underscore
 * so it sorts and reads as metadata, not content.
 */
export function truncationSentinel(input: {
  shown: number;
  total: number;
  nextPage: number;
  what: string;
  argsHint: string;
}): TruncationSentinel {
  return {
    _truncated: true,
    shown: input.shown,
    total: input.total,
    nextPage: input.nextPage,
    hint: `NOT THE FULL RESULT SET: ${input.shown} of ${input.total} ${input.what} are in this array. `
      + `Re-call with ${input.argsHint} to continue. Do not state a total, a date coverage, or an absence from this array alone.`,
  };
}

/** Paging state for an offset/limit tool (`start`/`max`), where the server may not report a total. */
export interface OffsetState {
  hasMore: boolean;
  /** The `start` value to pass to fetch the next slice. Null when nothing remains. */
  nextStart: number | null;
}

/**
 * Compute paging state for a `start`/`max` read.
 *
 * When the upstream response carries no total there is no way to KNOW whether
 * more remain, so a full page is treated as "probably more". The bias is
 * deliberate and one-directional: a `nextStart` that turns out to return an
 * empty page costs one wasted call, while a null that hides a further page
 * reproduces the exact bug this file is about — a slice narrated as the whole.
 */
export function offsetState(input: { start: number; max: number; returned: number; total: number | null }): OffsetState {
  const hasMore = input.total === null
    ? input.returned >= input.max
    : input.start + input.returned < input.total;
  return { hasMore, nextStart: hasMore ? input.start + input.max : null };
}

/**
 * Count the records in a raw upstream list payload, and find the array itself.
 *
 * OFW's list endpoints return an object wrapping the rows (`{data: [...]}` on
 * /pub/v3/messages, `{systemFolders: [...]}` on /pub/v1/messageFolders), but
 * the expense and journal endpoints are unvalidated passthroughs whose shape is
 * not recorded anywhere, so a bare array is handled too rather than assumed
 * away.
 */
export function findRecordArray(payload: unknown): { key: string | null; rows: unknown[] } | null {
  if (Array.isArray(payload)) return { key: null, rows: payload };
  if (typeof payload !== 'object' || payload === null) return null;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (Array.isArray(value)) return { key, rows: value };
  }
  return null;
}

/** Read a numeric `total`-ish field off a raw upstream payload, if it has one. */
export function findTotal(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  for (const key of ['total', 'totalCount', 'totalResults', 'count']) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Wrap a raw upstream list payload so its paging state comes FIRST, without
 * renaming or dropping anything the upstream sent.
 *
 * An object payload is spread in behind the paging keys, so every key it had
 * stays exactly where a caller expects to find it — only the order changes. A
 * bare-array payload cannot carry sibling keys at all, so it is nested under
 * `dataKey` and the response says so; that is the one shape change here, and it
 * is the price of a bare array being unable to describe itself.
 */
export function withPaginationFirst(input: {
  state: OffsetState;
  start: number;
  max: number;
  returned: number;
  total: number | null;
  hint: string;
  payload: unknown;
  dataKey: string;
}): Record<string, unknown> {
  const head: Record<string, unknown> = {
    hasMore: input.state.hasMore,
    nextStart: input.state.nextStart,
    start: input.start,
    max: input.max,
    returned: input.returned,
    ...(input.total !== null ? { total: input.total } : {}),
    paginationNote: input.state.hasMore
      ? `PARTIAL: this response holds ${input.returned} record(s) starting at ${input.start}`
        + `${input.total !== null ? ` of ${input.total}` : ' and there are probably more (the page came back full)'}. `
        + `${input.hint} Do not state a total or an absence from this response alone.`
      : `This response reaches the end of the list${input.total !== null ? ` (${input.total} record(s) in total)` : ' (the page came back short, so there is nothing after it)'}.`,
  };

  if (typeof input.payload === 'object' && input.payload !== null && !Array.isArray(input.payload)) {
    return { ...head, ...(input.payload as Record<string, unknown>) };
  }
  return {
    ...head,
    dataShapeNote: `OurFamilyWizard returned a bare array for this endpoint, which cannot carry the fields above alongside it. The records are under \`${input.dataKey}\`.`,
    [input.dataKey]: input.payload,
  };
}
