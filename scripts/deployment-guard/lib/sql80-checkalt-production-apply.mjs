/**
 * Production apply of SQL 80 (aws/workflows/sql/80_checkalt_member_auto_deposit.sql):
 * CREATE OR REPLACE of the SECURITY DEFINER function
 * public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) so tenant
 * owner/admin/manager/operator (not viewer) can save Check Alt Auto-Deposit,
 * its COMMENT, REVOKE ALL ... FROM PUBLIC and GRANT EXECUTE ... TO checksops,
 * authenticated.
 *
 * The fingerprint, the reviewed-text parse and the reconstructed
 * pg_get_functiondef are the staging guarded executor's own
 * (aws/write-path/guarded-sql-executor/index.mjs: readCheckaltAutoDepositState,
 * parseSql80, sql80ReviewedFunctiondef, SQL80_NORMALIZED_STATEMENTS), loaded from
 * an isolated copy of that module.
 *
 * Production differs from staging (read-only inspect 2026-10-15, SSM command
 * 1b849090-4596-49ef-aa76-c2a89b58a3a1, PostgreSQL 18.3, as checksops_admin):
 * production got SQL 38's CREATE but not its COMMENT/REVOKE/GRANT. The function
 * has the SQL 38 body, no comment, and EXECUTE for PUBLIC and checksops (not
 * authenticated); public.checkalt_tenant_accounts grants checksops arwd, UPDATE
 * included. The staging rules (acl_as_expected, table_update_granted false)
 * refuse that, so this tool carries production rules instead: they accept exactly
 * that inspected pre-state and nothing else. SQL 80 then intentionally tightens
 * the function ACL: PUBLIC loses EXECUTE, authenticated gains it, checksops keeps
 * it. The table ACL must be byte-identical before and after.
 *
 * Apply is one transaction (lock_timeout 5s, advisory locks) and rolls back
 * unless every postcondition holds and everything else in schema public (and the
 * functions in schema auth) is unchanged. Runs only on a host with private
 * reachability into the production VPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { evaluateProductionGate } from './production.mjs';
import { hashSqlDefinition } from './sql-apply.mjs';
import {
  AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT,
  CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256,
  CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256,
  CHECKALT_AUTO_DEPOSIT_FUNCTION,
  CHECKALT_AUTO_DEPOSIT_TABLE,
} from './sql-executor-auth.mjs';
import {
  createProductionDatabaseConnect,
  readUnrelatedCatalogSnapshot,
  resolveMemberStakeholderDatabaseUrl,
} from './sql-member-stakeholder-production-apply.mjs';
import { loadStagingSqlExecutor } from './staging-sql-executor-module.mjs';
import { repoRootFrom } from './paths.mjs';

export const SQL80_PRODUCTION_COMPONENT = 'production-sql';
export const SQL80_PRODUCTION_DEPLOYMENT_TYPE = 'sql-apply';
export const SQL80_PRODUCTION_PIN_REL = 'ops/deployment-guard/sql80-checkalt-member-auto-deposit-production-apply.json';
export const SQL80_STAGING_PIN = AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT;
// The staging handler's lock key plus a production-only one.
const LOCK_KEYS = Object.freeze(['sql80_checkalt_member_auto_deposit', 'sql80_checkalt_member_auto_deposit_production']);
const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const PG_CATALOG_SEARCH_PATH_SQL = "SELECT set_config('search_path', 'pg_catalog', false)";
const TABLE_NAME = CHECKALT_AUTO_DEPOSIT_TABLE.replace(/^public\./, '');

// Non-owner function ACL entries the production pre-state has, and the ones SQL 80 leaves.
export const SQL80_PRODUCTION_PRE_FUNCTION_ACL_ENTRIES = Object.freeze(['PUBLIC EXECUTE', 'checksops EXECUTE']);
export const SQL80_PRODUCTION_POST_FUNCTION_ACL_ENTRIES = Object.freeze(['authenticated EXECUTE', 'checksops EXECUTE']);
// The one non-owner table UPDATE production already has (checksops arwd), and must keep.
export const SQL80_PRODUCTION_TABLE_UPDATE_ENTRIES = Object.freeze(['checksops UPDATE']);

// --- production-only reads (never part of the fingerprint) -------------------
// Names are qualified through pg_namespace and pg_catalog.

const FUNCTION_DETAIL_SQL = `
SELECT p.proacl::text AS function_acl, pg_catalog.pg_get_userbyid(p.proowner) AS function_owner
FROM pg_catalog.pg_proc p
WHERE p.oid = pg_catalog.to_regprocedure($1)
`.trim();
// Every non-owner entry, grantor included; a NULL proacl reads as the default (PUBLIC EXECUTE).
const FUNCTION_ACL_ENTRIES_SQL = `
SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, pg_catalog.pg_get_userbyid(a.grantor) AS grantor, a.privilege_type, a.is_grantable
FROM pg_catalog.pg_proc p
CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
WHERE p.oid = pg_catalog.to_regprocedure($1) AND a.grantee <> p.proowner
ORDER BY 1, 3, 2
`.trim();
const TABLE_DETAIL_SQL = `
SELECT c.relacl::text AS table_acl, pg_catalog.pg_get_userbyid(c.relowner) AS table_owner
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = '${TABLE_NAME}' AND c.relkind IN ('r', 'p')
`.trim();
const TABLE_ACL_ENTRIES_SQL = `
SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, pg_catalog.pg_get_userbyid(a.grantor) AS grantor, a.privilege_type, a.is_grantable
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public' AND c.relname = '${TABLE_NAME}' AND c.relkind IN ('r', 'p')
  AND a.grantee <> c.relowner
ORDER BY 1, 3, 2
`.trim();
// Column-level UPDATE grants on the table to anyone but its owner.
const COLUMN_UPDATE_SQL = `
SELECT a.attname::text AS column_name, COALESCE(r.rolname, 'PUBLIC') AS grantee, x.is_grantable
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
LEFT JOIN pg_catalog.pg_roles r ON r.oid = x.grantee
WHERE n.nspname = 'public' AND c.relname = '${TABLE_NAME}' AND c.relkind IN ('r', 'p')
  AND x.privilege_type = 'UPDATE' AND x.grantee <> c.relowner
ORDER BY 1, 2
`.trim();
// authenticated may UPDATE any column by any route (own grant, PUBLIC, membership).
// NULL (table or role missing) is treated as yes.
const AUTHENTICATED_UPDATE_SQL = `
SELECT CASE WHEN pg_catalog.to_regclass('${CHECKALT_AUTO_DEPOSIT_TABLE}') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN NULL
  ELSE pg_catalog.has_any_column_privilege('authenticated', '${CHECKALT_AUTO_DEPOSIT_TABLE}', 'UPDATE')
  END AS can_update
`.trim();
// Whether authenticated is a member of checksops, directly or through other roles.
const AUTHENTICATED_IN_CHECKSOPS_SQL = `
WITH RECURSIVE m AS (
  SELECT am.member FROM pg_catalog.pg_auth_members am
  JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
  WHERE g.rolname = 'checksops'
  UNION
  SELECT am.member FROM pg_catalog.pg_auth_members am JOIN m ON am.roleid = m.member
)
SELECT EXISTS (SELECT 1 FROM m JOIN pg_catalog.pg_roles r ON r.oid = m.member WHERE r.rolname = 'authenticated') AS member
`.trim();
// Functions of schema auth (auth.uid() and friends), which SQL 80's body calls.
const AUTH_FUNCTIONS_SQL = `
SELECT p.oid::regprocedure::text AS sig, pg_catalog.pg_get_userbyid(p.proowner) AS owner, md5(p.prosrc) AS src_md5,
  p.prosecdef, p.proconfig::text AS config, p.proacl::text AS acl
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'auth'
ORDER BY 1
`.trim();

const entryLine = (row) => `${row.grantee} ${row.privilege_type}${row.is_grantable === true ? ' with grant option' : ''}`;

/** Readable ACLs and owners of the function and the table, plus the UPDATE and membership checks. */
export async function readCheckaltProductionDetail(client) {
  const fn = (await client.query(FUNCTION_DETAIL_SQL, [CHECKALT_AUTO_DEPOSIT_FUNCTION]))?.rows?.[0] || null;
  const fnEntries = fn ? ((await client.query(FUNCTION_ACL_ENTRIES_SQL, [CHECKALT_AUTO_DEPOSIT_FUNCTION]))?.rows || []) : [];
  const table = (await client.query(TABLE_DETAIL_SQL))?.rows?.[0] || null;
  const tableEntries = table ? ((await client.query(TABLE_ACL_ENTRIES_SQL))?.rows || []) : [];
  const columns = table ? ((await client.query(COLUMN_UPDATE_SQL))?.rows || []) : [];
  const canUpdate = (await client.query(AUTHENTICATED_UPDATE_SQL))?.rows?.[0]?.can_update;
  const member = (await client.query(AUTHENTICATED_IN_CHECKSOPS_SQL))?.rows?.[0]?.member;
  return ok({
    function_acl: fn ? (fn.function_acl ?? null) : null,
    function_owner: fn ? fn.function_owner : null,
    function_acl_entries: fnEntries.map(entryLine).sort(),
    function_acl_entries_with_grantor: fnEntries.map((row) => `${entryLine(row)} granted by ${row.grantor}`).sort(),
    table_present: table !== null,
    table_acl: table ? (table.table_acl ?? null) : null,
    table_owner: table ? table.table_owner : null,
    table_acl_entries_with_grantor: tableEntries.map((row) => `${entryLine(row)} granted by ${row.grantor}`).sort(),
    table_update_entries: tableEntries.filter((row) => row.privilege_type === 'UPDATE').map(entryLine).sort(),
    table_grant_option: tableEntries.some((row) => row.is_grantable === true),
    column_update_entries: columns.map((row) => `${TABLE_NAME}.${row.column_name} ${row.grantee} UPDATE${row.is_grantable === true ? ' with grant option' : ''}`).sort(),
    authenticated_can_update: canUpdate === false ? false : true,
    authenticated_member_of_checksops: member === false ? false : true,
  });
}

