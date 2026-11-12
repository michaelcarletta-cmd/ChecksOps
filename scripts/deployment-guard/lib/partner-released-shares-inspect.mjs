/**
 * Read-only production inspect of the checks a partner shared with Condition One and then
 * released (inspect only; there is no apply). Owner report 2026-11-12: Freedom paid out of
 * shared checks outside ChecksOps and recorded those payments; the question is who the
 * recorded payee of each payment is, and whether a payment recorded for Condition One reaches
 * Condition One's Funds Received (public.get_tenant_funds_received: recipient_tenant_id, the
 * payee account's tenant, or the recipient name equal to the tenant's name after
 * normalize_org_name).
 *
 * One transaction: BEGIN READ ONLY, search_path pg_catalog, statement and lock timeouts,
 * then the fixed SELECTs in Q, then ROLLBACK. Nothing else is ever sent: there is no SQL
 * argument and every statement text is a constant of this file.
 *
 * The receiving organization is the one tenant whose normalized name starts with
 * TARGET_NAME_PREFIX. With zero or several matches the inspect reports the number of matches
 * and reads nothing else.
 *
 * Output: counts and dollar totals only.
 *   - tenants          how many tenants match the receiving and the sharing name prefix
 *   - functions        presence and prosrc sha256 of get_tenant_funds_received and
 *                      normalize_org_name, and whether the former matches by recipient name,
 *                      recipient_tenant_id and payee-account tenant
 *   - shares           active shares to the receiving organization by check_stage and by
 *                      whether the sharing organization matches SOURCE_NAME_PREFIX
 *   - released_splits  the sharing organization's payouts on the released shared checks, by
 *                      status, method and recipient class (RECIPIENT_CLASSES)
 *   - released_checks  the released shared checks by what their settled payouts say
 *                      (CHECK_CLASSES)
 *   - send_legs        the sharing organization's payment_transfers send legs from those
 *                      checks, by role, status and whether they go to the receiving organization
 *   - target_own       the receiving organization's own payouts and send legs, by status
 *
 * No id, name, check number, address, memo or raw row is ever returned by a statement:
 * names and ids are used only inside predicates. Labels (check_stage, status, method, leg
 * role) are printed only when they look like a code label; anything else is 'other'.
 *
 * A failure (connecting included) reports the stage and the error's code / SQLSTATE only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { safeErrorCode } from './mortgage-desk-access-inspect.mjs';

export { safeErrorCode };

export const INSPECT_ID = 'partner-released-shares-inspect';
export const CONFIG_REL = 'ops/deployment-guard/partner-released-shares-inspect.json';
/** Normalized-name prefixes (LIKE patterns) of the receiving and the sharing organization. */
export const TARGET_NAME_PREFIX = 'condition one%';
export const SOURCE_NAME_PREFIX = 'freedom%';
/** A recipient name that mentions the receiving organization without being equal to it. */
export const TARGET_NAME_CONTAINS = '%condition one%';
/** A recipient name that abbreviates it (normalized: lower case, letters, digits, spaces). */
export const TARGET_NAME_ABBREVIATION = '(^| )(c1|c1c|c 1|cone)( |$)';
export const RELEASED_STAGES = Object.freeze(['funds_released', 'disbursed_externally']);
export const SEND_LEG_ROLES = Object.freeze(['send_wallet', 'send_bank']);
export const FUNCTIONS = Object.freeze(['get_tenant_funds_received', 'normalize_org_name']);

/** How a payout's recorded recipient relates to the receiving organization. */
export const RECIPIENT_CLASSES = Object.freeze({
  // Listed in the receiving organization's Funds Received by get_tenant_funds_received.
  recipient_tenant_id: 'listed',
  payee_account_of_target: 'listed',
  recipient_name_equal: 'listed',
  // Names the receiving organization, but not in a way Funds Received matches.
  recipient_name_contains: 'near_miss',
  payee_account_name_contains: 'near_miss',
  recipient_name_abbreviation: 'near_miss',
  // Someone else, or nobody recorded.
  other_recipient_name: 'other',
  other_payee_account: 'other',
  no_recipient: 'other',
});
export const CHECK_CLASSES = Object.freeze([
  'paid_to_target_listed', 'paid_to_target_near_miss_only', 'paid_to_others_only', 'no_settled_payout',
]);

