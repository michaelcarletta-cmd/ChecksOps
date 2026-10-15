/**
 * Production apply of SQL 81 (aws/workflows/sql/81_checkalt_production_register.sql):
 * CREATE of the SECURITY DEFINER function
 * public.aws_register_checkalt_tenant_account(uuid, jsonb), the platform-owner
 * -only writer of a tenant's production Check Alt depositor identity, its
 * COMMENT, REVOKE ALL ... FROM PUBLIC and GRANT EXECUTE ... TO checksops,
 * authenticated.
 *
 * The fingerprint, the reviewed-text parse and the reconstructed
 * pg_get_functiondef are the staging guarded executor's own
 * (aws/write-path/guarded-sql-executor/index.mjs: readCheckaltRegisterState,
 * parseSql81, sql81ReviewedFunctiondef, SQL81_NORMALIZED_STATEMENTS), loaded from
 * an isolated copy of that module.
 *
 * Before SQL 81 the function does not exist in production or staging, so the
 * pre-state fingerprint is the staging one (absent). The table differs:
 * production's public.checkalt_tenant_accounts grants checksops arwd (INSERT and
 * UPDATE included; recorded unchanged by the SQL 80 production apply of
 * 2026-10-15), which the staging rule (no INSERT/UPDATE for checksops or
 * authenticated) refuses. This tool carries production rules instead: the table
 * ACL and owner byte-equal to the pinned ones, checksops the only non-owner with
 * INSERT or UPDATE, no grant options, no column grants, authenticated unable to
 * INSERT or UPDATE by any route and not a member of checksops or of the owner.
 * The connected login must be the pinned function owner, which then owns the new
 * function; the function ACL must be exactly owner, checksops and authenticated
 * EXECUTE with PUBLIC revoked.
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
  AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER,
  CHECKALT_REGISTER_COMMENT_SHA256,
  CHECKALT_REGISTER_DEFINITION_SHA256,
  CHECKALT_REGISTER_FUNCTION,
  CHECKALT_REGISTER_TABLE,
} from './sql-executor-auth.mjs';
import {
  createProductionDatabaseConnect,
  readUnrelatedCatalogSnapshot,
  resolveMemberStakeholderDatabaseUrl,
} from './sql-member-stakeholder-production-apply.mjs';
import { loadStagingSqlExecutor } from './staging-sql-executor-module.mjs';
import { repoRootFrom } from './paths.mjs';

export const SQL81_PRODUCTION_COMPONENT = 'production-sql';
export const SQL81_PRODUCTION_DEPLOYMENT_TYPE = 'sql-apply';
export const SQL81_PRODUCTION_PIN_REL = 'ops/deployment-guard/sql81-checkalt-production-register-production-apply.json';
export const SQL81_STAGING_PIN = AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER;
// The staging handler's lock key plus a production-only one.
const LOCK_KEYS = Object.freeze(['sql81_checkalt_production_register', 'sql81_checkalt_production_register_production']);
const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const PG_CATALOG_SEARCH_PATH_SQL = "SELECT set_config('search_path', 'pg_catalog', false)";
const TABLE_NAME = CHECKALT_REGISTER_TABLE.replace(/^public\./, '');

// Non-owner function ACL entries SQL 81 leaves (PUBLIC revoked).
export const SQL81_PRODUCTION_POST_FUNCTION_ACL_ENTRIES = Object.freeze(['authenticated EXECUTE', 'checksops EXECUTE']);
// The only non-owner table INSERT/UPDATE production has (checksops arwd), and must keep.
export const SQL81_PRODUCTION_TABLE_WRITE_ENTRIES = Object.freeze(['checksops INSERT', 'checksops UPDATE']);

// --- production-only reads (never part of the fingerprint) -------------------
// Names are qualified through pg_namespace and pg_catalog.

const LOGIN_SQL = `
SELECT current_user::text AS current_user, session_user::text AS session_user
`.trim();
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
// Column-level INSERT or UPDATE grants on the table to anyone but its owner.
const COLUMN_WRITE_SQL = `
SELECT a.attname::text AS column_name, COALESCE(r.rolname, 'PUBLIC') AS grantee, x.privilege_type, x.is_grantable
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
LEFT JOIN pg_catalog.pg_roles r ON r.oid = x.grantee
WHERE n.nspname = 'public' AND c.relname = '${TABLE_NAME}' AND c.relkind IN ('r', 'p')
  AND x.privilege_type IN ('INSERT', 'UPDATE') AND x.grantee <> c.relowner
ORDER BY 1, 2, 3
`.trim();
// authenticated may INSERT or UPDATE any column by any route (own grant, PUBLIC, membership).
// NULL (table or role missing) is treated as yes.
const AUTHENTICATED_WRITE_SQL = `
SELECT CASE WHEN pg_catalog.to_regclass('${CHECKALT_REGISTER_TABLE}') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN NULL
  ELSE pg_catalog.has_any_column_privilege('authenticated', '${CHECKALT_REGISTER_TABLE}', 'UPDATE')
    OR pg_catalog.has_any_column_privilege('authenticated', '${CHECKALT_REGISTER_TABLE}', 'INSERT')
  END AS can_write
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
// Whether authenticated is a member of any of the given owner roles (the function's and the
// table's pinned owner), directly or through other roles. Every pg_auth_members row counts,
// INHERIT FALSE and SET FALSE grants included. NULL (an owner role or authenticated missing,
// or no owner given) is treated as yes.
const AUTHENTICATED_IN_OWNER_SQL = `
WITH RECURSIVE owners AS (
  SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($1::text[])
), m AS (
  SELECT am.member FROM pg_catalog.pg_auth_members am JOIN owners o ON o.oid = am.roleid
  UNION
  SELECT am.member FROM pg_catalog.pg_auth_members am JOIN m ON am.roleid = m.member
)
SELECT CASE WHEN pg_catalog.cardinality($1::text[]) = 0
    OR (SELECT count(*) FROM owners) <> (SELECT count(DISTINCT x) FROM pg_catalog.unnest($1::text[]) x)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN NULL
  ELSE EXISTS (SELECT 1 FROM m JOIN pg_catalog.pg_roles r ON r.oid = m.member WHERE r.rolname = 'authenticated')
  END AS member
`.trim();
// Functions of schema auth, which must not change.
const AUTH_FUNCTIONS_SQL = `
SELECT p.oid::regprocedure::text AS sig, pg_catalog.pg_get_userbyid(p.proowner) AS owner, md5(p.prosrc) AS src_md5,
  p.prosecdef, p.proconfig::text AS config, p.proacl::text AS acl
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'auth'
ORDER BY 1
`.trim();

const entryLine = (row) => `${row.grantee} ${row.privilege_type}${row.is_grantable === true ? ' with grant option' : ''}`;

/** The pinned owner of the new function (the login that must run the apply). */
export function sql81FunctionOwner(pin) {
  const owner = pin?.intended_post_state?.function_owner;
  return typeof owner === 'string' && owner ? owner : null;
}

