/**
 * Production apply of SQL 71 (aws/workflows/sql/71_review_amount_column_grant.sql):
 * the single statement GRANT UPDATE (amount) ON TABLE public.check_intake_items
 * TO checksops, which lets the API correct a check's amount while it is in Review.
 *
 * The live fingerprint is the staging guarded executor's (handleSql71AmountGrant /
 * readAmountGrantState): the canonical text AMOUNT_GRANT_STATE_TEXT.absent or
 * .granted, chosen by has_column_privilege('checksops', ..., 'amount', 'UPDATE'),
 * hashed. Staging and production therefore share the pre-state 2d96f50b… and the
 * post-state ff8e86f9… (AUTHORIZED_SQL71_AMOUNT_GRANT). The production rules add:
 *
 *   - the login (current_user and session_user) is the pinned admin login, and it
 *     may grant UPDATE (amount) (the table owner, or holds the grant option);
 *   - SQL 52 is a prerequisite: checksops can UPDATE routing_number and
 *     account_number; without them the apply is refused;
 *   - checksops has no table-level UPDATE (by any route) and no grant option;
 *   - the set of columns checksops can UPDATE, the table owner and the table ACL
 *     equal the values the reviewed production inspect recorded in the pin
 *     (production_inspect), so drift since that inspect refuses.
 *
 * Apply is one transaction (lock_timeout 5s, advisory locks): the pinned GRANT
 * only. It rolls back unless afterwards the updatable set is exactly the
 * pre-apply set plus `amount`, the only new column ACL entry is
 * "amount checksops UPDATE granted by <login>", the table ACL and owner are
 * byte-identical, there is still no table-level UPDATE, and everything else in
 * schema public (and schema auth's functions) is unchanged.
 * Runs only on a host with private reachability into the production VPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { homeownerAuthorizationApproved } from './homeowner-sql-production-apply.mjs';
import { evaluateProductionGate } from './production.mjs';
import { hashSqlDefinition } from './sql-apply.mjs';
import { AMOUNT_GRANT_STATE_TEXT, AUTHORIZED_SQL71_AMOUNT_GRANT } from './sql-executor-auth.mjs';
import {
  createProductionDatabaseConnect,
  readUnrelatedCatalogSnapshot,
  resolveMemberStakeholderDatabaseUrl,
} from './sql-member-stakeholder-production-apply.mjs';
import { repoRootFrom } from './paths.mjs';

export const SQL71_PRODUCTION_COMPONENT = 'production-sql';
export const SQL71_PRODUCTION_DEPLOYMENT_TYPE = 'sql-apply';
export const SQL71_PRODUCTION_PIN_REL = 'ops/deployment-guard/sql71-review-amount-production-apply.json';
export const SQL71_STAGING_PIN = AUTHORIZED_SQL71_AMOUNT_GRANT;
export const SQL71_TABLE = SQL71_STAGING_PIN.table;
export const SQL71_GRANTEE = SQL71_STAGING_PIN.grantee;
export const SQL71_COLUMN = SQL71_STAGING_PIN.column;
// SQL 52 (52_verified_ocr_micr_column_grant.sql) granted these; SQL 71 depends on them.
export const SQL71_SQL52_COLUMNS = Object.freeze(['account_number', 'routing_number']);
// The staging handler's lock key plus a production-only one.
const LOCK_KEYS = Object.freeze(['sql71_amount_grant', 'sql71_amount_grant_production']);
const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PG_CATALOG_SEARCH_PATH_SQL = "SELECT set_config('search_path', 'pg_catalog', false)";
const TABLE_NAME = SQL71_TABLE.replace(/^public\./, '');

// The file may hold only comments and this one statement (the staging handler's rule).
export const SQL71_SINGLE_STATEMENT_RE = /^(?:\s*--[^\n]*\n)*\s*GRANT UPDATE \(amount\) ON TABLE public\.check_intake_items TO checksops;\s*$/;

// --- reads (names qualified through pg_namespace and pg_catalog) --------------

const LOGIN_SQL = 'SELECT current_user::text AS current_user, session_user::text AS session_user';
const ROLE_SQL = `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${SQL71_GRANTEE}') AS present`;
const TABLE_DETAIL_SQL = `
SELECT c.relacl::text AS table_acl, pg_catalog.pg_get_userbyid(c.relowner) AS table_owner
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = '${TABLE_NAME}' AND c.relkind IN ('r', 'p')
`.trim();
// Every column and whether the grantee can UPDATE it by any route (column, table, PUBLIC, membership).
const COLUMN_UPDATE_PRIVILEGES_SQL = `
SELECT a.attname::text AS column_name,
  pg_catalog.has_column_privilege('${SQL71_GRANTEE}', c.oid, a.attnum, 'UPDATE') AS can_update
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE n.nspname = 'public' AND c.relname = '${TABLE_NAME}' AND c.relkind IN ('r', 'p')
ORDER BY 1
`.trim();
const TABLE_UPDATE_PRIVILEGE_SQL = `SELECT pg_catalog.has_table_privilege('${SQL71_GRANTEE}', '${SQL71_TABLE}', 'UPDATE') AS can_update`;
// Direct table ACL entries of anyone but the owner, grantor included.
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
// Every direct column ACL entry on the table (all privileges, all grantees), grantor included.
const COLUMN_ACL_ENTRIES_SQL = `
SELECT a.attname::text AS column_name, COALESCE(r.rolname, 'PUBLIC') AS grantee,
  pg_catalog.pg_get_userbyid(x.grantor) AS grantor, x.privilege_type, x.is_grantable
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
LEFT JOIN pg_catalog.pg_roles r ON r.oid = x.grantee
WHERE n.nspname = 'public' AND c.relname = '${TABLE_NAME}' AND c.relkind IN ('r', 'p')
ORDER BY 1, 2, 4, 3
`.trim();
// Whether the login may grant UPDATE (amount): the owner, or a holder of the grant option.
const LOGIN_CAN_GRANT_SQL = `
SELECT CASE WHEN pg_catalog.to_regclass('${SQL71_TABLE}') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = pg_catalog.to_regclass('${SQL71_TABLE}') AND attname = '${SQL71_COLUMN}' AND NOT attisdropped)
  THEN NULL
  ELSE pg_catalog.has_column_privilege(current_user, '${SQL71_TABLE}', '${SQL71_COLUMN}', 'UPDATE WITH GRANT OPTION')
  END AS can_grant
`.trim();
// The table itself, apart from the amount column's ACL: owner, RLS, ACL, columns, constraints,
// policies and triggers. readUnrelatedCatalogSnapshot skips this table, so it is compared here.
const TABLE_SHAPE_SQL = `
SELECT 'relation' AS kind, pg_catalog.pg_get_userbyid(c.relowner) || ' ' || c.relrowsecurity::text || ' ' || c.relforcerowsecurity::text || ' ' || COALESCE(c.relacl::text, '') AS detail
FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass($1)
UNION ALL
SELECT 'column', a.attnum::text || ' ' || a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text
  || ' ' || CASE WHEN a.attname = $2 THEN '<sql71>' ELSE COALESCE(a.attacl::text, '') END
  || ' ' || COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '')
FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = pg_catalog.to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'constraint', con.conname || ' ' || pg_catalog.pg_get_constraintdef(con.oid)
FROM pg_catalog.pg_constraint con WHERE con.conrelid = pg_catalog.to_regclass($1)
UNION ALL
SELECT 'policy', pol.polname || ' ' || pol.polcmd::text || ' ' || pol.polpermissive::text || ' ' || pol.polroles::text
  || ' ' || COALESCE(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || COALESCE(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '')
FROM pg_catalog.pg_policy pol WHERE pol.polrelid = pg_catalog.to_regclass($1)
UNION ALL
SELECT 'index', pg_catalog.pg_get_indexdef(i.indexrelid)
FROM pg_catalog.pg_index i WHERE i.indrelid = pg_catalog.to_regclass($1)
ORDER BY 1, 2
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
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);
const failed = (checks) => checks.filter(([, passed]) => !passed).map(([name]) => name);

/** The pinned admin login (the only login the tool runs as). */
export function sql71AdminLogin(pin) {
  const login = pin?.admin_login;
  return typeof login === 'string' && login ? login : null;
}