// public.normalize_org_name (supabase/migrations/20260820194902_...sql), inlined so the inspect
// does not depend on the function being present or unchanged in production.
const norm = (expr) => `NULLIF(btrim(regexp_replace(regexp_replace(lower(COALESCE(${expr}, '')), '[^a-z0-9 ]', ' ', 'g'), '\\s+(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|group|holdings)\\s*$', '', 'g')), '')`;
const money = (expr) => `COALESCE(sum(${expr}), 0)::numeric(14,2)::text`;

// $1 TARGET_NAME_PREFIX, $2 SOURCE_NAME_PREFIX.
const SHARES = `target AS (
    SELECT t.id, ${norm('t.name')} AS norm FROM public.tenants t WHERE ${norm('t.name')} LIKE $1),
  shares AS (
    SELECT sc.check_id, sc.source_tenant_id, COALESCE(${norm('src.name')} LIKE $2, false) AS source_matches,
      COALESCE(c.check_stage::text, '') AS check_stage, c.amount
    FROM public.shared_checks sc
    JOIN target ON target.id = sc.target_tenant_id
    JOIN public.check_intake_items c ON c.id = sc.check_id
    LEFT JOIN public.tenants src ON src.id = sc.source_tenant_id
    WHERE sc.revoked_at IS NULL),
  released AS (
    SELECT s.* FROM shares s WHERE s.check_stage = ANY($3::text[]))`;

// + $4 TARGET_NAME_CONTAINS, $5 TARGET_NAME_ABBREVIATION.
const SPLITS = `${SHARES},
  splits AS (
    SELECT r.check_id, r.source_matches, ds.amount, COALESCE(ds.status::text, '') AS status,
      COALESCE(ds.method::text, '') AS method,
      CASE
        WHEN ds.recipient_tenant_id = (SELECT id FROM target) THEN 'recipient_tenant_id'
        WHEN sa.tenant_id = (SELECT id FROM target) THEN 'payee_account_of_target'
        WHEN ${norm('ds.recipient_name')} = (SELECT norm FROM target) THEN 'recipient_name_equal'
        WHEN ${norm('ds.recipient_name')} LIKE $4 THEN 'recipient_name_contains'
        WHEN ${norm('sa.nickname')} LIKE $4 OR ${norm('sa.custname')} LIKE $4 THEN 'payee_account_name_contains'
        WHEN ${norm('ds.recipient_name')} ~ $5 THEN 'recipient_name_abbreviation'
        WHEN ${norm('ds.recipient_name')} IS NOT NULL THEN 'other_recipient_name'
        WHEN ds.stakeholder_account_id IS NOT NULL THEN 'other_payee_account'
        ELSE 'no_recipient'
      END AS recipient_class
    FROM released r
    JOIN public.disbursement_batches db ON db.check_intake_item_id = r.check_id
    JOIN public.disbursement_splits ds ON ds.batch_id = db.id AND ds.tenant_id = r.source_tenant_id
    LEFT JOIN public.stakeholder_accounts sa ON sa.id = ds.stakeholder_account_id)`;

const LISTED = Object.entries(RECIPIENT_CLASSES).filter(([, v]) => v === 'listed').map(([k]) => `'${k}'`).join(', ');
const NEAR = Object.entries(RECIPIENT_CLASSES).filter(([, v]) => v === 'near_miss').map(([k]) => `'${k}'`).join(', ');

