/**
 * Read-only production inspect of the billing and agent-compensation triggers (inspect only; there is no
 * apply). Owner 2026-11-12: no more $5 Mortgage Ops charge for an additional check on the same claim, no agent
 * pay for it, and no $4 check fee for a check deposited outside ChecksOps. The live trigger
 * tr_accrue_mortgage_ops_billing / tg_accrue_mortgage_ops_billing on mortgage_handling_requests has no CREATE in
 * any repository SQL (aws/docs/money-write-flag.md: "live-only, no repository SQL"), so its body must be read
 * before a migration replaces it; the others (record_check_billing_event, SQL 98; earn_mortgage_agent_compensation
 * and its trigger function, SQL 47) are compared with the repository.
 *
 * One transaction: BEGIN READ ONLY, search_path pg_catalog, statement and lock timeouts, then the fixed catalog
 * SELECTs in Q, then ROLLBACK. Nothing else is ever sent: there is no SQL argument and every statement text is a
 * constant of this file. No table row is read: catalog only.
 *
 * Output:
 *   - triggers   every non-internal trigger on WATCHED_TABLES: table, name, function, enabled flag and
 *                pg_get_triggerdef (timing, events, columns, WHEN).
 *   - functions  every public function in NAMED_FUNCTIONS plus every function a trigger above runs: signature,
 *                owner, SECURITY DEFINER, language, volatility, config names, EXECUTE ACL, sha256 of
 *                pg_get_functiondef and prosrc, repo_definitions and repo_match against aws/ and supabase/ SQL
 *                (repo_definitions 0: no repository CREATE at all), and the definition
 *                text (withheld only if it has UUID-, email- or long-number-shaped content).
 *   - columns    column names and types (no values) of COLUMN_TABLES.
 *   - missing    NAMED_FUNCTIONS not found live.
 *
 * A failure (connecting included) reports the stage and the error's code / SQLSTATE only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { buildRepoIndex, compareWithRepo, identifierShapedContent, safeErrorCode, sha256 } from './mortgage-desk-access-inspect.mjs';

export { safeErrorCode };

export const INSPECT_ID = 'billing-trigger-inspect';
export const CONFIG_REL = 'ops/deployment-guard/billing-trigger-inspect.json';
/** Tables whose triggers write billing or compensation rows. */
export const WATCHED_TABLES = Object.freeze(['mortgage_handling_requests', 'check_intake_items', 'checkalt_deposits', 'deposit_items']);
/** Functions read by name, whether or not a trigger runs them. */
export const NAMED_FUNCTIONS = Object.freeze([
  'tg_accrue_mortgage_ops_billing',
  'record_check_billing_event',
  'aws_check_processing_price_cents',
  'aws_check_billing_charges_when_per_check_off',
  'earn_mortgage_agent_compensation',
  'tg_earn_mortgage_agent_compensation',
]);
/** Tables whose column names (never values) the migration needs. */
export const COLUMN_TABLES = Object.freeze([
  'check_billing_events',
  'deposit_items',
  'mortgage_agent_compensation_rates',
  'mortgage_agent_compensation_entries',
  'mortgage_handling_requests',
]);

const VOLATILITY = Object.freeze({ i: 'IMMUTABLE', s: 'STABLE', v: 'VOLATILE' });
const ENABLED = Object.freeze({ O: 'origin', D: 'disabled', R: 'replica', A: 'always' });

const TRIGGER_FUNCTION_OIDS = `SELECT t.tgfoid FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
  WHERE NOT t.tgisinternal AND cn.nspname = 'public' AND c.relname = ANY($2::text[])`;

export const Q = Object.freeze({
  begin: 'BEGIN READ ONLY',
  searchPath: "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)",
  statementTimeout: "SELECT pg_catalog.set_config('statement_timeout', '20000', true)",
  lockTimeout: "SELECT pg_catalog.set_config('lock_timeout', '2000', true)",
  session: `SELECT current_user::text AS current_user, session_user::text AS session_user,
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
  pg_catalog.current_setting('server_version_num')::int AS server_version_num`,
  triggers: `SELECT c.relname::text AS table_name, t.tgname::text AS name, p.proname::text AS function_name,
  pn.nspname::text AS function_schema, t.tgenabled::text AS enabled, pg_catalog.pg_get_triggerdef(t.oid) AS triggerdef
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
  WHERE NOT t.tgisinternal AND cn.nspname = 'public' AND c.relname = ANY($1::text[])
  ORDER BY 1, 2`,
  functions: `SELECT n.nspname::text AS schema, p.proname::text AS name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  pg_catalog.pg_get_function_result(p.oid) AS result,
  pg_catalog.pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS security_definer,
  l.lanname::text AS language, p.provolatile::text AS volatility,
  ARRAY(SELECT pg_catalog.split_part(c, '=', 1) FROM pg_catalog.unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS c ORDER BY 1) AS config_names,
  p.prosrc AS prosrc, pg_catalog.pg_get_functiondef(p.oid) AS functiondef
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_language l ON l.oid = p.prolang
  WHERE p.prokind = 'f' AND ((n.nspname = 'public' AND p.proname = ANY($1::text[])) OR p.oid IN (${TRIGGER_FUNCTION_OIDS}))
  ORDER BY 1, 2, 3`,
  functionAcl: `SELECT n.nspname::text AS schema, p.proname::text AS name, pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee,
  pg_catalog.pg_get_userbyid(a.grantor)::text AS grantor, a.privilege_type::text AS privilege, a.is_grantable
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
  LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
  WHERE p.prokind = 'f' AND ((n.nspname = 'public' AND p.proname = ANY($1::text[])) OR p.oid IN (${TRIGGER_FUNCTION_OIDS}))
  ORDER BY 1, 2, 3, 4`,
  columns: `SELECT c.relname::text AS table_name, a.attname::text AS column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[]) AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY 1, a.attnum`,
  rollback: 'ROLLBACK',
});

