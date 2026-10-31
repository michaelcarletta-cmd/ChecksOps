/**
 * Test fakes for the money step-up window (moov-fund-authz.mjs financialStepUpFreshSql,
 * security audit 2026-10-29 finding 7): a fake step-up lookup keeps a row only while
 * created_at > now() - make_interval(secs => $n::int), the clause the real query carries,
 * with Date.now() standing in for the database clock. A row without created_at counts
 * as just verified, so fakes that never set one keep their earlier behaviour.
 */
const FRESH_CLAUSE = /created_at > now\(\) - make_interval\(secs => \$(\d+)::int\)/;

export const minutesAgo = (minutes, nowMs = Date.now()) => new Date(nowMs - minutes * 60_000).toISOString();

/** True when the query binds a step-up age limit and the row is within it (or the query binds none). */
export function stepUpWithinWindow(sql, params, row, nowMs = Date.now()) {
  const match = FRESH_CLAUSE.exec(String(sql));
  if (!match) return true;
  const seconds = Number(params[Number(match[1]) - 1]);
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error(`step-up window parameter is not a positive integer: ${seconds}`);
  if (row?.created_at === undefined || row?.created_at === null) return true;
  return new Date(row.created_at).getTime() > nowMs - seconds * 1000;
}