/**
 * The staging fingerprint plus readable production detail: the login, the table
 * owner and ACL, every column checksops can UPDATE, the SQL 52 columns, table-level
 * UPDATE and the direct column ACL entries.
 */
export async function readSql71State(client) {
  const login = (await client.query(LOGIN_SQL))?.rows?.[0] || {};
  const rolePresent = (await client.query(ROLE_SQL))?.rows?.[0]?.present === true;
  const table = (await client.query(TABLE_DETAIL_SQL))?.rows?.[0] || null;
  if (!table) return fail(CODES.SQL_COLLISION, `${SQL71_TABLE} is missing`);
  if (!rolePresent) {
    return ok({
      current_user: typeof login.current_user === 'string' ? login.current_user : null,
      session_user: typeof login.session_user === 'string' ? login.session_user : null,
      grantee_role_present: false,
      table_present: true,
      table_owner: table.table_owner,
      table_acl: table.table_acl ?? null,
      live_definition_sha256: null,
    });
  }
  const rows = (await client.query(COLUMN_UPDATE_PRIVILEGES_SQL))?.rows || [];
  if (!rows.length) return fail(CODES.SQL_COLLISION, `${SQL71_TABLE} has no columns visible to the login`);
  const columns = rows.map((row) => row.column_name);
  const updatable = rows.filter((row) => row.can_update === true).map((row) => row.column_name).sort();
  const tableLevel = (await client.query(TABLE_UPDATE_PRIVILEGE_SQL))?.rows?.[0]?.can_update === true;
  const tableEntries = (await client.query(TABLE_ACL_ENTRIES_SQL))?.rows || [];
  const columnEntries = (await client.query(COLUMN_ACL_ENTRIES_SQL))?.rows || [];
  const canGrant = (await client.query(LOGIN_CAN_GRANT_SQL))?.rows?.[0]?.can_grant;
  const amountPresent = columns.includes(SQL71_COLUMN);
  const granted = amountPresent && updatable.includes(SQL71_COLUMN);
  const sql52 = Object.fromEntries(SQL71_SQL52_COLUMNS.map((name) => [name, updatable.includes(name)]));
  const sql52Missing = SQL71_SQL52_COLUMNS.filter((name) => !columns.includes(name));
  const grantee = (row) => row.grantee === SQL71_GRANTEE;
  return ok({
    current_user: typeof login.current_user === 'string' ? login.current_user : null,
    session_user: typeof login.session_user === 'string' ? login.session_user : null,
    grantee_role_present: true,
    table_present: true,
    table_owner: table.table_owner,
    table_acl: table.table_acl ?? null,
    table_acl_entries: tableEntries.map((row) => `${entryLine(row)} granted by ${row.grantor}`).sort(),
    amount_column_present: amountPresent,
    amount_update_granted: granted,
    amount_column_grant: columnEntries.some((row) => grantee(row) && row.column_name === SQL71_COLUMN && row.privilege_type === 'UPDATE'),
    routing_number_update_granted: sql52.routing_number,
    account_number_update_granted: sql52.account_number,
    sql52_columns_missing: sql52Missing,
    sql52_prerequisite_met: sql52Missing.length === 0 && SQL71_SQL52_COLUMNS.every((name) => sql52[name] === true),
    table_level_update: tableLevel,
    updatable_columns: updatable,
    updatable_columns_sha256: hashSqlDefinition(updatable.join(',')),
    column_update_entries: columnEntries.filter((row) => row.privilege_type === 'UPDATE')
      .map((row) => `${row.column_name} ${entryLine(row)} granted by ${row.grantor}`).sort(),
    column_acl_entries: columnEntries.map((row) => `${row.column_name} ${entryLine(row)} granted by ${row.grantor}`).sort(),
    grantee_grant_option: tableEntries.concat(columnEntries).some((row) => grantee(row) && row.is_grantable === true),
    login_can_grant_amount: canGrant === true,
    // The staging handler's fingerprint (readAmountGrantState).
    live_definition_sha256: hashSqlDefinition(granted ? AMOUNT_GRANT_STATE_TEXT.granted : AMOUNT_GRANT_STATE_TEXT.absent),
  });
}