/** Every statement the inspect may send, for the tests' allowlist. */
export const INSPECT_STATEMENTS = Object.freeze(Object.values(Q));

/** SQLSTATE literals (ERRCODE = '22023') are five-character codes, not identifying numbers. */
const withoutErrcodes = (def) => String(def ?? '').replace(/\bERRCODE\s*=\s*'[0-9A-Z]{5}'/gi, "ERRCODE = ''");

function definitionReport(def) {
  const shaped = identifierShapedContent(withoutErrcodes(def));
  return shaped ? { definition: null, definition_withheld: shaped } : { definition: def };
}

export function buildBillingTriggerReport(r, repo) {
  const session = r.session?.[0] || {};
  const acl = new Map();
  for (const row of r.functionAcl || []) {
    const k = `${row.schema}.${row.name}(${row.identity_arguments})`;
    if (!acl.has(k)) acl.set(k, []);
    acl.get(k).push({ grantee: row.grantee, privilege: row.privilege, grantable: row.is_grantable, grantor: row.grantor });
  }
  const triggers = (r.triggers || []).map((row) => ({
    table: row.table_name,
    name: row.name,
    function: `${row.function_schema}.${row.function_name}`,
    enabled: ENABLED[row.enabled] || row.enabled,
    triggerdef: row.triggerdef,
  }));
  const functions = (r.functions || []).map((row) => {
    const key = `${row.schema}.${row.name}`;
    const signature = `${key}(${row.identity_arguments})`;
    const cmp = compareWithRepo(repo, key, row.prosrc);
    const execute = acl.get(signature) || [];
    return {
      name: key,
      signature,
      result: row.result,
      owner: row.owner,
      security_definer: row.security_definer,
      language: row.language,
      volatility: VOLATILITY[row.volatility] || row.volatility,
      config_names: row.config_names || [],
      execute_acl: execute,
      public_execute: execute.some((e) => e.grantee === 'PUBLIC' && e.privilege === 'EXECUTE'),
      run_by_triggers: triggers.filter((t) => t.function === key).map((t) => `${t.table}.${t.name}`),
      functiondef_sha256: sha256(row.functiondef),
      prosrc_sha256: sha256(row.prosrc),
      repo_definitions: cmp.repo_definitions,
      repo_match: cmp.repo_match,
      matched_sources: cmp.matched_sources,
      ...definitionReport(row.functiondef),
    };
  });
  const found = new Set(functions.filter((f) => f.name.startsWith('public.')).map((f) => f.name.slice('public.'.length)));
  const columns = {};
  for (const row of r.columns || []) {
    (columns[row.table_name] ||= []).push({ name: row.column_name, type: row.type, not_null: row.not_null });
  }
  return {
    tool: INSPECT_ID,
    read_only: true,
    current_user: session.current_user ?? null,
    session_user: session.session_user ?? null,
    transaction_read_only: session.transaction_read_only === 'on',
    server_version_num: session.server_version_num ?? null,
    triggers,
    functions,
    missing: NAMED_FUNCTIONS.filter((name) => !found.has(name)),
    columns,
    tables_missing: COLUMN_TABLES.filter((t) => !columns[t]),
  };
}

export function loadInspectConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'));
}

/**
 * Runs the inspect on a connected client: BEGIN READ ONLY ... ROLLBACK of the fixed statements in Q only.
 * Returns the structured result; never throws.
 */
export async function inspectBillingTriggers({ connect, root, index }) {
  const repo = index || buildRepoIndex(root);
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
    const r = {};
    r.session = await rows(Q.session);
    if (r.session?.[0]?.transaction_read_only !== 'on') {
      return fail(CODES.UNRELATED_MUTATION, 'billing trigger inspect refused: the transaction is not read-only');
    }
    r.triggers = await rows(Q.triggers, [[...WATCHED_TABLES]]);
    r.functions = await rows(Q.functions, [[...NAMED_FUNCTIONS], [...WATCHED_TABLES]]);
    r.functionAcl = await rows(Q.functionAcl, [[...NAMED_FUNCTIONS], [...WATCHED_TABLES]]);
    r.columns = await rows(Q.columns, [[...COLUMN_TABLES]]);
    return ok(buildBillingTriggerReport(r, repo));
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, 'billing trigger inspect failed', {
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