/** The owner roles authenticated must not be a member of: the pinned function owner and table owner. */
export function sql81OwnerRoles(pin) {
  return [...new Set([sql81FunctionOwner(pin), pin?.production_inspect?.table_owner].filter((name) => typeof name === 'string' && name))].sort();
}

/** Readable login, ACLs and owners of the function and the table, plus the write and membership checks. */
export async function readCheckaltRegisterProductionDetail(client, { ownerRoles = [] } = {}) {
  const login = (await client.query(LOGIN_SQL))?.rows?.[0] || {};
  const fn = (await client.query(FUNCTION_DETAIL_SQL, [CHECKALT_REGISTER_FUNCTION]))?.rows?.[0] || null;
  const fnEntries = fn ? ((await client.query(FUNCTION_ACL_ENTRIES_SQL, [CHECKALT_REGISTER_FUNCTION]))?.rows || []) : [];
  const table = (await client.query(TABLE_DETAIL_SQL))?.rows?.[0] || null;
  const tableEntries = table ? ((await client.query(TABLE_ACL_ENTRIES_SQL))?.rows || []) : [];
  const columns = table ? ((await client.query(COLUMN_WRITE_SQL))?.rows || []) : [];
  const canWrite = (await client.query(AUTHENTICATED_WRITE_SQL))?.rows?.[0]?.can_write;
  const member = (await client.query(AUTHENTICATED_IN_CHECKSOPS_SQL))?.rows?.[0]?.member;
  const ownerMember = (await client.query(AUTHENTICATED_IN_OWNER_SQL, [ownerRoles]))?.rows?.[0]?.member;
  return ok({
    current_user: typeof login.current_user === 'string' ? login.current_user : null,
    session_user: typeof login.session_user === 'string' ? login.session_user : null,
    function_present: fn !== null,
    function_acl: fn ? (fn.function_acl ?? null) : null,
    function_owner: fn ? fn.function_owner : null,
    function_acl_entries: fnEntries.map(entryLine).sort(),
    function_acl_entries_with_grantor: fnEntries.map((row) => `${entryLine(row)} granted by ${row.grantor}`).sort(),
    table_present: table !== null,
    table_acl: table ? (table.table_acl ?? null) : null,
    table_owner: table ? table.table_owner : null,
    table_acl_entries_with_grantor: tableEntries.map((row) => `${entryLine(row)} granted by ${row.grantor}`).sort(),
    table_write_entries: tableEntries.filter((row) => row.privilege_type === 'INSERT' || row.privilege_type === 'UPDATE').map(entryLine).sort(),
    table_grant_option: tableEntries.some((row) => row.is_grantable === true),
    column_write_entries: columns.map((row) => `${TABLE_NAME}.${row.column_name} ${row.grantee} ${row.privilege_type}${row.is_grantable === true ? ' with grant option' : ''}`).sort(),
    authenticated_can_write: canWrite === false ? false : true,
    authenticated_member_of_checksops: member === false ? false : true,
    owner_roles: [...ownerRoles],
    authenticated_member_of_owner: ownerMember === false ? false : true,
  });
}