async function readTableShape(client) {
  const rows = (await client.query(TABLE_SHAPE_SQL, [SQL71_TABLE, SQL71_COLUMN]))?.rows || [];
  return hashSqlDefinition(rows.map((row) => `${row.kind} ${row.detail}`).join('\n'));
}

/** Everything SQL 71 must not touch: schema public (this table apart from amount's ACL included) and schema auth's functions. */
export async function readSql71UnrelatedSnapshot(client) {
  const snapshot = await readUnrelatedCatalogSnapshot(client, { skip_relations: [SQL71_TABLE] });
  const authRows = (await client.query(AUTH_FUNCTIONS_SQL))?.rows || [];
  const authFunctions = hashSqlDefinition(authRows.map((row) => JSON.stringify(row)).join('\n'));
  const tableShape = await readTableShape(client);
  const categories = { ...snapshot.categories, auth_functions: authFunctions, check_intake_items_except_amount_acl: tableShape };
  return { categories, counts: snapshot.counts, sha256: hashSqlDefinition(JSON.stringify(categories)) };
}

/** Production pre-apply rule. */
export function sql71ProductionPreconditionFailures(state, pin) {
  const recorded = pin?.production_inspect || {};
  const login = sql71AdminLogin(pin);
  return failed([
    ['login_is_pinned_admin', login !== null && state?.current_user === login && state?.session_user === login],
    ['grantee_role_present', state?.grantee_role_present === true],
    ['table_present', state?.table_present === true],
    ['amount_column_present', state?.amount_column_present === true],
    ['amount_update_absent', state?.amount_update_granted === false && state?.amount_column_grant === false],
    ['no_table_level_update', state?.table_level_update === false],
    ['sql52_routing_number_granted', state?.routing_number_update_granted === true],
    ['sql52_account_number_granted', state?.account_number_update_granted === true],
    ['no_grantee_grant_option', state?.grantee_grant_option === false],
    ['login_can_grant_amount', state?.login_can_grant_amount === true],
    ['table_owner_as_inspected', typeof recorded.table_owner === 'string' && state?.table_owner === recorded.table_owner],
    ['table_acl_as_inspected', typeof recorded.table_acl === 'string' && state?.table_acl === recorded.table_acl],
    ['updatable_columns_as_inspected', Array.isArray(recorded.updatable_columns)
      && sameList(state?.updatable_columns, recorded.updatable_columns)
      && state?.updatable_columns_sha256 === recorded.updatable_columns_sha256],
  ]);
}

