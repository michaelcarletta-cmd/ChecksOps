/**
 * Every react-query root that shows the Check Command Center queue or one of
 * its counts. After a check is created (upload, cash-job upload, homeowner
 * upload processed to Review) or a background refresh tick, all of them must
 * refetch together: the lane lists come from "check-intake-items", but the
 * lane badge counts come from "check-stage-totals", so refreshing only the
 * list leaves the counts stale until a full page reload.
 *
 * Pure module (no "@/" imports) so aws/tests can import it directly.
 */
export const CHECK_QUEUE_QUERY_ROOTS = [
  "check-intake-items",
  "check-intake-items-deposited",
  "check-stage-totals",
  "check-review-queue",
  "check-dashboard-counts",
  "loss-draft-counts",
  "returned-checks-count",
  "shared-with-me-checks",
] as const;

export type CheckQueueQueryRoot = (typeof CHECK_QUEUE_QUERY_ROOTS)[number];

export type QueryInvalidator = {
  invalidateQueries: (
    filters: {
      queryKey: readonly unknown[];
      refetchType?: "active" | "inactive" | "all" | "none";
    },
    options?: { cancelRefetch?: boolean },
  ) => unknown;
};

/** The queue list query; most call sites invalidate only this one. */
export const CHECK_QUEUE_LIST_ROOT = "check-intake-items";

/** Everything derived from the same rows as the list (counts, other lanes). */
export const CHECK_QUEUE_DEPENDENT_ROOTS = CHECK_QUEUE_QUERY_ROOTS.filter(
  (root) => root !== CHECK_QUEUE_LIST_ROOT,
);

// An in-flight fetch is joined, not cancelled and restarted, when several
// refreshes (poll, focus, cascade, upload) land together.
const JOIN_IN_FLIGHT = { cancelRefetch: false } as const;

export type RefreshCheckQueuesOptions = {
  /**
   * Also refetch queue queries that have no mounted observer (for example a
   * check uploaded from Cash Jobs while the Command Center is not on screen).
   * The app's QueryClient sets refetchOnMount: false, so a query that is only
   * marked stale would otherwise show the old list when the page is opened.
   */
  includeInactive?: boolean;
  /** Also refresh this check's detail row. */
  checkId?: string | null;
};

/** Invalidate every Check Command Center queue/count query. */
export function refreshCheckQueues(
  qc: QueryInvalidator,
  options: RefreshCheckQueuesOptions = {},
): Promise<unknown[]> {
  const refetchType = options.includeInactive ? "all" : "active";
  const pending: unknown[] = CHECK_QUEUE_QUERY_ROOTS.map((root) =>
    qc.invalidateQueries({ queryKey: [root], refetchType }, JOIN_IN_FLIGHT),
  );
  if (options.checkId) {
    pending.push(qc.invalidateQueries({ queryKey: ["check-detail", options.checkId] }, JOIN_IN_FLIGHT));
  }
  return Promise.all(pending);
}

/** Shape of a react-query QueryCache event, reduced to what we read. */
export type QueryCacheEventLike = {
  type?: string;
  action?: { type?: string } | null;
  query?: { queryKey?: readonly unknown[] } | null;
};

/**
 * True when the queue list query was just invalidated. Many Command Center
 * call sites (upload dialog, review decisions, deletes) invalidate only
 * "check-intake-items"; the lane badge counts come from other queries and
 * would otherwise stay stale until a page reload.
 */
export function isQueueListInvalidation(event: QueryCacheEventLike | null | undefined): boolean {
  return (
    !!event &&
    event.type === "updated" &&
    event.action?.type === "invalidate" &&
    event.query?.queryKey?.[0] === CHECK_QUEUE_LIST_ROOT
  );
}

/** Refresh the counts and other lanes after the list was invalidated. */
export function refreshQueueDependents(qc: QueryInvalidator): Promise<unknown[]> {
  return Promise.all(
    CHECK_QUEUE_DEPENDENT_ROOTS.map((root) =>
      qc.invalidateQueries({ queryKey: [root], refetchType: "active" }, JOIN_IN_FLIGHT),
    ),
  );
}

/**
 * Throttle gate for refresh-on-focus: true when at least `minIntervalMs` has
 * passed since the last refresh. Keeps tab switching from hammering the queue.
 */
export function shouldRefreshOnFocus(
  lastRefreshAt: number,
  now: number,
  minIntervalMs = 10_000,
): boolean {
  if (!Number.isFinite(lastRefreshAt) || lastRefreshAt <= 0) return true;
  return now - lastRefreshAt >= minIntervalMs;
}