export const Q = Object.freeze({
  begin: 'BEGIN READ ONLY',
  searchPath: "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)",
  statementTimeout: "SELECT pg_catalog.set_config('statement_timeout', '20000', true)",
  lockTimeout: "SELECT pg_catalog.set_config('lock_timeout', '2000', true)",
  session: `SELECT current_user::text AS current_user, session_user::text AS session_user,
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
  pg_catalog.current_setting('server_version_num')::int AS server_version_num`,
  columns: `SELECT c.relname::text AS table_name, a.attname::text AS column_name
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[]) AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY 1, a.attnum`,
  functions: `SELECT p.proname::text AS name, pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  p.prosecdef AS security_definer, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS prosrc_sha256,
  position('normalize_org_name' in p.prosrc) > 0 AS uses_normalize_org_name,
  position('recipient_tenant_id' in p.prosrc) > 0 AS uses_recipient_tenant_id,
  position('stakeholder_accounts' in p.prosrc) > 0 AS uses_stakeholder_accounts
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) AND p.prokind = 'f' ORDER BY 1, 2`,
  tenants: `SELECT count(*) FILTER (WHERE ${norm('t.name')} LIKE $1)::int AS target_matches,
  count(*) FILTER (WHERE ${norm('t.name')} LIKE $2)::int AS source_matches
  FROM public.tenants t`,
  shares: `WITH ${SHARES}
  SELECT s.source_matches, s.check_stage, count(*)::int AS checks, ${money('s.amount')} AS check_amount
  FROM shares s GROUP BY 1, 2 ORDER BY 1, 2`,
  releasedSplits: `WITH ${SPLITS}
  SELECT x.source_matches, x.status, x.method, x.recipient_class, count(*)::int AS payouts,
  count(DISTINCT x.check_id)::int AS checks, ${money('x.amount')} AS amount
  FROM splits x GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
  releasedChecks: `WITH ${SPLITS},
  per_check AS (
    SELECT r.check_id, r.source_matches, r.amount AS check_amount,
      COALESCE(bool_or(x.recipient_class IN (${LISTED})), false) AS listed,
      COALESCE(bool_or(x.recipient_class IN (${NEAR})), false) AS near_miss,
      count(x.check_id) AS settled,
      COALESCE(sum(x.amount) FILTER (WHERE x.recipient_class IN (${LISTED})), 0) AS listed_amount,
      COALESCE(sum(x.amount) FILTER (WHERE x.recipient_class IN (${NEAR})), 0) AS near_miss_amount,
      COALESCE(sum(x.amount), 0) AS settled_amount
    FROM released r LEFT JOIN splits x ON x.check_id = r.check_id AND x.status = 'settled'
    GROUP BY 1, 2, 3)
  SELECT p.source_matches,
  CASE WHEN p.listed THEN 'paid_to_target_listed' WHEN p.near_miss THEN 'paid_to_target_near_miss_only'
       WHEN p.settled > 0 THEN 'paid_to_others_only' ELSE 'no_settled_payout' END AS check_class,
  count(*)::int AS checks, ${money('p.check_amount')} AS check_amount, ${money('p.settled_amount')} AS settled_amount,
  ${money('p.listed_amount')} AS listed_amount, ${money('p.near_miss_amount')} AS near_miss_amount
  FROM per_check p GROUP BY 1, 2 ORDER BY 1, 2`,
  sendLegs: `WITH ${SHARES}
  SELECT r.source_matches, COALESCE(pt.leg_role::text, '') AS leg_role, COALESCE(pt.status::text, '') AS status,
  COALESCE(pt.destination_tenant_id = (SELECT id FROM target), false) AS to_target,
  count(*)::int AS legs, count(DISTINCT r.check_id)::int AS checks, (COALESCE(sum(pt.amount_cents), 0) / 100.0)::numeric(14,2)::text AS amount
  FROM released r JOIN public.payment_transfers pt ON pt.check_id = r.check_id AND pt.tenant_id = r.source_tenant_id
  WHERE pt.leg_role::text = ANY($4::text[])
  GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
  targetOwnSplits: `WITH ${SHARES}
  SELECT COALESCE(ds.status::text, '') AS status, count(*)::int AS payouts, ${money('ds.amount')} AS amount
  FROM public.disbursement_splits ds WHERE ds.tenant_id = (SELECT id FROM target)
  GROUP BY 1 ORDER BY 1`,
  targetOwnSendLegs: `WITH ${SHARES}
  SELECT COALESCE(pt.leg_role::text, '') AS leg_role, COALESCE(pt.status::text, '') AS status, count(*)::int AS legs,
  (COALESCE(sum(pt.amount_cents), 0) / 100.0)::numeric(14,2)::text AS amount
  FROM public.payment_transfers pt WHERE pt.tenant_id = (SELECT id FROM target) AND pt.leg_role::text = ANY($4::text[])
  GROUP BY 1, 2 ORDER BY 1, 2`,
  rollback: 'ROLLBACK',
});