/** The staging reader's state plus `production` (readable login, ACLs, owners), which is never hashed. */
async function readState(client, executor, pin) {
  const state = await executor.readCheckaltRegisterState(client);
  if (!state.ok) return state;
  const detail = await readCheckaltRegisterProductionDetail(client, { ownerRoles: sql81OwnerRoles(pin) });
  if (!detail.ok) return detail;
  return ok({ ...state.details, production: detail.details });
}

async function readAuthFunctions(client) {
  const rows = (await client.query(AUTH_FUNCTIONS_SQL))?.rows || [];
  return hashSqlDefinition(rows.map((row) => JSON.stringify(row)).join('\n'));
}

/** Everything SQL 81 must not touch: schema public except the new function, plus schema auth's functions. */
export async function readSql81UnrelatedSnapshot(client) {
  const snapshot = await readUnrelatedCatalogSnapshot(client, { functions_ignored: [CHECKALT_REGISTER_FUNCTION] });
  const authFunctions = await readAuthFunctions(client);
  return {
    categories: { ...snapshot.categories, auth_functions: authFunctions },
    counts: snapshot.counts,
    sha256: hashSqlDefinition(JSON.stringify({ ...snapshot.categories, auth_functions: authFunctions })),
  };
}

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);
const failed = (checks) => checks.filter(([, passed]) => !passed).map(([name]) => name);

/** Checks that hold before and after: the login, what the body uses and the table's write surface. */
const sharedChecks = (state, pin) => [
  ['login_is_pinned_owner', sql81FunctionOwner(pin) !== null
    && state?.production?.current_user === sql81FunctionOwner(pin)
    && state?.production?.session_user === sql81FunctionOwner(pin)],
  ['required_roles_present', state?.required_roles_present === true],
  ['required_tables_present', state?.required_tables_present === true],
  ['required_functions_present', state?.required_functions_present === true],
  ['required_columns_present', state?.required_columns_present === true],
  ['table_acl_as_inspected', typeof pin?.production_inspect?.table_acl === 'string'
    && state?.production?.table_acl === pin.production_inspect.table_acl],
  ['table_owner_as_inspected', typeof pin?.production_inspect?.table_owner === 'string'
    && state?.production?.table_owner === pin.production_inspect.table_owner],
  ['table_write_only_checksops', sameList(state?.production?.table_write_entries, SQL81_PRODUCTION_TABLE_WRITE_ENTRIES)],
  ['no_table_grant_option', state?.production?.table_grant_option === false],
  ['no_column_write_grants', sameList(state?.production?.column_write_entries, [])],
  ['authenticated_cannot_write_table', state?.production?.authenticated_can_write === false],
  ['authenticated_not_member_of_checksops', state?.production?.authenticated_member_of_checksops === false],
  ['authenticated_not_member_of_owner', state?.production?.authenticated_member_of_owner === false
    && sameList(state?.production?.owner_roles, sql81OwnerRoles(pin))
    && (state?.production?.owner_roles || []).length > 0],
];