/** Production post-apply rule: the updatable set grows by exactly amount, nothing else changes. */
export function sql71ProductionPostconditionFailures(before, after, pin) {
  const login = sql71AdminLogin(pin);
  const expectedColumns = [...new Set([...(before?.updatable_columns || []), SQL71_COLUMN])].sort();
  const expectedEntries = [...(before?.column_update_entries || []), `${SQL71_COLUMN} ${SQL71_GRANTEE} UPDATE granted by ${login}`].sort();
  return failed([
    ['intended_state', after?.live_definition_sha256 === pin?.intended_replacement_sha256],
    ['amount_update_granted', after?.amount_update_granted === true && after?.amount_column_grant === true],
    ['updatable_columns_grew_by_amount_only', Array.isArray(before?.updatable_columns)
      && !before.updatable_columns.includes(SQL71_COLUMN)
      && sameList(after?.updatable_columns, expectedColumns)],
    ['column_update_entries_grew_by_amount_only', login !== null && sameList(after?.column_update_entries, expectedEntries)],
    ['other_column_acl_unchanged', sameList(
      (after?.column_acl_entries || []).filter((line) => !line.startsWith(`${SQL71_COLUMN} `)),
      (before?.column_acl_entries || []).filter((line) => !line.startsWith(`${SQL71_COLUMN} `)),
    )],
    ['no_table_level_update', after?.table_level_update === false],
    ['no_grantee_grant_option', after?.grantee_grant_option === false],
    ['sql52_still_granted', after?.sql52_prerequisite_met === true],
    ['table_acl_unchanged', after?.table_acl === before?.table_acl && after?.table_owner === before?.table_owner
      && sameList(after?.table_acl_entries, before?.table_acl_entries)],
    ['login_is_pinned_admin', login !== null && after?.current_user === login && after?.session_user === login],
  ]);
}