/** The staging reader's state plus `production` (readable ACLs, owners), which is never hashed. */
async function readState(client, executor) {
  const state = await executor.readCheckaltAutoDepositState(client);
  if (!state.ok) return state;
  const detail = await readCheckaltProductionDetail(client);
  if (!detail.ok) return detail;
  return ok({ ...state.details, production: detail.details });
}

async function readAuthFunctions(client) {
  const rows = (await client.query(AUTH_FUNCTIONS_SQL))?.rows || [];
  return hashSqlDefinition(rows.map((row) => JSON.stringify(row)).join('\n'));
}

/** Everything SQL 80 must not touch: schema public except this one function, plus schema auth's functions. */
export async function readSql80UnrelatedSnapshot(client) {
  const snapshot = await readUnrelatedCatalogSnapshot(client, { functions_ignored: [CHECKALT_AUTO_DEPOSIT_FUNCTION] });
  const authFunctions = await readAuthFunctions(client);
  return {
    categories: { ...snapshot.categories, auth_functions: authFunctions },
    counts: snapshot.counts,
    sha256: hashSqlDefinition(JSON.stringify({ ...snapshot.categories, auth_functions: authFunctions })),
  };
}

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);
const failed = (checks) => checks.filter(([, passed]) => !passed).map(([name]) => name);