/** Production pre-apply rule: the function absent (no function of that name anywhere) and the pinned table. */
export function sql81ProductionPreconditionFailures(state, pin) {
  return failed([
    ...sharedChecks(state, pin),
    ['function_absent', state?.exists === false && state?.production?.function_present === false],
    ['no_function_named', state?.overload_count === 0],
    ['definition_absent', state?.function_states?.definition === 'absent'],
  ]);
}

/**
 * Production post-apply rule. `reviewedDefinitionSha256` is the sha256 of the
 * pg_get_functiondef reconstructed from the pinned file's own body
 * (sql81ReviewedFunctiondef), so the live definition is compared with the
 * reviewed text, not only with a constant.
 */
export function sql81ProductionPostconditionFailures(before, after, pin, reviewedDefinitionSha256) {
  return failed([
    ['intended_state', after?.live_definition_sha256 === pin?.intended_replacement_sha256],
    ['definition_is_reviewed_sql81', after?.function_states?.definition === 'intended'
      && typeof reviewedDefinitionSha256 === 'string'
      && after?.function_definition_sha256 === reviewedDefinitionSha256],
    ['comment_is_sql81', after?.function_states?.comment === 'intended'],
    ['function_present', after?.exists === true && after?.production?.function_present === true],
    ['no_overloads', after?.overload_count === 1],
    ['security_definer', after?.security_definer === true],
    ['config_as_reviewed', after?.config_as_reviewed === true],
    ['owner_is_session_user', after?.owner_is_executor === true],
    ...sharedChecks(after, pin),
    ['function_owner_as_pinned', sql81FunctionOwner(pin) !== null && after?.production?.function_owner === sql81FunctionOwner(pin)],
    ['function_execute_checksops_and_authenticated_only', sameList(after?.production?.function_acl_entries, SQL81_PRODUCTION_POST_FUNCTION_ACL_ENTRIES)],
    ['public_execute_revoked', !(after?.production?.function_acl_entries || ['PUBLIC']).some((line) => line.startsWith('PUBLIC '))],
    ['function_acl_as_intended', typeof pin?.intended_post_state?.function_acl === 'string'
      && after?.production?.function_acl === pin.intended_post_state.function_acl],
    ['table_acl_unchanged', typeof before?.production?.table_acl === 'string'
      && after?.production?.table_acl === before.production.table_acl
      && after?.production?.table_owner === before.production.table_owner
      && sameList(after?.production?.table_acl_entries_with_grantor, before?.production?.table_acl_entries_with_grantor)],
  ]);
}

const alreadyApplied = (state, pin) => state.live_definition_sha256 === pin.intended_replacement_sha256
  || state.function_states?.definition === 'intended';

export function loadSql81ProductionPin(root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, SQL81_PRODUCTION_PIN_REL), 'utf8'));
}

/** A pin may only name SQL 81's file, environment and component. */
function pinBindingFailures(pin) {
  return [
    ['migration', 'sql81'],
    ['filename', SQL81_STAGING_PIN.filename],
    ['migration_id', SQL81_STAGING_PIN.migration_id],
    ['source_sha256', SQL81_STAGING_PIN.source_sha256],
    ['function_identity', CHECKALT_REGISTER_FUNCTION],
    ['table', CHECKALT_REGISTER_TABLE],
    ['target_environment', 'production'],
    ['target_component', SQL81_PRODUCTION_COMPONENT],
    ['deployment_type', SQL81_PRODUCTION_DEPLOYMENT_TYPE],
  ].filter(([field, value]) => pin?.[field] !== value).map(([field]) => field);
}

/**
 * Pinned source bytes, checked against the pin and, through the staging
 * executor's parse, against the reviewed statements, body and comment.
 */
