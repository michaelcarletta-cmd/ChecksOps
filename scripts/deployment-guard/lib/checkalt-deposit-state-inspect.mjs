/**
 * Read-only production inspect of CheckAlt deposit state (inspect only; there is no apply).
 * Owner question 2026-11-24: which public.checkalt_deposits rows are stranded, so that every
 * later Deposit press on their check answers reconciliation_required?
 *
 * The submit path (aws/functions/api/providers/production/checkalt-submit.mjs) inserts the row
 * 'queued' (insertQueuedDeposit), then claims it with markHttpAttempted
 * (checkalt-idempotency.mjs: status 'submitting', provider_http_attempted_at now(),
 * last_status_payload.phase 'submitting') and commits, and only then signs in to CheckAlt
 * (getCheckAltJwt) and posts /fincapture/deposit/process. When the sign-in fails before the
 * POST (a CheckAlt sign-in 504 at 2026-11-24 19:58 UTC), the row keeps
 * provider_http_attempted_at set and checkalt_reference NULL. From then on
 * shouldReconcileInsteadOfPost is true for it (status queued, pending, submitting or error with
 * an HTTP attempt), so no new POST is sent for that check.
 *
 * A row is stranded here exactly when provider_http_attempted_at IS NOT NULL AND
 * checkalt_reference IS NULL AND status IN ('queued', 'pending', 'submitting', 'error')
 * (STRANDED_STATUSES). Columns are those of loadDepositsForCheck (checkalt-idempotency.mjs),
 * confirmed against supabase/migrations/20260503020002_*.sql (the table) and
 * aws/financial/sql/65_checkalt_production_writer.sql (idempotency_key, amount_cents,
 * provider_http_attempted_at, failure_class, last_error).
 *
 * One transaction: BEGIN READ ONLY, search_path pg_catalog, statement and lock timeouts,
 * TimeZone UTC (for the minute timestamps and dates), then the fixed SELECTs in Q, then
 * ROLLBACK. Nothing else is ever sent: there is no SQL argument and every statement text is a
 * constant of this file.
 *
 * Output: counts, booleans, code labels, small integers, and timestamps truncated to the minute
 * (UTC). No id, tenant, user, amount, idempotency key, CheckAlt reference, error text or payload
 * value is ever returned by a statement: they are used only inside predicates and counts.
 * Labels (status, failure_class, last_status_payload->>'phase', the check's status and
 * check_stage) are printed only when they look like a code label; anything else is 'other'.
 *
 * A failure (connecting included) reports the stage and the error's code / SQLSTATE only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { safeErrorCode } from './mortgage-desk-access-inspect.mjs';

export { safeErrorCode };

export const INSPECT_ID = 'checkalt-deposit-state-inspect';
export const CONFIG_REL = 'ops/deployment-guard/checkalt-deposit-state-inspect.json';

/** The statuses in which an attempted row without a reference makes shouldReconcileInsteadOfPost true. */
export const STRANDED_STATUSES = Object.freeze(['queued', 'pending', 'submitting', 'error']);
/** checkalt-idempotency.mjs TERMINAL_REPLAY: statuses that replay or reconcile on their own. */
export const TERMINAL_STATUSES = Object.freeze(['submitted', 'pending_approval', 'cleared', 'rejected', 'returned', 'duplicate']);
/** How far back the recent section reaches, from the transaction's now(). */
export const RECENT_INTERVAL = '2 days';

const list = (values) => values.map((v) => `'${v}'`).join(', ');
const STRANDED = (d) => `(${d}.provider_http_attempted_at IS NOT NULL AND ${d}.checkalt_reference IS NULL AND ${d}.status::text IN (${list(STRANDED_STATUSES)}))`;
const MINUTE = (expr) => `COALESCE(pg_catalog.to_char(pg_catalog.date_trunc('minute', ${expr}), 'YYYY-MM-DD"T"HH24:MI"Z"'), '')`;