/** Checks that hold before and after: the reviewed function shape and the table's UPDATE surface. */
const sharedChecks = (state, pin) => [
  ['function_present', state?.exists === true],
  ['no_overloads', state?.overload_count === 1],
  ['security_definer', state?.security_definer === true],
  ['config_as_reviewed', state?.config_as_reviewed === true],
  ['owner_is_session_user', state?.owner_is_executor === true],
  ['required_roles_present', state?.required_roles_present === true],
  ['required_tables_present', state?.required_tables_present === true],
  ['required_functions_present', state?.required_functions_present === true],
  ['table_acl_as_inspected', typeof pin?.production_inspect?.table_acl === 'string'
    && state?.production?.table_acl === pin.production_inspect.table_acl],
  ['table_owner_as_inspected', typeof pin?.production_inspect?.table_owner === 'string'
    && state?.production?.table_owner === pin.production_inspect.table_owner],
  ['table_update_only_checksops', sameList(state?.production?.table_update_entries, SQL80_PRODUCTION_TABLE_UPDATE_ENTRIES)],
  ['no_table_grant_option', state?.production?.table_grant_option === false],
  ['no_column_update_grants', sameList(state?.production?.column_update_entries, [])],
  ['authenticated_cannot_update_table', state?.production?.authenticated_can_update === false],
  ['authenticated_not_member_of_checksops', state?.production?.authenticated_member_of_checksops === false],
];

