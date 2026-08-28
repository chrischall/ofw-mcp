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
 *  - **The honest count is a scalar, not the array's length.** `returned` sits
 *    in the header beside `total`, so a consumer never has to reach the array
 *    to learn how many records came back.
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

/** Paging state for an offset/limit tool (`start`/`max`). */
export interface OffsetState {
  hasMore: boolean;
  /** The `start` value to pass to fetch the next slice. Null when nothing remains. */
  nextStart: number | null;
}

/**
 * The paging facts OFW's own `metadata` envelope carries, if any.
 *
 * Verified against live `/pub/v2/expense/expenses` and `/pub/v1/journals`
 * responses: both return `{data: [...], metadata: {...}}`, and both metadata
 * blocks carry a `last` boolean. Journal additionally reports `totalElements`;
 * expenses does not.
 *
 * `count` is deliberately NOT read as a total. A live expenses response came
 * back `{data: [], metadata: {count: 20, perPage: 20, ...}}` — `count` tracks
 * the PAGE SIZE, not the result count, so trusting it would report "20
 * expenses" for an empty page.
 */
export interface UpstreamPaging {
  /** Records in this page. */
  returned: number;
  /** Total across all pages, when the upstream reports one. */
  total: number | null;
  /** OFW's own "this is the final page" verdict, when present. */
  last: boolean | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Read the paging facts out of an OFW `{data, metadata}` list envelope. */
function recordArray(root: Record<string, unknown>): unknown[] | null {
  // `data` is the envelope both endpoints actually use, so it wins outright.
  // Falling back to the first array-valued key matters because the alternative
  // is silently publishing `returned: 0` and a "reaches the end of the list"
  // note ALONGSIDE real records — the precise shape of lie this file exists to
  // prevent, reintroduced by a backend rename.
  if (Array.isArray(root.data)) return root.data;
  for (const value of Object.values(root)) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

export function readUpstreamPaging(payload: unknown): UpstreamPaging {
  const root = asRecord(payload);
  const rows = root === null ? null : recordArray(root);
  const meta = root === null ? null : asRecord(root.metadata);
  const total = meta !== null && typeof meta.totalElements === 'number' && Number.isFinite(meta.totalElements)
    ? meta.totalElements
    : null;
  const last = meta !== null && typeof meta.last === 'boolean' ? meta.last : null;
  return { returned: rows?.length ?? 0, total, last };
}

/**
 * Compute paging state for a `start`/`max` read, best evidence first.
 *
 * OFW's own `metadata.last` is authoritative and used whenever present. Failing
 * that, a reported total settles it. Failing both, a FULL page is treated as
 * probably-more: the bias is one-directional on purpose, because a `nextStart`
 * that returns an empty page costs one wasted call, while a null that hides a
 * further page reproduces the bug this file exists for — a slice narrated as
 * the whole.
 */
export function offsetState(input: {
  start: number;
  max: number;
  returned: number;
  total: number | null;
  last?: boolean | null;
  /**
   * The `start` value that addresses the FIRST record: 0 for
   * `ofw_list_expenses`, 1 for `ofw_list_journal_entries`. Required to turn
   * `start` into a consumed count — assuming 0 for a 1-based tool overstates
   * consumption by one and hides the final record at the exactly-one-remaining
   * boundary (start:1, max:10, returned:10, total:11 reported "no more" while
   * record 11 existed).
   */
  base: 0 | 1;
}): OffsetState {
  const last = input.last ?? null;
  const consumed = input.start - input.base + input.returned;
  const hasMore = last !== null
    ? !last
    : input.total !== null
      ? consumed < input.total
      : input.returned >= input.max;
  return { hasMore, nextStart: hasMore ? input.start + input.max : null };
}

/**
 * Prepend paging state to an OFW list envelope, renaming and dropping nothing.
 *
 * The upstream object is spread in BEHIND the paging keys, so every key it had
 * stays exactly where a caller expects to find it — only the order changes.
 * The head is then spread a SECOND time: a plain `{...head, ...body}` lets an
 * upstream `hasMore`/`nextStart`/`paginationNote` overwrite the computed value
 * while keeping the head's key position, which is worse than either — a paging
 * field sitting in the paging slot, reading as ours, sourced from elsewhere.
 * Re-spreading restores our values; keys keep their first-insertion position,
 * so the order is unchanged.
 * Returns null when the payload is not a plain object and therefore cannot
 * carry sibling keys at all; the caller then passes it through untouched rather
 * than relocating it, so this can never change a response's top-level shape.
 */
export function withPaginationFirst(input: {
  state: OffsetState;
  start: number;
  max: number;
  returned: number;
  total: number | null;
  hint: string;
  payload: unknown;
}): Record<string, unknown> | null {
  const body = asRecord(input.payload);
  if (body === null) return null;

  const scope = input.total !== null ? ` of ${input.total}` : '';
  const head: Record<string, unknown> = {
    hasMore: input.state.hasMore,
    nextStart: input.state.nextStart,
    start: input.start,
    max: input.max,
    returned: input.returned,
    ...(input.total !== null ? { total: input.total } : {}),
    paginationNote: input.state.hasMore
      ? `PARTIAL: this response holds ${input.returned} record(s) starting at ${input.start}${scope}. `
        + `${input.hint} Do not state a total or an absence from this response alone.`
      : `This response reaches the end of the list${scope === '' ? '' : ` (${input.total} record(s) in total)`}.`,
  };
  return { ...head, ...body, ...head };
}
