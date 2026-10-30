/**
 * Read-only production inspect of the financial TOTP database surface (inspect only; there is
 * no apply). It answers one question first: does the live
 * public.consume_financial_totp_rate_limit accept the action 'code_check'? The API sends it
 * since the finding 7 deploy (aws/functions/api/auth-financial-totp.mjs RATE_LIMITS.code_check,
 * providers/production/checkalt-register.mjs), while the only repository definition,
 * aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql, allows only
 * enroll_start, enroll_confirm and step_up and raises invalid_rate_limit_action otherwise.
 *
 * One transaction: BEGIN READ ONLY, search_path pg_catalog, statement and lock timeouts,
 * then the fixed SELECTs in Q, then ROLLBACK. Nothing else is ever sent: there is no SQL
 * argument and every statement text is a constant of this file.
 *
 * Output:
 *   - functions   every public function whose name contains financial_totp (overloads
 *                 included): signature, owner, SECURITY DEFINER, language, EXECUTE ACL,
 *                 sha256 of pg_get_functiondef and prosrc, the definition text (withheld
 *                 only if it has UUID-, email- or long-number-shaped content), repo_match
 *                 against aws/ and supabase/ SQL, and whether the body equals the proposed
 *                 file's.
 *   - rate_limit  for consume_financial_totp_rate_limit: the action allow-list parsed from
 *                 its body (p_action [NOT] IN (...) / = ANY (ARRAY[...])) and
 *                 accepts_code_check (true / false, or null with a reason when no allow-list
 *                 is recognized).
 *   - tables      existence, owner, RLS enabled / forced and column names (no values) of
 *                 financial_totp_enrollments, financial_totp_rate_limits and
 *                 financial_stepup_log.
 *   - activity    aggregate counts only, since ACTIVITY_SINCE: rate-limit rows by action and
 *                 day (window_started_at), step-up log rows by action_key, succeeded and day,
 *                 and enrollment totals (enrolled, verified, failed_attempts > 0,
 *                 locked_until set, last_used_timestep set). Action labels are printed only
 *                 when they look like a code label (^[a-z][a-z0-9_]{0,40}$); anything else
 *                 is counted as 'other'. No user id, tenant id, secret, ciphertext, nonce,
 *                 key id, metadata or raw row is ever selected.
 *
 * A failure (connecting included) reports the stage and the error's code / SQLSTATE only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import {
  buildRepoIndex,
  collapse,
  compareWithRepo,
  identifierShapedContent,
  repoFunctionBodies,
  safeErrorCode,
  sha256,
} from './mortgage-desk-access-inspect.mjs';

export { safeErrorCode };

export const INSPECT_ID = 'financial-totp-live-inspect';
export const CONFIG_REL = 'ops/deployment-guard/financial-totp-live-inspect.json';
export const PROPOSED_REL = 'aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql';
export const RATE_LIMIT_FUNCTION = 'public.consume_financial_totp_rate_limit';
export const CODE_CHECK_ACTION = 'code_check';
/** The rate-limit actions the deployed API sends (auth-financial-totp.mjs RATE_LIMITS). */
export const API_ACTIONS = Object.freeze(['enroll_start', 'code_check']);
export const TOTP_TABLES = Object.freeze(['financial_totp_enrollments', 'financial_totp_rate_limits', 'financial_stepup_log']);
/** Activity counted from (UTC): the day before the finding 7 deploy. */
export const ACTIVITY_SINCE = '2026-10-29T00:00:00Z';
/** Columns that hold secret or identifying material: never selected by any statement. */
export const NEVER_SELECTED_COLUMNS = Object.freeze(['ciphertext', 'nonce', 'key_id', 'user_id', 'application_user_id', 'tenant_id', 'metadata']);

const LABEL_RE = /^[a-z][a-z0-9_]{0,40}$/;
const VOLATILITY = Object.freeze({ i: 'IMMUTABLE', s: 'STABLE', v: 'VOLATILE' });