export async function readPinnedSql81(root, pin) {
  const binding = pinBindingFailures(pin);
  if (binding.length) {
    return fail(CODES.SQL_COLLISION, 'SQL 81 production pin does not name this migration', { mismatched: binding });
  }
  const file = path.join(root, pin.filename);
  if (!fs.existsSync(file)) return fail(CODES.STALE_PACKAGE, 'pinned SQL 81 file is missing');
  const text = fs.readFileSync(file, 'utf8');
  const sha = hashSqlDefinition(text);
  if (sha !== pin.source_sha256) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, 'SQL 81 bytes differ from the production pin', {
      source_sha256: sha,
      pinned_source_sha256: pin.source_sha256,
    });
  }
  const executor = await loadStagingSqlExecutor(root);
  const parsed = executor.parseSql81(text);
  const reviewedDef = executor.sql81ReviewedFunctiondef(text);
  if (!parsed || parsed.outside !== executor.SQL81_NORMALIZED_STATEMENTS
    || hashSqlDefinition(parsed.comment) !== CHECKALT_REGISTER_COMMENT_SHA256.sql81
    || typeof reviewedDef !== 'string'
    || hashSqlDefinition(reviewedDef) !== CHECKALT_REGISTER_DEFINITION_SHA256.sql81) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 81 is not exactly the reviewed statements');
  }
  return ok({ text, source_sha256: sha, reviewed_definition_sha256: hashSqlDefinition(reviewedDef) });
}

/** Manifest checks shared by preflight and apply: exact pin plus the production gate. */
export async function evaluateSql81ProductionApply(input = {}, { root = repoRootFrom(import.meta.url), pin } = {}) {
  const thePin = pin || loadSql81ProductionPin(root);
  const sql = await readPinnedSql81(root, thePin);
  if (!sql.ok) return sql;
  const mismatched = [
    ['target_environment', 'production'],
    ['target_component', SQL81_PRODUCTION_COMPONENT],
    ['deployment_type', SQL81_PRODUCTION_DEPLOYMENT_TYPE],
    ['filename', thePin.filename],
    ['migration_id', thePin.migration_id],
    ['source_sha256', thePin.source_sha256],
    ['expected_live_definition_sha256', thePin.expected_live_definition_sha256],
    ['intended_replacement_sha256', thePin.intended_replacement_sha256],
    // The live hash from the inspect; checked here so a typo never spends the receipt.
    ['live_definition_sha256', thePin.expected_live_definition_sha256],
  ].filter(([key, value]) => input[key] !== value).map(([key]) => key);
  if (mismatched.length) {
    return fail(CODES.SQL_COLLISION, 'SQL 81 production apply is bound to the exact production pin', { mismatched });
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
    migration: 'sql81',
    sql81_production_apply_allowed: true,
    expected_live_definition_sha256: thePin.expected_live_definition_sha256,
    intended_replacement_sha256: thePin.intended_replacement_sha256,
    staging_acceptance: gate.details.staging_acceptance,
  });
}

export const resolveSql81DatabaseUrl = resolveMemberStakeholderDatabaseUrl;

// --- inspect ----------------------------------------------------------------

export async function inspectSql81Production({ connect, pin, root = repoRootFrom(import.meta.url) }) {
  const thePin = pin || loadSql81ProductionPin(root);
  const source = await readPinnedSql81(root, thePin);
  const executor = await loadStagingSqlExecutor(root);
  const client = await connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const state = await readState(client, executor, thePin);
    if (!state.ok) {
      return ok({ read_only: true, migration: 'sql81', state_error: { code: state.code, message: state.message }, apply_preconditions_met: false });
    }
    const details = state.details;
    const live = details.live_definition_sha256;
    const preconditionFailures = sql81ProductionPreconditionFailures(details, thePin);
    const { production, ...staging } = details;
    return ok({
      read_only: true,
      migration: 'sql81',
      filename: thePin.filename,
      source_ok: source.ok,
      ...(source.ok ? {} : { source_error: { code: source.code, message: source.message } }),
      pin_execute: thePin.execute === true,
      // Readable login, ACLs and owners (not only hashes).
      current_user: production.current_user,
      session_user: production.session_user,
      function: CHECKALT_REGISTER_FUNCTION,
      function_present: production.function_present,
      function_owner: production.function_owner,
      function_acl: production.function_acl,
      function_acl_entries: production.function_acl_entries_with_grantor,
      table: CHECKALT_REGISTER_TABLE,
      table_owner: production.table_owner,
      table_acl: production.table_acl,
      table_acl_entries: production.table_acl_entries_with_grantor,
      table_write_entries: production.table_write_entries,
      column_write_entries: production.column_write_entries,
      authenticated_can_write_table: production.authenticated_can_write,
      authenticated_member_of_checksops: production.authenticated_member_of_checksops,
      owner_roles: production.owner_roles,
      authenticated_member_of_owner: production.authenticated_member_of_owner,
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

const consumedFileFor = (root, ctx) => ctx.consumedPath || path.join(root, '.deployment-guard', 'sql81-checkalt-production-consumed.json');

/** Cheap checks that must pass before the single-use guard receipt is spent. */
export async function precheckSql81ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadSql81ProductionPin(root);
  const evaluation = await evaluateSql81ProductionApply(input, { root, pin });
  if (!evaluation.ok) return evaluation;
  if (pin.execute !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 81 production execute is not authorized by this pin');
  }
  if (typeof pin.authorization_phrase !== 'string' || !pin.authorization_phrase || input.authorization_phrase !== pin.authorization_phrase) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL 81 production apply requires the exact authorization phrase');
  }
  if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
    return fail(CODES.INVALID_MANIFEST, 'SQL 81 production apply requires a single-use id');
  }
  if (loadConsumed(consumedFileFor(root, ctx)).consumed.includes(input.one_use_id)) {
    return fail(CODES.RECEIPT_REUSED, 'one_use_id has already been consumed; replay is forbidden', { one_use_id: input.one_use_id });
  }
  return evaluation;
}