const alreadyApplied = (state, pin) => state?.table_level_update === false
  && state?.amount_column_grant === true
  && state?.live_definition_sha256 === pin.intended_replacement_sha256;

export function loadSql71ProductionPin(root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, SQL71_PRODUCTION_PIN_REL), 'utf8'));
}

/** A pin may only name SQL 71's file, statement, environment and component. */
function pinBindingFailures(pin) {
  return [
    ['migration', 'sql71'],
    ['filename', SQL71_STAGING_PIN.filename],
    ['migration_id', SQL71_STAGING_PIN.migration_id],
    ['source_sha256', SQL71_STAGING_PIN.source_sha256],
    ['staging_pin_commit', SQL71_STAGING_PIN.commit],
    ['intended_replacement_sha256', SQL71_STAGING_PIN.intended_replacement_sha256],
    ['table', SQL71_TABLE],
    ['grantee', SQL71_GRANTEE],
    ['column', SQL71_COLUMN],
    ['target_environment', 'production'],
    ['target_component', SQL71_PRODUCTION_COMPONENT],
    ['deployment_type', SQL71_PRODUCTION_DEPLOYMENT_TYPE],
  ].filter(([field, value]) => pin?.[field] !== value).map(([field]) => field);
}

/** Pinned source bytes, checked against the pin and the single reviewed statement. */
export function readPinnedSql71(root, pin) {
  const binding = pinBindingFailures(pin);
  if (binding.length) {
    return fail(CODES.SQL_COLLISION, 'SQL 71 production pin does not name this migration', { mismatched: binding });
  }
  const file = path.join(root, pin.filename);
  if (!fs.existsSync(file)) return fail(CODES.STALE_PACKAGE, 'pinned SQL 71 file is missing');
  const text = fs.readFileSync(file, 'utf8');
  const sha = hashSqlDefinition(text);
  if (sha !== pin.source_sha256) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, 'SQL 71 bytes differ from the production pin', {
      source_sha256: sha,
      pinned_source_sha256: pin.source_sha256,
    });
  }
  if (!SQL71_SINGLE_STATEMENT_RE.test(text)) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 71 is not exactly the single pinned GRANT statement');
  }
  return ok({ text, source_sha256: sha });
}

/** Manifest checks shared by preflight and apply: exact pin, a recorded pre-state, an owner approval and the production gate. */
export async function evaluateSql71ProductionApply(input = {}, { root = repoRootFrom(import.meta.url), pin } = {}) {
  const thePin = pin || loadSql71ProductionPin(root);
  const sql = readPinnedSql71(root, thePin);
  if (!sql.ok) return sql;
  if (!SHA256_RE.test(String(thePin.expected_live_definition_sha256 || ''))) {
    return fail(CODES.SQL_COLLISION, 'SQL 71 production pin has no recorded pre-apply live definition hash yet; run --inspect and record it in a reviewed pin change');
  }
  if (!homeownerAuthorizationApproved(thePin)) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, `SQL 71 production pin authorization is not an owner approval (it is ${JSON.stringify(String(thePin.authorization ?? null).slice(0, 40))}); a reviewed pin change must record it`);
  }
  const mismatched = [
    ['target_environment', 'production'],
    ['target_component', SQL71_PRODUCTION_COMPONENT],
    ['deployment_type', SQL71_PRODUCTION_DEPLOYMENT_TYPE],
    ['filename', thePin.filename],
    ['migration_id', thePin.migration_id],
    ['source_sha256', thePin.source_sha256],
    ['expected_live_definition_sha256', thePin.expected_live_definition_sha256],
    ['intended_replacement_sha256', thePin.intended_replacement_sha256],
    // The live hash from the inspect; checked here so a typo never spends the receipt.
    ['live_definition_sha256', thePin.expected_live_definition_sha256],
  ].filter(([key, value]) => input[key] !== value).map(([key]) => key);
  if (mismatched.length) {
    return fail(CODES.SQL_COLLISION, 'SQL 71 production apply is bound to the exact production pin', { mismatched });
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
    migration: 'sql71',
    sql71_production_apply_allowed: true,
    expected_live_definition_sha256: thePin.expected_live_definition_sha256,
    intended_replacement_sha256: thePin.intended_replacement_sha256,
    staging_acceptance: gate.details.staging_acceptance,
  });
}