export const Q = Object.freeze({
  begin: 'BEGIN READ ONLY',
  searchPath: "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)",
  statementTimeout: "SELECT pg_catalog.set_config('statement_timeout', '20000', true)",
  lockTimeout: "SELECT pg_catalog.set_config('lock_timeout', '2000', true)",
  session: `SELECT current_user::text AS current_user, session_user::text AS session_user,
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
  pg_catalog.current_setting('server_version_num')::int AS server_version_num`,
  functions: `SELECT n.nspname::text AS schema, p.proname::text AS name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  pg_catalog.pg_get_function_result(p.oid) AS result,
  pg_catalog.pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS security_definer,
  l.lanname::text AS language, p.provolatile::text AS volatility,
  ARRAY(SELECT pg_catalog.split_part(c, '=', 1) FROM pg_catalog.unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS c ORDER BY 1) AS config_names,
  p.prosrc AS prosrc, pg_catalog.pg_get_functiondef(p.oid) AS functiondef
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.proname LIKE '%financial\\_totp%' AND p.prokind = 'f'
  ORDER BY 2, 3`,
  functionAcl: `SELECT p.proname::text AS name, pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee,
  pg_catalog.pg_get_userbyid(a.grantor)::text AS grantor, a.privilege_type::text AS privilege, a.is_grantable
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
  LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
  WHERE n.nspname = 'public' AND p.proname LIKE '%financial\\_totp%' AND p.prokind = 'f'
  ORDER BY 1, 2, 3`,
  tables: `SELECT c.relname::text AS relname, pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
  c.relrowsecurity, c.relforcerowsecurity
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[]) ORDER BY 1`,
  columns: `SELECT c.relname::text AS table_name, a.attname::text AS column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS type
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY 1, a.attnum`,
  rateLimitActivity: `SELECT r.action::text AS action, pg_catalog.to_char(r.window_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
  count(*)::int AS rows, COALESCE(sum(r.request_count), 0)::int AS requests
  FROM public.financial_totp_rate_limits r WHERE r.window_started_at >= $1::timestamptz
  GROUP BY 1, 2 ORDER BY 1, 2`,
  stepUpActivity: `SELECT s.action_key::text AS action, s.succeeded AS succeeded,
  pg_catalog.to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS rows
  FROM public.financial_stepup_log s WHERE s.created_at >= $1::timestamptz
  GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  enrollmentTotals: `SELECT count(*)::int AS enrolled, count(e.verified_at)::int AS verified,
  count(*) FILTER (WHERE e.failed_attempts > 0)::int AS with_failed_attempts,
  count(e.locked_until)::int AS locked_until_set,
  count(e.last_used_timestep)::int AS last_used_timestep_set
  FROM public.financial_totp_enrollments e`,
  rollback: 'ROLLBACK',
});

/** Every statement the inspect may send, for the tests' allowlist. */
export const INSPECT_STATEMENTS = Object.freeze(Object.values(Q));

/** Columns each activity statement needs; it runs only if the table has all of them. */
export const ACTIVITY_REQUIRES = Object.freeze({
  rateLimitActivity: ['financial_totp_rate_limits', ['action', 'window_started_at', 'request_count']],
  stepUpActivity: ['financial_stepup_log', ['action_key', 'succeeded', 'created_at']],
  enrollmentTotals: ['financial_totp_enrollments', ['verified_at', 'failed_attempts', 'locked_until', 'last_used_timestep']],
});

const label = (value) => (LABEL_RE.test(String(value ?? '')) ? String(value) : 'other');
const stripComments = (text) => String(text ?? '').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
const quoted = (list) => [...String(list).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));

/**
 * The action allow-list of a rate-limit function body: the literals of
 * `p_action [NOT] IN ('a', ...)`, `p_action = ANY (ARRAY['a', ...])` or
 * `p_action <> ALL (ARRAY['a', ...])`. Returns { recognized, actions, form } (actions sorted,
 * deduplicated) or { recognized: false } when the body has no such check.
 */
export function parseActionAllowList(prosrc) {
  const body = stripComments(prosrc);
  const forms = [
    { form: 'in', re: /\bp_action\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi },
    { form: 'any_array', re: /\bp_action\s*(?:=\s*ANY|<>\s*ALL|!=\s*ALL)\s*\(\s*ARRAY\s*\[([^\]]*)\]/gi },
  ];
  const actions = new Set();
  const found = [];
  for (const { form, re } of forms) {
    for (const m of body.matchAll(re)) {
      found.push(form);
      for (const a of quoted(m[1])) actions.add(a);
    }
  }
  if (!found.length) return { recognized: false, actions: null, form: null };
  return { recognized: true, actions: [...actions].sort(), form: [...new Set(found)].join('+') };
}

/** Whether the live rate-limit function accepts an action, from its parsed allow-list. */
export function acceptsAction(parsed, action) {
  if (!parsed?.recognized) return { accepts: null, reason: 'no_recognized_action_allow_list' };
  return { accepts: parsed.actions.includes(action), reason: null };
}

/** The proposed file's function bodies, by schema.name. */
export function proposedBodies(root) {
  const file = path.join(root, PROPOSED_REL);
  if (!fs.existsSync(file)) return new Map();
  const out = new Map();
  for (const { key, body } of repoFunctionBodies(fs.readFileSync(file, 'utf8'))) out.set(key, body);
  return out;
}

/** SQLSTATE literals (ERRCODE = '22023') are five-character codes, not identifying numbers. */
const withoutErrcodes = (def) => String(def ?? '').replace(/\bERRCODE\s*=\s*'[0-9A-Z]{5}'/gi, "ERRCODE = ''");

function definitionReport(def) {
  const shaped = identifierShapedContent(withoutErrcodes(def));
  return shaped ? { definition: null, definition_withheld: shaped } : { definition: def };
}

export function buildFinancialTotpReport(r, repo, proposed) {
  const session = r.session?.[0] || {};
  const acl = new Map();
  for (const row of r.functionAcl || []) {
    const k = `${row.name}(${row.identity_arguments})`;
    if (!acl.has(k)) acl.set(k, []);
    acl.get(k).push({ grantee: row.grantee, privilege: row.privilege, grantable: row.is_grantable, grantor: row.grantor });
  }
  const functions = (r.functions || []).map((row) => {
    const key = `${row.schema}.${row.name}`;
    const cmp = compareWithRepo(repo, key, row.prosrc);
    const proposedBody = proposed.get(key);
    const execute = acl.get(`${row.name}(${row.identity_arguments})`) || [];
    return {
      name: key,
      signature: `${key}(${row.identity_arguments})`,
      result: row.result,
      owner: row.owner,
      security_definer: row.security_definer,
      language: row.language,
      volatility: VOLATILITY[row.volatility] || row.volatility,
      config_names: row.config_names || [],
      execute_acl: execute,
      public_execute: execute.some((e) => e.grantee === 'PUBLIC' && e.privilege === 'EXECUTE'),
      functiondef_sha256: sha256(row.functiondef),
      prosrc_sha256: sha256(row.prosrc),
      repo_match: cmp.repo_match,
      matched_sources: cmp.matched_sources,
      matches_proposed_file: proposedBody == null
        ? 'not_in_proposed_file'
        : (proposedBody === row.prosrc ? 'exact' : (collapse(proposedBody) === collapse(row.prosrc) ? 'whitespace_only' : 'differs')),
      ...definitionReport(row.functiondef),
    };
  });

  const rlRows = (r.functions || []).filter((f) => `${f.schema}.${f.name}` === RATE_LIMIT_FUNCTION);
  const rateLimit = rlRows.length === 0
    ? { present: false, overloads: 0, accepts_code_check: null, reason: 'function_missing' }
    : (() => {
      const overloads = rlRows.map((row) => {
        const parsed = parseActionAllowList(row.prosrc);
        const verdict = acceptsAction(parsed, CODE_CHECK_ACTION);
        return {
          signature: `${RATE_LIMIT_FUNCTION}(${row.identity_arguments})`,
          action_allow_list: parsed.actions,
          allow_list_form: parsed.form,
          accepts_code_check: verdict.accepts,
          reason: verdict.reason,
          raises_invalid_rate_limit_action: /invalid_rate_limit_action/.test(String(row.prosrc)),
          accepts_api_actions: Object.fromEntries(API_ACTIONS.map((a) => [a, acceptsAction(parsed, a).accepts])),
        };
      });
      const verdicts = [...new Set(overloads.map((o) => o.accepts_code_check))];
      return {
        present: true,
        overloads: overloads.length,
        accepts_code_check: verdicts.length === 1 ? verdicts[0] : null,
        reason: verdicts.length === 1 ? overloads[0].reason : 'overloads_disagree',
        detail: overloads,
      };
    })();

  const tables = {};
  for (const name of TOTP_TABLES) {
    const t = (r.tables || []).find((row) => row.relname === name);
    tables[name] = t
      ? {
        exists: true,
        owner: t.owner,
        rls_enabled: t.relrowsecurity,
        rls_forced: t.relforcerowsecurity,
        columns: (r.columns || []).filter((c) => c.table_name === name).map((c) => ({ name: c.column_name, type: c.type })),
      }
      : { exists: false };
  }

  const fold = (rows, keyFn, add) => {
    const out = new Map();
    for (const row of rows) {
      const k = keyFn(row);
      out.set(k, add(out.get(k), row));
    }
    return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => ({ ...JSON.parse(k), ...v }));
  };
  const activity = { since: ACTIVITY_SINCE };
  activity.rate_limit = r.rateLimitActivity === undefined
    ? { read: false, reason: r.skipped?.rateLimitActivity || 'not_read' }
    : {
      read: true,
      rows: fold(r.rateLimitActivity, (x) => JSON.stringify({ action: label(x.action), day: x.day }),
        (acc = { rows: 0, requests: 0 }, x) => ({ rows: acc.rows + x.rows, requests: acc.requests + x.requests })),
    };
  activity.code_check_rows = activity.rate_limit.read
    ? activity.rate_limit.rows.filter((x) => x.action === CODE_CHECK_ACTION).reduce((n, x) => n + x.rows, 0)
    : null;
  activity.step_up = r.stepUpActivity === undefined
    ? { read: false, reason: r.skipped?.stepUpActivity || 'not_read' }
    : {
      read: true,
      rows: fold(r.stepUpActivity, (x) => JSON.stringify({ action: label(x.action), succeeded: x.succeeded, day: x.day }),
        (acc = { rows: 0 }, x) => ({ rows: acc.rows + x.rows })),
    };
  activity.enrollments = r.enrollmentTotals === undefined
    ? { read: false, reason: r.skipped?.enrollmentTotals || 'not_read' }
    : { read: true, ...(r.enrollmentTotals[0] || {}) };

  return {
    inspect: INSPECT_ID,
    read_only: true,
    transaction_read_only: session.transaction_read_only === 'on',
    current_user: session.current_user,
    session_user: session.session_user,
    server_major_version: Math.floor(Number(session.server_version_num || 0) / 10000),
    question: `does ${RATE_LIMIT_FUNCTION} accept the action '${CODE_CHECK_ACTION}'?`,
    accepts_code_check: rateLimit.accepts_code_check,
    rate_limit: rateLimit,
    functions,
    tables,
    activity,
  };
}

export function loadInspectConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'));
}

/**
 * Runs the inspect on a connected client: BEGIN READ ONLY ... ROLLBACK of the fixed
 * statements in Q only. Activity statements run only when their table has every column they
 * read. Returns the structured result; never throws.
 */
export async function inspectFinancialTotp({ connect, root, index, proposed }) {
  const repo = index || buildRepoIndex(root);
  const proposedMap = proposed || proposedBodies(root);
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
      return fail(CODES.UNRELATED_MUTATION, 'financial TOTP inspect refused: the transaction is not read-only');
    }
    r.functions = await rows(Q.functions);
    r.functionAcl = await rows(Q.functionAcl);
    r.tables = await rows(Q.tables, [[...TOTP_TABLES]]);
    r.columns = await rows(Q.columns, [[...TOTP_TABLES]]);
    for (const [key, [table, cols]] of Object.entries(ACTIVITY_REQUIRES)) {
      const have = new Set(r.columns.filter((c) => c.table_name === table).map((c) => c.column_name));
      if (!r.tables.some((t) => t.relname === table)) { r.skipped[key] = 'table_missing'; continue; }
      const missing = cols.filter((c) => !have.has(c));
      if (missing.length) { r.skipped[key] = `columns_missing:${missing.join(',')}`; continue; }
      r[key] = key === 'enrollmentTotals' ? await rows(Q[key]) : await rows(Q[key], [ACTIVITY_SINCE]);
    }
    return ok(buildFinancialTotpReport(r, repo, proposedMap));
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, 'financial TOTP inspect failed', {
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