/** Production pre-apply rule: exactly the state the 2026-10-15 inspect read. */
export function sql80ProductionPreconditionFailures(state, pin) {
  return failed([
    ...sharedChecks(state, pin),
    ['definition_is_sql38', state?.function_states?.definition === 'expected'],
    ['comment_absent', state?.function_states?.comment === 'none'],
    ['function_execute_public_and_checksops_only', sameList(state?.production?.function_acl_entries, SQL80_PRODUCTION_PRE_FUNCTION_ACL_ENTRIES)],
    ['function_acl_as_inspected', typeof pin?.production_inspect?.function_acl === 'string'
      && state?.production?.function_acl === pin.production_inspect.function_acl],
    ['function_owner_as_inspected', typeof pin?.production_inspect?.function_owner === 'string'
      && state?.production?.function_owner === pin.production_inspect.function_owner],
  ]);
}

/**
 * Production post-apply rule. `reviewedDefinitionSha256` is the sha256 of the
 * pg_get_functiondef reconstructed from the pinned file's own body
 * (sql80ReviewedFunctiondef), so the live definition is compared with the
 * reviewed text, not only with a constant.
 */
export function sql80ProductionPostconditionFailures(before, after, pin, reviewedDefinitionSha256) {
  return failed([
    ['intended_state', after?.live_definition_sha256 === pin?.intended_replacement_sha256],
    ['definition_is_reviewed_sql80', after?.function_states?.definition === 'intended'
      && typeof reviewedDefinitionSha256 === 'string'
      && after?.function_definition_sha256 === reviewedDefinitionSha256],
    ['comment_is_sql80', after?.function_states?.comment === 'intended'],
    ...sharedChecks(after, pin),
    ['function_execute_checksops_and_authenticated_only', sameList(after?.production?.function_acl_entries, SQL80_PRODUCTION_POST_FUNCTION_ACL_ENTRIES)],
    ['public_execute_revoked', !(after?.production?.function_acl_entries || ['PUBLIC']).some((line) => line.startsWith('PUBLIC '))],
    ['function_acl_as_intended', typeof pin?.intended_post_state?.function_acl === 'string'
      && after?.production?.function_acl === pin.intended_post_state.function_acl],
    ['function_owner_unchanged', typeof before?.production?.function_owner === 'string'
      && after?.production?.function_owner === before.production.function_owner],
    ['table_acl_unchanged', typeof before?.production?.table_acl === 'string'
      && after?.production?.table_acl === before.production.table_acl
      && after?.production?.table_owner === before.production.table_owner
      && sameList(after?.production?.table_acl_entries_with_grantor, before?.production?.table_acl_entries_with_grantor)],
  ]);
}

const alreadyApplied = (state, pin) => state.live_definition_sha256 === pin.intended_replacement_sha256
  || state.function_states?.definition === 'intended';

export function loadSql80ProductionPin(root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, SQL80_PRODUCTION_PIN_REL), 'utf8'));
}