export const resolveSql71DatabaseUrl = resolveMemberStakeholderDatabaseUrl;

// --- inspect ----------------------------------------------------------------

export async function inspectSql71Production({ connect, pin, root = repoRootFrom(import.meta.url) }) {
  const thePin = pin || loadSql71ProductionPin(root);
  const source = readPinnedSql71(root, thePin);
  const client = await connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const state = await readSql71State(client);
    if (!state.ok) {
      return ok({ read_only: true, migration: 'sql71', state_error: { code: state.code, message: state.message }, apply_preconditions_met: false });
    }
    const d = state.details;
    const live = d.live_definition_sha256;
    const preconditionFailures = sql71ProductionPreconditionFailures(d, thePin);
    const applied = alreadyApplied(d, thePin);
    return ok({
      read_only: true,
      migration: 'sql71',
      filename: thePin.filename,
      source_ok: source.ok,
      ...(source.ok ? {} : { source_error: { code: source.code, message: source.message } }),
      pin_execute: thePin.execute === true,
      current_user: d.current_user,
      session_user: d.session_user,
      admin_login: sql71AdminLogin(thePin),
      grantee: SQL71_GRANTEE,
      table: SQL71_TABLE,
      table_owner: d.table_owner,
      table_acl: d.table_acl,
      table_acl_entries: d.table_acl_entries || [],
      // checksops' UPDATE privileges on the table, readable.
      updatable_columns: d.updatable_columns || [],
      updatable_columns_sha256: d.updatable_columns_sha256 || null,
      amount_update_granted: d.amount_update_granted ?? null,
      amount_column_grant: d.amount_column_grant ?? null,
      routing_number_update_granted: d.routing_number_update_granted ?? null,
      account_number_update_granted: d.account_number_update_granted ?? null,
      sql52_prerequisite_met: d.sql52_prerequisite_met === true,
      sql52_columns_missing: d.sql52_columns_missing || [],
      table_level_update: d.table_level_update ?? null,
      column_update_entries: d.column_update_entries || [],
      grantee_grant_option: d.grantee_grant_option ?? null,
      login_can_grant_amount: d.login_can_grant_amount ?? null,
      live_definition_sha256: live,
      expected_live_definition_sha256: thePin.expected_live_definition_sha256 ?? null,
      intended_replacement_sha256: thePin.intended_replacement_sha256,
      live_matches_expected: typeof live === 'string' && live === thePin.expected_live_definition_sha256,
      already_applied: applied,
      // What the apply must leave: the same set plus amount.
      post_state: {
        live_definition_sha256: thePin.intended_replacement_sha256,
        updatable_columns: [...new Set([...(d.updatable_columns || []), SQL71_COLUMN])].sort(),
        table_level_update: false,
      },
      precondition_failures: preconditionFailures,
      apply_preconditions_met: source.ok
        && live === thePin.expected_live_definition_sha256
        && !applied
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

const consumedFileFor = (root, ctx) => ctx.consumedPath || path.join(root, '.deployment-guard', 'sql71-review-amount-production-consumed.json');

/** Cheap checks that must pass before the single-use guard receipt is spent. */
export async function precheckSql71ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadSql71ProductionPin(root);
  const evaluation = await evaluateSql71ProductionApply(input, { root, pin });
  if (!evaluation.ok) return evaluation;
  if (pin.execute !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 71 production execute is not authorized by this pin');
  }
  if (typeof pin.authorization_phrase !== 'string' || !pin.authorization_phrase || input.authorization_phrase !== pin.authorization_phrase) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL 71 production apply requires the exact authorization phrase');
  }
  if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
    return fail(CODES.INVALID_MANIFEST, 'SQL 71 production apply requires a single-use id');
  }
  if (loadConsumed(consumedFileFor(root, ctx)).consumed.includes(input.one_use_id)) {
    return fail(CODES.RECEIPT_REUSED, 'one_use_id has already been consumed; replay is forbidden', { one_use_id: input.one_use_id });
  }
  return evaluation;
}