/** Every statement the inspect may send, for the tests' allowlist. */
export const INSPECT_STATEMENTS = Object.freeze(Object.values(Q));

const T = Object.freeze({
  tenants: ['id', 'name'],
  shared_checks: ['check_id', 'source_tenant_id', 'target_tenant_id', 'revoked_at'],
  check_intake_items: ['id', 'check_stage', 'amount'],
  disbursement_batches: ['id', 'check_intake_item_id'],
  disbursement_splits: ['batch_id', 'tenant_id', 'amount', 'status', 'method', 'recipient_name', 'recipient_tenant_id', 'stakeholder_account_id'],
  stakeholder_accounts: ['id', 'tenant_id', 'nickname', 'custname'],
  payment_transfers: ['tenant_id', 'check_id', 'leg_role', 'status', 'amount_cents', 'destination_tenant_id'],
});
export const INSPECT_TABLES = Object.freeze(Object.keys(T));
const BASE = ['tenants', 'shared_checks', 'check_intake_items'];
const SPLIT_TABLES = [...BASE, 'disbursement_batches', 'disbursement_splits', 'stakeholder_accounts'];
/** The tables (with the columns in T) each data statement reads. */
export const STATEMENT_REQUIRES = Object.freeze({
  tenants: ['tenants'],
  shares: BASE,
  releasedSplits: SPLIT_TABLES,
  releasedChecks: SPLIT_TABLES,
  sendLegs: [...BASE, 'payment_transfers'],
  targetOwnSplits: [...BASE, 'disbursement_splits'],
  targetOwnSendLegs: [...BASE, 'payment_transfers'],
});
const PARAMS = Object.freeze({
  tenants: [TARGET_NAME_PREFIX, SOURCE_NAME_PREFIX],
  shares: [TARGET_NAME_PREFIX, SOURCE_NAME_PREFIX, [...RELEASED_STAGES]],
  releasedSplits: [TARGET_NAME_PREFIX, SOURCE_NAME_PREFIX, [...RELEASED_STAGES], TARGET_NAME_CONTAINS, TARGET_NAME_ABBREVIATION],
  releasedChecks: [TARGET_NAME_PREFIX, SOURCE_NAME_PREFIX, [...RELEASED_STAGES], TARGET_NAME_CONTAINS, TARGET_NAME_ABBREVIATION],
  sendLegs: [TARGET_NAME_PREFIX, SOURCE_NAME_PREFIX, [...RELEASED_STAGES], [...SEND_LEG_ROLES]],
  targetOwnSplits: [TARGET_NAME_PREFIX, SOURCE_NAME_PREFIX, [...RELEASED_STAGES]],
  targetOwnSendLegs: [TARGET_NAME_PREFIX, SOURCE_NAME_PREFIX, [...RELEASED_STAGES], [...SEND_LEG_ROLES]],
});

const LABEL_RE = /^[a-z][a-z0-9_]{0,40}$/;
const label = (v) => (v === '' || v == null ? '(none)' : LABEL_RE.test(String(v)) ? String(v) : 'other');
const MONEY_RE = /^-?\d{1,12}\.\d{2}$/;
const amount = (v) => (MONEY_RE.test(String(v)) ? String(v) : null);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const section = (r, key, map) => (r[key] === undefined
  ? { read: false, reason: r.skipped?.[key] || 'not_read' }
  : { read: true, rows: r[key].map(map) });