/** A pin may only name SQL 80's file, environment and component. */
function pinBindingFailures(pin) {
  return [
    ['migration', 'sql80'],
    ['filename', SQL80_STAGING_PIN.filename],
    ['migration_id', SQL80_STAGING_PIN.migration_id],
    ['source_sha256', SQL80_STAGING_PIN.source_sha256],
    ['function_identity', CHECKALT_AUTO_DEPOSIT_FUNCTION],
    ['table', CHECKALT_AUTO_DEPOSIT_TABLE],
    ['target_environment', 'production'],
    ['target_component', SQL80_PRODUCTION_COMPONENT],
    ['deployment_type', SQL80_PRODUCTION_DEPLOYMENT_TYPE],
  ].filter(([field, value]) => pin?.[field] !== value).map(([field]) => field);
}

/**
 * Pinned source bytes, checked against the pin and, through the staging
 * executor's parse, against the reviewed statements, body and comment.
 */
export async function readPinnedSql80(root, pin) {
  const binding = pinBindingFailures(pin);
  if (binding.length) {
    return fail(CODES.SQL_COLLISION, 'SQL 80 production pin does not name this migration', { mismatched: binding });
  }
  const file = path.join(root, pin.filename);
  if (!fs.existsSync(file)) return fail(CODES.STALE_PACKAGE, 'pinned SQL 80 file is missing');
  const text = fs.readFileSync(file, 'utf8');
  const sha = hashSqlDefinition(text);
  if (sha !== pin.source_sha256) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, 'SQL 80 bytes differ from the production pin', {
      source_sha256: sha,
      pinned_source_sha256: pin.source_sha256,
    });
  }
  const executor = await loadStagingSqlExecutor(root);
  const parsed = executor.parseSql80(text);
  const reviewedDef = executor.sql80ReviewedFunctiondef(text);
  if (!parsed || parsed.outside !== executor.SQL80_NORMALIZED_STATEMENTS
    || hashSqlDefinition(parsed.comment) !== CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256.sql80
    || typeof reviewedDef !== 'string'
    || hashSqlDefinition(reviewedDef) !== CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql80) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 80 is not exactly the reviewed statements');
  }
  return ok({ text, source_sha256: sha, reviewed_definition_sha256: hashSqlDefinition(reviewedDef) });
}

/** Manifest checks shared by preflight and apply: exact pin plus the production gate. */
export async function evaluateSql80ProductionApply(input = {}, { root = repoRootFrom(import.meta.url), pin } = {}) {
  const thePin = pin || loadSql80ProductionPin(root);
  const sql = await readPinnedSql80(root, thePin);
  if (!sql.ok) return sql;
  const mismatched = [
    ['target_environment', 'production'],
    ['target_component', SQL80_PRODUCTION_COMPONENT],
    ['deployment_type', SQL80_PRODUCTION_DEPLOYMENT_TYPE],
    ['filename', thePin.filename],
    ['migration_id', thePin.migration_id],
    ['source_sha256', thePin.source_sha256],
    ['expected_live_definition_sha256', thePin.expected_live_definition_sha256],
    ['intended_replacement_sha256', thePin.intended_replacement_sha256],
    // The live hash from the inspect; checked here so a typo never spends the receipt.
    ['live_definition_sha256', thePin.expected_live_definition_sha256],
  ].filter(([key, value]) => input[key] !== value).map(([key]) => key);
  if (mismatched.length) {
    return fail(CODES.SQL_COLLISION, 'SQL 80 production apply is bound to the exact production pin', { mismatched });
  }
  if (!thePin.staging_acceptance?.ok || !thePin.staging_acceptance?.reference
    || input.staging_acceptance?.reference !== thePin.staging_acceptance.reference) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'staging acceptance must be the reference recorded in the production pin', {
      expected: thePin.staging_acceptance?.reference || null,
    });
  }
  const gate = evaluateProductionGate({ ...input, target_environment: 'production' });
  if (!gate.ok) return gate;
  return ok({
    migration: 'sql80',
    sql80_production_apply_allowed: true,
    expected_live_definition_sha256: thePin.expected_live_definition_sha256,
    intended_replacement_sha256: thePin.intended_replacement_sha256,
    staging_acceptance: gate.details.staging_acceptance,
  });
}