export async function executeSql71ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadSql71ProductionPin(root);
  const evaluation = await precheckSql71ProductionApply(input, { ...ctx, root, pin });
  if (!evaluation.ok) return evaluation;
  const consumedFile = consumedFileFor(root, ctx);
  const sql = readPinnedSql71(root, pin);
  if (!sql.ok) return sql;
  if (typeof ctx.connect !== 'function') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 71 production apply requires a database connection factory');
  }

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

    const before = await readSql71State(client);
    if (!before.ok) return rollback(before);
    const b = before.details;
    if (b.table_level_update === true) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, 'checksops has table-level UPDATE on check_intake_items; column grants are not in the expected state', {
        failed: ['no_table_level_update'],
      }));
    }
    if (alreadyApplied(b, pin) || b.amount_update_granted === true) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'checksops already has UPDATE (amount); SQL 71 is already in place; refuse re-apply', {
        live_definition_sha256: b.live_definition_sha256,
        updatable_columns: b.updatable_columns,
      }));
    }
    const preFailures = sql71ProductionPreconditionFailures(b, pin);
    if (preFailures.length) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, 'SQL 71 pre-apply conditions are not met', {
        failed: preFailures,
        current_user: b.current_user,
        updatable_columns: b.updatable_columns || null,
        sql52_columns_missing: b.sql52_columns_missing || [],
      }));
    }
    if (b.live_definition_sha256 !== pin.expected_live_definition_sha256
      || b.live_definition_sha256 !== input.live_definition_sha256) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, 'SQL 71 live state is not the pinned pre-apply state', {
        live_definition_sha256: b.live_definition_sha256,
        expected_live_definition_sha256: pin.expected_live_definition_sha256,
      }));
    }
    const snapshotBefore = await readSql71UnrelatedSnapshot(client);

    await client.query(sql.details.text);

    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const after = await readSql71State(client);
    if (!after.ok) return rollback(after);
    const snapshotAfter = await readSql71UnrelatedSnapshot(client);
    const postFailures = sql71ProductionPostconditionFailures(b, after.details, pin);
    const changed = Object.keys(snapshotBefore.categories).filter((name) => snapshotBefore.categories[name] !== snapshotAfter.categories[name]);
    if (postFailures.length || changed.length) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'SQL 71 changed more than UPDATE (amount) for checksops', {
        failed: postFailures,
        unrelated_changed: changed,
        updatable_columns_before: b.updatable_columns,
        updatable_columns_after: after.details.updatable_columns,
      }));
    }

    commitSent = true;
    await client.query('COMMIT');
    inTx = false;
    committed = true;
    return ok({
      receipt: {
        migration: 'sql71',
        workstream: input.workstream_id,
        commit: input.commit,
        sql_file: pin.filename,
        before_hash: b.live_definition_sha256,
        after_hash: after.details.live_definition_sha256,
        updatable_columns_before: b.updatable_columns,
        updatable_columns_after: after.details.updatable_columns,
        column_update_entries_after: after.details.column_update_entries,
        table_level_update: after.details.table_level_update,
        table_acl: after.details.table_acl,
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
      return fail(CODES.SQL_COLLISION, 'SQL 71 production COMMIT outcome is unknown; re-run --inspect before anything else', {
        message: String(error?.message || error).slice(0, 300),
      });
    }
    return rollback(fail(CODES.SQL_COLLISION, 'SQL 71 production apply failed and was rolled back', {
      message: String(error?.message || error).slice(0, 300),
    }));
  } finally {
    await client.end().catch(() => {});
    // Recorded after the transaction so a registry write error is never reported as a rollback.
    if (committed) {
      try {
        consumeOneUse(consumedFile, input.one_use_id);
      } catch (error) {
        process.stderr.write(`SQL 71 apply COMMITTED; one_use_id ${input.one_use_id} could not be recorded: ${String(error?.message || error).slice(0, 200)}\n`);
      }
    }
  }
}

export { createProductionDatabaseConnect };
