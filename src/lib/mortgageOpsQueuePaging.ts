/**
 * Mortgage Ops queue paging. The data API returns at most 500 rows per read
 * (aws/functions/api/data.mjs MAX_PAGE_LIMIT), so the queue reads each list
 * (queued, mine in progress, mine completed) with its own server-side filter,
 * page by page, and checks what it collected against an exact count: a list
 * that is longer than what was loaded says so instead of losing rows silently.
 *
 * No "@/" imports: aws/tests load this file with --experimental-strip-types.
 */

/** The data API's largest page (MAX_PAGE_LIMIT). */
export const MORTGAGE_QUEUE_PAGE_SIZE = 500;
/** Safety stop for one list: 40 pages = 20,000 rows. */
export const MORTGAGE_QUEUE_MAX_PAGES = 40;
/** Completed work is shown newest first, this many at a time ("Load more"). */
export const MORTGAGE_QUEUE_COMPLETED_STEP = 100;

export type QueuePage<T> = { data: T[] | null; error: unknown; count?: number | null };

export interface QueueList<T> {
  rows: T[];
  /** Exact number of matching rows on the server (from the first page's count), or null if unknown. */
  total: number | null;
  /** True when fewer rows were loaded than the server holds (a cap, maxRows, or rows that moved between pages). */
  incomplete: boolean;
  error: unknown;
}

/**
 * Reads pages [from, to] until a short page, maxRows, or the page cap. The
 * first page asks for an exact count (fetchPage receives withCount = true).
 * Rows are de-duplicated by id (offset paging can repeat a row that moved).
 */
export async function fetchQueueList<T extends { id: string }>(
  fetchPage: (from: number, to: number, withCount: boolean) => PromiseLike<QueuePage<T>>,
  opts: { pageSize?: number; maxPages?: number; maxRows?: number } = {},
): Promise<QueueList<T>> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? MORTGAGE_QUEUE_PAGE_SIZE, MORTGAGE_QUEUE_PAGE_SIZE));
  const maxPages = Math.max(1, opts.maxPages ?? MORTGAGE_QUEUE_MAX_PAGES);
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  const rows: T[] = [];
  let total: number | null = null;
  for (let page = 0; page < maxPages && rows.length < maxRows; page += 1) {
    const from = page * pageSize;
    const size = Math.min(pageSize, maxRows - rows.length);
    const out = await fetchPage(from, from + size - 1, page === 0);
    if (out.error) return { rows, total, incomplete: true, error: out.error };
    if (page === 0 && typeof out.count === "number") total = out.count;
    const data = Array.isArray(out.data) ? out.data : [];
    for (const row of data) {
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (data.length < size) break;
    if (total !== null && from + data.length >= total) break;
  }
  const incomplete = total !== null ? rows.length < total : rows.length >= maxRows;
  return { rows: rows.slice(0, Number.isFinite(maxRows) ? maxRows : rows.length), total, incomplete, error: null };
}

/** "12" or "100 of 340": what a tab badge shows. */
export function queueCountLabel(list: { rows: unknown[]; total: number | null }): string {
  if (list.total !== null && list.total > list.rows.length) return `${list.rows.length} of ${list.total}`;
  return String(list.total ?? list.rows.length);
}