export const Q = Object.freeze({
  begin: 'BEGIN READ ONLY',
  searchPath: "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)",
  statementTimeout: "SELECT pg_catalog.set_config('statement_timeout', '20000', true)",
  lockTimeout: "SELECT pg_catalog.set_config('lock_timeout', '2000', true)",
  timeZone: "SELECT pg_catalog.set_config('TimeZone', 'UTC', true)",
  session: `SELECT current_user::text AS current_user, session_user::text AS session_user,
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
  pg_catalog.current_setting('server_version_num')::int AS server_version_num`,
  columns: `SELECT c.relname::text AS table_name, a.attname::text AS column_name
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[]) AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY 1, a.attnum`,
  // Whether row-level security filters what this login reads (true would make the answer partial).
  rowSecurity: `SELECT c.relname::text AS table_name, pg_catalog.row_security_active(c.oid) AS row_security_active
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])
  ORDER BY 1`,
  summary: `SELECT COALESCE(d.status::text, '') AS status, (d.checkalt_reference IS NULL) AS reference_null,
  (d.provider_http_attempted_at IS NOT NULL) AS http_attempted, count(*)::int AS deposits
  FROM public.checkalt_deposits d GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  stranded: `WITH stranded AS (
    SELECT d.* FROM public.checkalt_deposits d WHERE ${STRANDED('d')})
  SELECT ${MINUTE('s.created_at')} AS created_minute,
  ${MINUTE('s.provider_http_attempted_at')} AS attempted_minute,
  ${MINUTE('s.updated_at')} AS updated_minute,
  COALESCE(s.status::text, '') AS status,
  COALESCE(s.failure_class::text, '') AS failure_class,
  COALESCE(s.last_status_payload ->> 'phase', '') AS phase,
  (s.last_error IS NULL) AS last_error_null,
  (s.check_intake_item_id IS NOT NULL) AS check_linked,
  (c.id IS NOT NULL) AS check_found,
  CASE WHEN c.id IS NULL THEN NULL ELSE (c.deposited_at IS NOT NULL) END AS check_deposited,
  COALESCE(c.status::text, '') AS check_status,
  COALESCE(c.check_stage::text, '') AS check_stage,
  CASE WHEN s.check_intake_item_id IS NULL THEN NULL ELSE (SELECT count(*)::int FROM public.checkalt_deposits o
    WHERE o.check_intake_item_id = s.check_intake_item_id) END AS check_deposit_rows,
  CASE WHEN s.check_intake_item_id IS NULL THEN NULL ELSE (SELECT count(*)::int FROM public.checkalt_deposits o
    WHERE o.check_intake_item_id = s.check_intake_item_id AND o.checkalt_reference IS NOT NULL) END AS check_rows_with_reference,
  CASE WHEN s.check_intake_item_id IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM public.checkalt_deposits o
    WHERE o.check_intake_item_id = s.check_intake_item_id AND o.id <> s.id AND o.checkalt_reference IS NOT NULL) END AS other_row_has_reference,
  CASE WHEN s.check_intake_item_id IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM public.checkalt_deposits o
    WHERE o.check_intake_item_id = s.check_intake_item_id AND o.id <> s.id AND o.status::text IN (${list(TERMINAL_STATUSES)})) END AS other_row_terminal
  FROM stranded s LEFT JOIN public.check_intake_items c ON c.id = s.check_intake_item_id
  ORDER BY s.created_at NULLS LAST, s.id`,
  strandedByDate: `SELECT COALESCE(pg_catalog.to_char(d.created_at, 'YYYY-MM-DD'), '') AS created_date, count(*)::int AS deposits
  FROM public.checkalt_deposits d WHERE ${STRANDED('d')}
  GROUP BY 1 ORDER BY 1`,
  // check_seq numbers the checks within this section by their first recent row; it is not an id.
  recent: `WITH recent AS (
    SELECT d.* FROM public.checkalt_deposits d WHERE d.created_at >= pg_catalog.now() - interval '${RECENT_INTERVAL}'),
  firsts AS (
    SELECT r.check_intake_item_id, min(r.created_at) AS first_at FROM recent r WHERE r.check_intake_item_id IS NOT NULL GROUP BY 1),
  seq AS (
    SELECT f.check_intake_item_id, pg_catalog.dense_rank() OVER (ORDER BY f.first_at, f.check_intake_item_id) AS n FROM firsts f)
  SELECT ${MINUTE('r.created_at')} AS created_minute,
  ${MINUTE('r.provider_http_attempted_at')} AS attempted_minute,
  ${MINUTE('r.updated_at')} AS updated_minute,
  COALESCE(r.status::text, '') AS status,
  (r.checkalt_reference IS NULL) AS reference_null,
  (r.provider_http_attempted_at IS NOT NULL) AS http_attempted,
  COALESCE(r.failure_class::text, '') AS failure_class,
  ${STRANDED('r')} AS stranded,
  q.n::int AS check_seq
  FROM recent r LEFT JOIN seq q ON q.check_intake_item_id = r.check_intake_item_id
  ORDER BY r.created_at, r.id`,
  rollback: 'ROLLBACK',
});

/** Every statement the inspect may send, for the tests' allowlist. */
export const INSPECT_STATEMENTS = Object.freeze(Object.values(Q));

const T = Object.freeze({
  checkalt_deposits: ['id', 'check_intake_item_id', 'checkalt_reference', 'status', 'provider_http_attempted_at', 'failure_class',
    'last_status_payload', 'last_error', 'created_at', 'updated_at'],
  check_intake_items: ['id', 'deposited_at', 'status', 'check_stage'],
});
export const INSPECT_TABLES = Object.freeze(Object.keys(T));
const STRANDED_REQUIRES = ['checkalt_reference', 'status', 'provider_http_attempted_at'];
/** The columns each data statement reads. */
export const STATEMENT_REQUIRES = Object.freeze({
  summary: { checkalt_deposits: STRANDED_REQUIRES },
  stranded: T,
  strandedByDate: { checkalt_deposits: [...STRANDED_REQUIRES, 'created_at'] },
  recent: { checkalt_deposits: ['id', 'check_intake_item_id', ...STRANDED_REQUIRES, 'failure_class', 'created_at', 'updated_at'] },
});

// The same code-label sanitizer as lib/check-ownership-inspect.mjs.
const LABEL_RE = /^[a-z][a-z0-9_]{0,40}$/;
const label = (v) => (v === '' || v == null ? '(none)' : LABEL_RE.test(String(v)) ? String(v) : 'other');
const MINUTE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\dZ$/;
const minute = (v) => (v === '' || v == null ? '(none)' : MINUTE_RE.test(String(v)) ? String(v) : 'other');
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const date = (v) => (v === '' || v == null ? '(none)' : DATE_RE.test(String(v)) ? String(v) : 'other');
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const bool = (v) => (v === true ? true : v === false ? false : null);
const section = (r, key, map) => (r[key] === undefined
  ? { read: false, reason: r.skipped?.[key] || 'not_read' }
  : { read: true, rows: r[key].map(map) });

/** Pure: the stranded rule on one summary cell. */
export const isStrandedCell = (status, referenceNull, httpAttempted) => (
  referenceNull === true && httpAttempted === true && STRANDED_STATUSES.includes(status));

/** Pure: totals and the status x reference x attempted matrix from the summary rows. */
export function summarize(rows) {
  const cell = () => ({ reference_null: { attempted: 0, not_attempted: 0 }, reference_set: { attempted: 0, not_attempted: 0 }, total: 0 });
  const byStatus = {};
  const total = { deposits: 0, reference_null: 0, reference_set: 0, http_attempted: 0, not_attempted: 0, stranded: 0 };
  for (const row of rows) {
    const n = int(row.deposits) || 0;
    const status = label(row.status);
    const refNull = row.reference_null === true;
    const attempted = row.http_attempted === true;
    const c = (byStatus[status] ||= cell());
    c[refNull ? 'reference_null' : 'reference_set'][attempted ? 'attempted' : 'not_attempted'] += n;
    c.total += n;
    total.deposits += n;
    total[refNull ? 'reference_null' : 'reference_set'] += n;
    total[attempted ? 'http_attempted' : 'not_attempted'] += n;
    if (isStrandedCell(status, refNull, attempted)) total.stranded += n;
  }
  return { total, by_status: byStatus };
}

/** Pure: builds the report from the rows the statements returned. Counts, labels and minutes only. */
export function buildReport(r) {
  const session = r.session?.[0] || {};
  return {
    inspect: INSPECT_ID,
    read_only: true,
    transaction_read_only: session.transaction_read_only === 'on',
    current_user: session.current_user,
    session_user: session.session_user,
    server_major_version: Math.floor(Number(session.server_version_num || 0) / 10000),
    question: 'which checkalt_deposits rows are stranded (provider_http_attempted_at set, checkalt_reference NULL, status queued, pending, submitting or error), so every later Deposit press on their check answers reconciliation_required?',
    stranded_rule: `provider_http_attempted_at IS NOT NULL AND checkalt_reference IS NULL AND status IN (${STRANDED_STATUSES.join(', ')})`,
    terminal_statuses: TERMINAL_STATUSES,
    timestamps: 'UTC, truncated to the minute',
    recent_window: RECENT_INTERVAL,
    row_security: r.rowSecurity === undefined
      ? { read: false, reason: 'not_read' }
      : Object.fromEntries(r.rowSecurity.map((x) => [label(x.table_name), x.row_security_active === true])),
    summary: r.summary === undefined
      ? { read: false, reason: r.skipped?.summary || 'not_read' }
      : {
        read: true,
        ...summarize(r.summary),
        rows: r.summary.map((x) => ({
          status: label(x.status), reference_null: x.reference_null === true, http_attempted: x.http_attempted === true, deposits: int(x.deposits),
        })),
      },
    stranded: section(r, 'stranded', (x) => ({
      created_minute: minute(x.created_minute),
      attempted_minute: minute(x.attempted_minute),
      updated_minute: minute(x.updated_minute),
      status: label(x.status),
      failure_class: label(x.failure_class),
      phase: label(x.phase),
      last_error_null: x.last_error_null === true,
      check_linked: x.check_linked === true,
      check_found: x.check_found === true,
      check_deposited: bool(x.check_deposited),
      check_status: label(x.check_status),
      check_stage: label(x.check_stage),
      check_deposit_rows: int(x.check_deposit_rows),
      check_rows_with_reference: int(x.check_rows_with_reference),
      other_row_has_reference: bool(x.other_row_has_reference),
      other_row_terminal: bool(x.other_row_terminal),
    })),
    stranded_by_date: section(r, 'strandedByDate', (x) => ({ created_date: date(x.created_date), deposits: int(x.deposits) })),
    recent: section(r, 'recent', (x) => ({
      created_minute: minute(x.created_minute),
      attempted_minute: minute(x.attempted_minute),
      updated_minute: minute(x.updated_minute),
      status: label(x.status),
      reference_null: x.reference_null === true,
      http_attempted: x.http_attempted === true,
      failure_class: label(x.failure_class),
      stranded: x.stranded === true,
      check_seq: int(x.check_seq),
    })),
  };
}

export function loadInspectConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'));
}

/**
 * Runs the inspect on a connected client: BEGIN READ ONLY ... ROLLBACK of the fixed statements
 * in Q only. A data statement runs only when every table and column it reads exists. Returns
 * the structured result; never throws.
 */
export async function inspectCheckAltDepositState({ connect }) {
  const names = new Map(Object.entries(Q).map(([k, v]) => [v, k]));
  let client = null;
  let stage = null;
  const rows = async (sql, params) => { stage = names.get(sql); return (await client.query(sql, params)).rows; };
  try {
    stage = 'connect';
    client = await connect();
    await rows(Q.begin);
    await rows(Q.searchPath);
    await rows(Q.statementTimeout);
    await rows(Q.lockTimeout);
    await rows(Q.timeZone);
    const r = { skipped: {} };
    r.session = await rows(Q.session);
    if (r.session?.[0]?.transaction_read_only !== 'on') {
      return fail(CODES.UNRELATED_MUTATION, 'checkalt deposit state inspect refused: the transaction is not read-only');
    }
    r.columns = await rows(Q.columns, [[...INSPECT_TABLES]]);
    r.rowSecurity = await rows(Q.rowSecurity, [[...INSPECT_TABLES]]);
    const have = new Set(r.columns.map((c) => `${c.table_name}.${c.column_name}`));
    const missing = (key) => Object.entries(STATEMENT_REQUIRES[key]).flatMap(([t, cols]) => cols.filter((c) => !have.has(`${t}.${c}`)).map((c) => `${t}.${c}`));
    for (const key of Object.keys(STATEMENT_REQUIRES)) {
      const gone = missing(key);
      if (gone.length) { r.skipped[key] = `columns_missing:${gone.join(',')}`; continue; }
      r[key] = await rows(Q[key]);
    }
    return ok(buildReport(r));
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, 'checkalt deposit state inspect failed', {
      read_only: true,
      stage,
      error_code: safeErrorCode(error),
    });
  } finally {
    if (client) {
      try { await client.query(Q.rollback); } catch { /* closed below */ }
      try { await client.end(); } catch { /* nothing to report */ }
    }
  }
}