export async function executeSql81ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadSql81ProductionPin(root);
  const evaluation = await precheckSql81ProductionApply(input, { ...ctx, root, pin });
  if (!evaluation.ok) return evaluation;
  const consumedFile = consumedFileFor(root, ctx);
  const sql = await readPinnedSql81(root, pin);
  if (!sql.ok) return sql;
  if (typeof ctx.connect !== 'function') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 81 production apply requires a database connection factory');
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

    const before = await readState(client, executor, pin);
    if (!before.ok) return rollback(before);
    if (alreadyApplied(before.details, pin)) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'SQL 81 is already in place; refuse re-apply', {
        live_definition_sha256: before.details.live_definition_sha256,
        function_states: before.details.function_states,
      }));
    }
    const preFailures = sql81ProductionPreconditionFailures(before.details, pin);
    if (preFailures.length) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, 'SQL 81 pre-apply conditions are not met', {
        failed: preFailures,
        current_user: before.details.production.current_user,
        function_acl: before.details.production.function_acl,
        table_acl: before.details.production.table_acl,
      }));
    }
    if (before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== input.live_definition_sha256) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, 'SQL 81 live state is not the pinned pre-apply state', {
        live_definition_sha256: before.details.live_definition_sha256,
        expected_live_definition_sha256: pin.expected_live_definition_sha256,
      }));
    }
    const snapshotBefore = await readSql81UnrelatedSnapshot(client);

    await client.query(sql.details.text);

    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const after = await readState(client, executor, pin);
    if (!after.ok) return rollback(after);
    const snapshotAfter = await readSql81UnrelatedSnapshot(client);
    const postFailures = sql81ProductionPostconditionFailures(before.details, after.details, pin, sql.details.reviewed_definition_sha256);
    const changed = Object.keys(snapshotBefore.categories).filter((name) => snapshotBefore.categories[name] !== snapshotAfter.categories[name]);
    if (postFailures.length || changed.length) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'SQL 81 did not land exactly on the reviewed state, or changed something else', {
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
        migration: 'sql81',
        workstream: input.workstream_id,
        commit: input.commit,
        sql_file: pin.filename,
        before_hash: before.details.live_definition_sha256,
        after_hash: after.details.live_definition_sha256,
        function_owner: after.details.production.function_owner,
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
      return fail(CODES.SQL_COLLISION, 'SQL 81 production COMMIT outcome is unknown; re-run --inspect before anything else', {
        message: String(error?.message || error).slice(0, 300),
      });
    }
    return rollback(fail(CODES.SQL_COLLISION, 'SQL 81 production apply failed and was rolled back', {
      message: String(error?.message || error).slice(0, 300),
    }));
  } finally {
    await client.end().catch(() => {});
    // Recorded after the transaction so a registry write error is never reported as a rollback.
    if (committed) {
      try {
        consumeOneUse(consumedFile, input.one_use_id);
      } catch (error) {
        process.stderr.write(`SQL 81 apply COMMITTED; one_use_id ${input.one_use_id} could not be recorded: ${String(error?.message || error).slice(0, 200)}\n`);
      }
    }
  }
}

export { createProductionDatabaseConnect };