export const resolveSql80DatabaseUrl = resolveMemberStakeholderDatabaseUrl;

// --- inspect ----------------------------------------------------------------

export async function inspectSql80Production({ connect, pin, root = repoRootFrom(import.meta.url) }) {
  const thePin = pin || loadSql80ProductionPin(root);
  const source = await readPinnedSql80(root, thePin);
  const executor = await loadStagingSqlExecutor(root);
  const client = await connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const state = await readState(client, executor);
    if (!state.ok) {
      return ok({ read_only: true, migration: 'sql80', state_error: { code: state.code, message: state.message }, apply_preconditions_met: false });
    }
    const details = state.details;
    const live = details.live_definition_sha256;
    const preconditionFailures = sql80ProductionPreconditionFailures(details, thePin);
    const { production, ...staging } = details;
    return ok({
      read_only: true,
      migration: 'sql80',
      filename: thePin.filename,
      source_ok: source.ok,
      ...(source.ok ? {} : { source_error: { code: source.code, message: source.message } }),
      pin_execute: thePin.execute === true,
      // Readable ACLs and owners (not only hashes).
      function: CHECKALT_AUTO_DEPOSIT_FUNCTION,
      function_owner: production.function_owner,
      function_acl: production.function_acl,
      function_acl_entries: production.function_acl_entries_with_grantor,
      table: CHECKALT_AUTO_DEPOSIT_TABLE,
      table_owner: production.table_owner,
      table_acl: production.table_acl,
      table_acl_entries: production.table_acl_entries_with_grantor,
      table_update_entries: production.table_update_entries,
      column_update_entries: production.column_update_entries,
      authenticated_can_update_table: production.authenticated_can_update,
      authenticated_member_of_checksops: production.authenticated_member_of_checksops,
      state: staging,
      live_definition_sha256: live,
      expected_live_definition_sha256: thePin.expected_live_definition_sha256,
      intended_replacement_sha256: thePin.intended_replacement_sha256,
      live_matches_expected: live === thePin.expected_live_definition_sha256,
      already_applied: alreadyApplied(details, thePin),
      precondition_failures: preconditionFailures,
      apply_preconditions_met: source.ok
        && live === thePin.expected_live_definition_sha256
        && !alreadyApplied(details, thePin)
        && preconditionFailures.length === 0,
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

// --- apply ------------------------------------------------------------------

function loadConsumed(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { consumed: [] };
  }
}

function consumeOneUse(file, oneUseId) {
  const current = loadConsumed(file);
  current.consumed = [...new Set([...(current.consumed || []), oneUseId])];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current)}\n`, { mode: 0o600 });
}

const consumedFileFor = (root, ctx) => ctx.consumedPath || path.join(root, '.deployment-guard', 'sql80-checkalt-production-consumed.json');

/** Cheap checks that must pass before the single-use guard receipt is spent. */
export async function precheckSql80ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadSql80ProductionPin(root);
  const evaluation = await evaluateSql80ProductionApply(input, { root, pin });
  if (!evaluation.ok) return evaluation;
  if (pin.execute !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 80 production execute is not authorized by this pin');
  }
  if (typeof pin.authorization_phrase !== 'string' || !pin.authorization_phrase || input.authorization_phrase !== pin.authorization_phrase) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL 80 production apply requires the exact authorization phrase');
  }
  if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
    return fail(CODES.INVALID_MANIFEST, 'SQL 80 production apply requires a single-use id');
  }
  if (loadConsumed(consumedFileFor(root, ctx)).consumed.includes(input.one_use_id)) {
    return fail(CODES.RECEIPT_REUSED, 'one_use_id has already been consumed; replay is forbidden', { one_use_id: input.one_use_id });
  }
  return evaluation;
}

export async function executeSql80ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadSql80ProductionPin(root);
  const evaluation = await precheckSql80ProductionApply(input, { ...ctx, root, pin });
  if (!evaluation.ok) return evaluation;
  const consumedFile = consumedFileFor(root, ctx);
  const sql = await readPinnedSql80(root, pin);
  if (!sql.ok) return sql;
  if (typeof ctx.connect !== 'function') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 80 production apply requires a database connection factory');
  }
  const executor = await loadStagingSqlExecutor(root);

  const client = await ctx.connect();
  let inTx = false;
  let committed = false;
  let commitSent = false;
  const rollback = async (result) => {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      inTx = false;
    }
    return result;
  };
  try {
    await client.query('BEGIN');
    inTx = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const key of LOCK_KEYS) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);

    const before = await readState(client, executor);
    if (!before.ok) return rollback(before);
    if (alreadyApplied(before.details, pin)) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'SQL 80 is already in place; refuse re-apply', {
        live_definition_sha256: before.details.live_definition_sha256,
        function_states: before.details.function_states,
      }));
    }
    const preFailures = sql80ProductionPreconditionFailures(before.details, pin);
    if (preFailures.length) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, 'SQL 80 pre-apply conditions are not met', {
        failed: preFailures,
        function_acl: before.details.production.function_acl,
        table_acl: before.details.production.table_acl,
      }));
    }
    if (before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== input.live_definition_sha256) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, 'SQL 80 live state is not the pinned pre-apply state', {
        live_definition_sha256: before.details.live_definition_sha256,
        expected_live_definition_sha256: pin.expected_live_definition_sha256,
      }));
    }
    const snapshotBefore = await readSql80UnrelatedSnapshot(client);

    await client.query(sql.details.text);

    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const after = await readState(client, executor);
    if (!after.ok) return rollback(after);
    const snapshotAfter = await readSql80UnrelatedSnapshot(client);
    const postFailures = sql80ProductionPostconditionFailures(before.details, after.details, pin, sql.details.reviewed_definition_sha256);
    const changed = Object.keys(snapshotBefore.categories).filter((name) => snapshotBefore.categories[name] !== snapshotAfter.categories[name]);
    if (postFailures.length || changed.length) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'SQL 80 did not land exactly on the reviewed state, or changed something else', {
        failed: postFailures,
        unrelated_changed: changed,
        after_hash: after.details.live_definition_sha256,
        function_acl: after.details.production.function_acl,
        table_acl: after.details.production.table_acl,
      }));
    }

    commitSent = true;
    await client.query('COMMIT');
    inTx = false;
    committed = true;
    return ok({
      receipt: {
        migration: 'sql80',
        workstream: input.workstream_id,
        commit: input.commit,
        sql_file: pin.filename,
        before_hash: before.details.live_definition_sha256,
        after_hash: after.details.live_definition_sha256,
        function_acl_before: before.details.production.function_acl,
        function_acl_after: after.details.production.function_acl,
        table_acl: after.details.production.table_acl,
        unrelated_catalog_sha256: snapshotAfter.sha256,
        unrelated_catalog_counts: snapshotAfter.counts,
        staging_acceptance: evaluation.details.staging_acceptance,
        result: 'applied',
      },
    });
  } catch (error) {
    if (commitSent) {
      // COMMIT may have landed before the error; a re-run is refused once the after-state is live.
      inTx = false;
      return fail(CODES.SQL_COLLISION, 'SQL 80 production COMMIT outcome is unknown; re-run --inspect before anything else', {
        message: String(error?.message || error).slice(0, 300),
      });
    }
    return rollback(fail(CODES.SQL_COLLISION, 'SQL 80 production apply failed and was rolled back', {
      message: String(error?.message || error).slice(0, 300),
    }));
  } finally {
    await client.end().catch(() => {});
    // Recorded after the transaction so a registry write error is never reported as a rollback.
    if (committed) {
      try {
        consumeOneUse(consumedFile, input.one_use_id);
      } catch (error) {
        process.stderr.write(`SQL 80 apply COMMITTED; one_use_id ${input.one_use_id} could not be recorded: ${String(error?.message || error).slice(0, 200)}\n`);
      }
    }
  }
}

export { createProductionDatabaseConnect };
