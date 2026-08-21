import type { QueryClient } from "@tanstack/react-query";

/**
 * Phase 4 — optimistic lifecycle helpers.
 *
 * All check queue caches live under a `["check-intake-items", ...]` key, so we
 * patch every matching cache entry by predicate instead of guessing the exact
 * key (tenant id / stage suffixes vary by call site).
 *
 * Each helper returns a rollback function that restores the exact snapshots
 * captured before the mutation ran. Call it on error.
 */

type Row = Record<string, any>;

function queueEntries(qc: QueryClient) {
  return qc.getQueryCache().findAll({
    predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "check-intake-items",
  });
}

function snapshot(qc: QueryClient) {
  const snaps: Array<[readonly unknown[], Row[] | undefined]> = [];
  for (const entry of queueEntries(qc)) {
    const data = qc.getQueryData<Row[]>(entry.queryKey);
    if (Array.isArray(data)) snaps.push([entry.queryKey, data]);
  }
  return () => {
    for (const [key, data] of snaps) qc.setQueryData(key, data);
  };
}

/** Move the given check ids to a target stage across every queue cache. */
export function optimisticStage(
  qc: QueryClient,
  ids: string[] | Set<string>,
  stage: string,
): () => void {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  const rollback = snapshot(qc);
  for (const entry of queueEntries(qc)) {
    qc.setQueryData<Row[]>(entry.queryKey, (curr) =>
      Array.isArray(curr)
        ? curr.map((c) =>
            idSet.has(c.id) ? { ...c, status: stage, check_stage: stage, _optimistic: true } : c,
          )
        : curr,
    );
  }
  return rollback;
}

/** Remove the given check ids from every queue cache (delete flows). */
export function optimisticRemove(qc: QueryClient, ids: string[] | Set<string>): () => void {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  const rollback = snapshot(qc);
  for (const entry of queueEntries(qc)) {
    qc.setQueryData<Row[]>(entry.queryKey, (curr) =>
      Array.isArray(curr) ? curr.filter((c) => !idSet.has(c.id)) : curr,
    );
  }
  return rollback;
}

/** Patch arbitrary fields onto checks in every queue cache. */
export function optimisticPatch(
  qc: QueryClient,
  ids: string[] | Set<string>,
  patch: Row,
): () => void {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  const rollback = snapshot(qc);
  for (const entry of queueEntries(qc)) {
    qc.setQueryData<Row[]>(entry.queryKey, (curr) =>
      Array.isArray(curr) ? curr.map((c) => (idSet.has(c.id) ? { ...c, ...patch } : c)) : curr,
    );
  }
  return rollback;
}