/** Pure: builds the report from the rows the statements returned. Counts, totals, labels only. */
export function buildReport(r) {
  const session = r.session?.[0] || {};
  const tenants = r.tenants?.[0] || {};
  const targetMatches = int(tenants.target_matches);
  const functions = Object.fromEntries(FUNCTIONS.map((name) => {
    const rows = (r.functions || []).filter((f) => f.name === name);
    return [name, rows.length
      ? {
        present: true,
        overloads: rows.length,
        detail: rows.map((f) => ({
          security_definer: f.security_definer === true,
          prosrc_sha256: /^[0-9a-f]{64}$/.test(String(f.prosrc_sha256)) ? f.prosrc_sha256 : null,
          ...(name === 'get_tenant_funds_received' ? {
            matches_by_recipient_name: f.uses_normalize_org_name === true,
            matches_by_recipient_tenant_id: f.uses_recipient_tenant_id === true,
            matches_by_payee_account_tenant: f.uses_stakeholder_accounts === true,
          } : {}),
        })),
      }
      : { present: false }];
  }));
  const src = (x) => ({ source_matches_prefix: x.source_matches === true });
  return {
    inspect: INSPECT_ID,
    read_only: true,
    transaction_read_only: session.transaction_read_only === 'on',
    current_user: session.current_user,
    session_user: session.session_user,
    server_major_version: Math.floor(Number(session.server_version_num || 0) / 10000),
    question: 'who is the recorded payee of the payouts on the checks shared with the receiving organization and released, and do they reach its Funds Received?',
    tenants: {
      target_name_prefix: TARGET_NAME_PREFIX,
      source_name_prefix: SOURCE_NAME_PREFIX,
      target_matches: targetMatches,
      source_matches: int(tenants.source_matches),
      target_resolved: targetMatches === 1,
    },
    functions,
    recipient_classes: RECIPIENT_CLASSES,
    shares: section(r, 'shares', (x) => ({ ...src(x), check_stage: label(x.check_stage), checks: int(x.checks), check_amount: amount(x.check_amount) })),
    released_splits: section(r, 'releasedSplits', (x) => ({
      ...src(x), status: label(x.status), method: label(x.method),
      recipient_class: Object.hasOwn(RECIPIENT_CLASSES, x.recipient_class) ? x.recipient_class : 'other',
      funds_received: RECIPIENT_CLASSES[x.recipient_class] || 'other',
      payouts: int(x.payouts), checks: int(x.checks), amount: amount(x.amount),
    })),
    released_checks: section(r, 'releasedChecks', (x) => ({
      ...src(x), check_class: CHECK_CLASSES.includes(x.check_class) ? x.check_class : 'other', checks: int(x.checks),
      check_amount: amount(x.check_amount), settled_amount: amount(x.settled_amount),
      listed_amount: amount(x.listed_amount), near_miss_amount: amount(x.near_miss_amount),
    })),
    send_legs: section(r, 'sendLegs', (x) => ({
      ...src(x), leg_role: label(x.leg_role), status: label(x.status), to_target: x.to_target === true,
      legs: int(x.legs), checks: int(x.checks), amount: amount(x.amount),
    })),
    target_own: {
      payouts: section(r, 'targetOwnSplits', (x) => ({ status: label(x.status), payouts: int(x.payouts), amount: amount(x.amount) })),
      send_legs: section(r, 'targetOwnSendLegs', (x) => ({ leg_role: label(x.leg_role), status: label(x.status), legs: int(x.legs), amount: amount(x.amount) })),
    },
  };
}

export function loadInspectConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'));
}

/**
 * Runs the inspect on a connected client: BEGIN READ ONLY ... ROLLBACK of the fixed statements
 * in Q only. A data statement runs only when every table and column it reads exists, and
 * (other than the tenant count) only when exactly one tenant matches the receiving prefix.
 * Returns the structured result; never throws.
 */
export async function inspectPartnerReleasedShares({ connect }) {
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
    const r = { skipped: {} };
    r.session = await rows(Q.session);
    if (r.session?.[0]?.transaction_read_only !== 'on') {
      return fail(CODES.UNRELATED_MUTATION, 'partner released shares inspect refused: the transaction is not read-only');
    }
    r.columns = await rows(Q.columns, [[...INSPECT_TABLES]]);
    r.functions = await rows(Q.functions, [[...FUNCTIONS]]);
    const have = new Set(r.columns.map((c) => `${c.table_name}.${c.column_name}`));
    const missing = (key) => STATEMENT_REQUIRES[key].flatMap((t) => T[t].filter((c) => !have.has(`${t}.${c}`)).map((c) => `${t}.${c}`));
    for (const key of Object.keys(STATEMENT_REQUIRES)) {
      const gone = missing(key);
      if (gone.length) { r.skipped[key] = `columns_missing:${gone.join(',')}`; continue; }
      if (key !== 'tenants' && r.tenants?.[0]?.target_matches !== 1) { r.skipped[key] = 'target_not_resolved'; continue; }
      r[key] = await rows(Q[key], PARAMS[key]);
    }
    return ok(buildReport(r));
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, 'partner released shares inspect failed', {
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
