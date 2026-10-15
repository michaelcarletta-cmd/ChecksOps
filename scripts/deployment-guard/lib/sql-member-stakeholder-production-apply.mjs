/**
 * Production apply of SQL 77, 78 and 79 (check stakeholder writes), in that order.
 *
 *   sql77  GRANT SELECT, INSERT, DELETE on public.check_stakeholders
 *   sql78  CREATE TABLE public.check_partner_stakeholder_removals (+ indexes, RLS, grants)
 *   sql79  four aws_member_* INSERT/DELETE policies on those two tables
 *
 * Each migration has its own pin (ops/deployment-guard/sql7x-...-production-apply.json).
 * The catalog fingerprints, the exact-statement checks and the pre/post rules are
 * the staging guarded executor's own (aws/write-path/guarded-sql-executor/index.mjs:
 * readStakeholderGrantState, readPartnerStakeholderRemovalsState,
 * readMemberStakeholderWritesState, SQL78/79_NORMALIZED_STATEMENTS), loaded from an
 * isolated copy of that module, so production fingerprints exactly what staging did.
 * Exception, production only: the read-only production inspect of 2026-10-15 (SSM
 * command ca4ad39d) found checksops already holding SELECT, INSERT, UPDATE and
 * DELETE on public.check_stakeholders, where staging had SELECT only. The staging
 * rule `update_not_granted` (SQL 77 and SQL 79) refuses any UPDATE grant, so SQL 77
 * and SQL 79 carry production variants below that accept exactly that one
 * pre-existing UPDATE (checksops on check_stakeholders, no grant option) and
 * nothing else; every other staging condition still applies.
 * SQL 77 also requires, before and after, that public.check_stakeholders' owner is
 * the pin's inspected owner (production_inspect.table_owner, checksops_admin), that
 * the tool runs as that owner (current_user), and that authenticated is not a
 * member of it (recursive pg_auth_members, INHERIT FALSE grants included).
 * On top of that, apply refuses while a predecessor migration is not applied or a
 * dependency is missing, and rolls back unless every unrelated object in schema
 * public (relations, columns, constraints, policies, functions, triggers, ACLs,
 * roles, default privileges) is byte-identical before and after.
 * Runs only on a host with private reachability into the production VPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { resolveLedgerDatabaseUrl } from './ledger-production-apply.mjs';
import { evaluateProductionGate } from './production.mjs';
import { hashSqlDefinition } from './sql-apply.mjs';
import {
  AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT,
  AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS,
  AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES,
  MEMBER_STAKEHOLDER_NEW_POLICIES,
  MEMBER_STAKEHOLDER_TABLES,
  PARTNER_STAKEHOLDER_REMOVALS_TABLE,
  STAKEHOLDER_GRANT_TABLE,
} from './sql-executor-auth.mjs';
import { createProductionDatabaseConnect } from './sql53-production-apply.mjs';
import { loadStagingSqlExecutor } from './staging-sql-executor-module.mjs';
import { repoRootFrom } from './paths.mjs';

export const MEMBER_STAKEHOLDER_PRODUCTION_COMPONENT = 'production-sql';
export const MEMBER_STAKEHOLDER_PRODUCTION_DEPLOYMENT_TYPE = 'sql-apply';
export const MEMBER_STAKEHOLDER_MIGRATION_ORDER = Object.freeze(['sql77', 'sql78', 'sql79']);
// Serializes the three production applies against each other, on top of each
// migration's own staging lock key.
const SERIES_LOCK_KEY = 'sql77_79_member_stakeholder_production';
const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;

// Same expression as the staging executor's SQL77_SINGLE_STATEMENT_RE (the test
// compares it with the executor source): only comments and the one GRANT.
export const SQL77_SINGLE_STATEMENT_RE = /^(?:\s*--[^\n]*\n)*\s*GRANT SELECT, INSERT, DELETE ON TABLE public\.check_stakeholders TO checksops, authenticated;\s*$/;
// The staging executor's normalizeSql78 / normalizeSql79.
const normalizeStatements = (text) => String(text).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();

const PG_CATALOG_SEARCH_PATH_SQL = "SELECT set_config('search_path', 'pg_catalog', false)";

// Every object a migration's file or its policies need, read without raising.
const DEPENDENCIES_SQL = `
SELECT
  to_regclass('public.check_stakeholders') IS NOT NULL AS check_stakeholders,
  to_regclass('public.check_partner_stakeholder_removals') IS NOT NULL AS check_partner_stakeholder_removals,
  to_regclass('public.check_intake_items') IS NOT NULL AS check_intake_items,
  to_regclass('public.tenants') IS NOT NULL AS tenants,
  to_regclass('public.identity_accounts') IS NOT NULL AS identity_accounts,
  to_regclass('public.shared_checks') IS NOT NULL AS shared_checks,
  EXISTS (
    SELECT 1 FROM pg_constraint k
    WHERE k.conrelid = to_regclass('public.shared_checks') AND k.contype IN ('p', 'u')
      AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) n
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = n ORDER BY 1)
        = ARRAY['check_id', 'source_tenant_id', 'target_tenant_id']
  ) AS shared_checks_share_key,
  to_regprocedure('public.aws_user_tenant_ids()') IS NOT NULL AS aws_user_tenant_ids,
  to_regprocedure('public.aws_is_authenticated()') IS NOT NULL AS aws_is_authenticated,
  to_regprocedure('public.aws_can_write_tenant(uuid)') IS NOT NULL AS aws_can_write_tenant,
  to_regprocedure('public.aws_can_access_tenant(uuid)') IS NOT NULL AS aws_can_access_tenant,
  to_regprocedure('public.aws_is_cross_tenant_reader()') IS NOT NULL AS aws_is_cross_tenant_reader,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops') AS role_checksops,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') AS role_authenticated
`.trim();
export const DEPENDENCY_LABELS = Object.freeze({
  check_stakeholders: 'table public.check_stakeholders',
  check_partner_stakeholder_removals: 'table public.check_partner_stakeholder_removals (SQL 78)',
  check_intake_items: 'table public.check_intake_items',
  tenants: 'table public.tenants',
  identity_accounts: 'table public.identity_accounts',
  shared_checks: 'table public.shared_checks',
  shared_checks_share_key: 'primary key or unique constraint on public.shared_checks (check_id, source_tenant_id, target_tenant_id)',
  aws_user_tenant_ids: 'function public.aws_user_tenant_ids()',
  aws_is_authenticated: 'function public.aws_is_authenticated()',
  aws_can_write_tenant: 'function public.aws_can_write_tenant(uuid)',
  aws_can_access_tenant: 'function public.aws_can_access_tenant(uuid)',
  aws_is_cross_tenant_reader: 'function public.aws_is_cross_tenant_reader()',
  role_checksops: 'role checksops',
  role_authenticated: 'role authenticated',
});

// Production-only reads next to the staging fingerprints (never part of a hash).
// Names are qualified by pg_namespace.nspname and pg_catalog, so they do not
// depend on search_path. A table that does not exist yet contributes no rows.
const STAKEHOLDER_REL_FILTER = "n.nspname = 'public' AND c.relname IN ('check_stakeholders', 'check_partner_stakeholder_removals')";
// Non-owner table ACL entries of both stakeholder tables, with grantor and grant
// option (the staging readers keep neither for the two grantees' own entries).
const STAKEHOLDER_GRANTEE_ACL_SQL = `
SELECT n.nspname || '.' || c.relname AS rel, COALESCE(r.rolname, 'PUBLIC') AS grantee,
  pg_catalog.pg_get_userbyid(a.grantor) AS grantor, a.privilege_type, a.is_grantable
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
WHERE ${STAKEHOLDER_REL_FILTER} AND c.relkind IN ('r', 'p')
  AND a.grantee <> c.relowner
ORDER BY 1, 2, 3, 4
`.trim();
// Column-level UPDATE grants on either table to anyone but the table owner.
const STAKEHOLDER_COLUMN_UPDATE_SQL = `
SELECT n.nspname || '.' || c.relname AS rel, a.attname::text AS column_name, COALESCE(r.rolname, 'PUBLIC') AS grantee, x.is_grantable
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
LEFT JOIN pg_catalog.pg_roles r ON r.oid = x.grantee
WHERE ${STAKEHOLDER_REL_FILTER} AND c.relkind IN ('r', 'p')
  AND x.privilege_type = 'UPDATE' AND x.grantee <> c.relowner
ORDER BY 1, 2, 3
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
// SQL 77 only: the table's owner and ACL text, and the login running the tool.
const SQL77_TABLE_DETAIL_SQL = `
SELECT pg_catalog.pg_get_userbyid(c.relowner) AS table_owner, c.relacl::text AS table_acl,
  current_user::text AS current_user
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'check_stakeholders' AND c.relkind IN ('r', 'p')
`.trim();
// SQL 77 only: every entry of check_stakeholders' table ACL, the owner's own included.
const SQL77_TABLE_ACL_ENTRIES_SQL = `
SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, pg_catalog.pg_get_userbyid(a.grantor) AS grantor, a.privilege_type, a.is_grantable
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public' AND c.relname = 'check_stakeholders' AND c.relkind IN ('r', 'p')
ORDER BY 1, 3, 2
`.trim();
// Whether authenticated is a member of any of the given owner roles (SQL 77: the pin's
// inspected table owner), directly or through other roles. Every pg_auth_members row
// counts, INHERIT FALSE and SET FALSE grants included: membership in the owner can
// still reach the owner's privileges (SET ROLE, or ALTER/DROP as owner). NULL (an
// owner role or authenticated missing, or no owner given) is treated as yes.
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
// The one UPDATE grant production already had before SQL 77 (inspect 2026-10-15,
// SSM ca4ad39d), as an update_entries line. Any other UPDATE, or this one with
// grant option, is drift.
export const PRODUCTION_PREEXISTING_UPDATE_ENTRIES = Object.freeze([`${STAKEHOLDER_GRANT_TABLE} checksops UPDATE`]);
const FOUR_PRIVILEGES = Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
const privilegesAre = (state, granted) => FOUR_PRIVILEGES.every((privilege) => (state?.[privilege] === 'granted') === granted.includes(privilege));
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);

/** Production-only ACL and role detail read next to the staging fingerprint. Never part of the hash. */
export async function readStakeholderGranteeAcl(client) {
  const rows = (await client.query(STAKEHOLDER_GRANTEE_ACL_SQL))?.rows || [];
  const columns = (await client.query(STAKEHOLDER_COLUMN_UPDATE_SQL))?.rows || [];
  const member = (await client.query(AUTHENTICATED_IN_CHECKSOPS_SQL))?.rows?.[0]?.member;
  const line = (row) => `${row.rel} ${row.grantee} ${row.privilege_type}${row.is_grantable === true ? ' with grant option' : ''}`;
  const checksopsRows = rows.filter((row) => row.rel === STAKEHOLDER_GRANT_TABLE && row.grantee === 'checksops');
  return ok({
    // checksops' own entries on check_stakeholders, grantor included: byte-identical across SQL 77.
    checksops_check_stakeholders_entries: checksopsRows.map((row) => `${line(row)} granted by ${row.grantor}`).sort(),
    // checksops could hand a privilege on check_stakeholders on to another role.
    checksops_grant_option: checksopsRows.some((row) => row.is_grantable === true),
    // Every non-owner UPDATE entry on either table.
    update_entries: [...new Set(rows.filter((row) => row.privilege_type === 'UPDATE').map(line))].sort(),
    column_update_entries: columns
      .map((row) => `${row.rel}.${row.column_name} ${row.grantee} UPDATE${row.is_grantable === true ? ' with grant option' : ''}`)
      .sort(),
    // null (unreadable) is treated as a member.
    authenticated_member_of_checksops: member === false ? false : true,
  });
}
/** The owner roles authenticated must not be a member of for SQL 77: the pin's inspected table owner. */
export function sql77OwnerRoles(pin) {
  const owner = pin?.production_inspect?.table_owner;
  return typeof owner === 'string' && owner ? [owner] : [];
}

/**
 * SQL 77's production-only read: readStakeholderGranteeAcl plus check_stakeholders'
 * owner, readable ACL and every ACL entry in plain text (the owner's own included),
 * the login running the tool (current_user), and whether authenticated is a member
 * of the pinned owner role. Never part of the hash.
 */
export async function readSql77ProductionDetail(client, { pin } = {}) {
  const base = await readStakeholderGranteeAcl(client);
  if (!base.ok) return base;
  const ownerRoles = sql77OwnerRoles(pin);
  const table = (await client.query(SQL77_TABLE_DETAIL_SQL))?.rows?.[0] || null;
  const entries = table ? ((await client.query(SQL77_TABLE_ACL_ENTRIES_SQL))?.rows || []) : [];
  const ownerMember = (await client.query(AUTHENTICATED_IN_OWNER_SQL, [ownerRoles]))?.rows?.[0]?.member;
  return ok({
    ...base.details,
    table_owner: table ? table.table_owner : null,
    table_acl: table ? (table.table_acl ?? null) : null,
    table_acl_entries: entries
      .map((row) => `${row.grantee} ${row.privilege_type} granted by ${row.grantor}${row.is_grantable === true ? ' with grant option' : ''}`)
      .sort(),
    current_user: table ? table.current_user : null,
    owner_roles: [...ownerRoles],
    authenticated_member_of_owner: ownerMember === false ? false : true,
  });
}
/**
 * SQL 77 only, before and after: the live table owner is the pin's inspected owner,
 * the tool runs as that owner (so SQL 77's grants are recorded with the same grantor
 * as checksops' existing entries), and authenticated is not a member of that owner.
 */
const sql77OwnerChecks = (state, pin) => {
  const owners = sql77OwnerRoles(pin);
  return [
    ['table_owner_as_inspected', owners.length === 1 && state?.production?.table_owner === owners[0]],
    ['current_user_is_table_owner', owners.length === 1 && typeof state?.production?.current_user === 'string'
      && state.production.current_user === owners[0] && state.production.current_user === state.production.table_owner],
    ['authenticated_not_member_of_owner', state?.production?.authenticated_member_of_owner === false
      && owners.length > 0 && sameList(state?.production?.owner_roles, owners)],
  ];
};
const updateOnlyPreexisting = (state) => sameList(state?.production?.update_entries, PRODUCTION_PREEXISTING_UPDATE_ENTRIES);
/** The production-only checks shared by SQL 77 and SQL 79, before and after. */
const productionGuardChecks = (state) => [
  ['checksops_without_grant_option', state?.production?.checksops_grant_option === false],
  ['authenticated_not_member_of_checksops', state?.production?.authenticated_member_of_checksops === false],
  ['no_column_update_grants', sameList(state?.production?.column_update_entries, [])],
  ['update_only_checksops_without_grant_option', updateOnlyPreexisting(state)],
];

const memberPolicyKeys = MEMBER_STAKEHOLDER_TABLES.flatMap((table) => MEMBER_STAKEHOLDER_NEW_POLICIES[table].map((policy) => `${table}.${policy.name}`));

/**
 * Per migration: its staging pin, the staging reader and lock key, what it
 * depends on, and the staging handler's exact pre/post rules (SQL 77 and SQL 79:
 * production variants, see the header). `productionRead`, when set, adds
 * `state.production` next to the staging state; it is never part of the hash.
 * `preconditionFailures` and `postconditionFailures` return the names of the
 * failed checks (empty = pass).
 */
export const MEMBER_STAKEHOLDER_MIGRATIONS = Object.freeze({
  sql77: Object.freeze({
    key: 'sql77',
    label: 'SQL 77',
    pin_rel: 'ops/deployment-guard/sql77-check-stakeholders-grant-production-apply.json',
    staging_pin: AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT,
    lock_key: 'sql77_check_stakeholders_grant',
    reader: 'readStakeholderGrantState',
    predecessors: Object.freeze([]),
    dependencies: Object.freeze(['check_stakeholders', 'aws_can_write_tenant', 'role_checksops', 'role_authenticated']),
    // The grant changes only check_stakeholders' ACL; the staging reader holds
    // every other entry of that ACL to preserved_acl_sha256.
    scope: Object.freeze({ skip_relations: [], acl_ignored: [STAKEHOLDER_GRANT_TABLE], policies_ignored: [] }),
    statementsAllowed: (text) => SQL77_SINGLE_STATEMENT_RE.test(text),
    productionRead: readSql77ProductionDetail,
    // Printed at the top of --inspect, beside the fingerprint (never hashed).
    inspectSummary: (state) => ({
      table_owner: state?.production?.table_owner ?? null,
      current_user: state?.production?.current_user ?? null,
      owner_roles: state?.production?.owner_roles ?? [],
      authenticated_member_of_owner: state?.production?.authenticated_member_of_owner ?? true,
      table_acl: state?.production?.table_acl ?? null,
      table_acl_entries: state?.production?.table_acl_entries ?? [],
    }),
    alreadyApplied: (state, pin) => state.live_definition_sha256 === pin.intended_replacement_sha256,
    // Production variant of the staging rule (tenant_guard_ok, update_not_granted):
    // checksops already holds all four privileges, its UPDATE without grant option
    // and as the only UPDATE; authenticated holds none. Re-granting S/I/D to
    // checksops is then a no-op; only authenticated gains S/I/D. No grant option
    // for checksops, no authenticated -> checksops membership, no column UPDATE
    // grants, and every other ACL entry exactly as the production inspect read it.
    preconditionFailures: (state, pin) => [
      ['table_present', state.table_present === true],
      ['rls_enabled', state.rls_enabled === true],
      ['write_policy_as_expected', state.write_policy_as_expected === true],
      ['no_other_write_policy', state.other_write_policy_count === 0],
      ['grantee_does_not_bypass_rls', state.grantee_bypasses_rls === false],
      ['tenant_guard_ok', state.tenant_guard_ok === true],
      ['checksops_holds_select_insert_update_delete', privilegesAre(state.privilege_state?.checksops, FOUR_PRIVILEGES)],
      ['authenticated_holds_none', privilegesAre(state.privilege_state?.authenticated, [])],
      ['preserved_acl_as_inspected', typeof pin?.production_inspect?.preserved_acl_sha256 === 'string'
        && state.preserved_acl_sha256 === pin.production_inspect.preserved_acl_sha256],
      ...productionGuardChecks(state),
      ...sql77OwnerChecks(state, pin),
    ].filter(([, passed]) => !passed).map(([name]) => name),
    postconditionFailures: (before, after, pin) => [
      ['intended_state', after.live_definition_sha256 === pin.intended_replacement_sha256],
      ['authenticated_select_insert_delete_only', privilegesAre(after.privilege_state?.authenticated, ['SELECT', 'INSERT', 'DELETE'])],
      ['checksops_unchanged', privilegesAre(after.privilege_state?.checksops, FOUR_PRIVILEGES)
        && JSON.stringify(after.privilege_state?.checksops) === JSON.stringify(before.privilege_state?.checksops)
        && sameList(after.production?.checksops_check_stakeholders_entries, before.production?.checksops_check_stakeholders_entries)],
      ...productionGuardChecks(after),
      ...sql77OwnerChecks(after, pin),
      ['table_owner_unchanged', typeof before.production?.table_owner === 'string'
        && after.production?.table_owner === before.production.table_owner],
      ['other_acl_entries_unchanged', after.preserved_acl_sha256 === before.preserved_acl_sha256],
      ['tenant_guard_ok', after.tenant_guard_ok === true],
    ].filter(([, passed]) => !passed).map(([name]) => name),
  }),
  sql78: Object.freeze({
    key: 'sql78',
    label: 'SQL 78',
    pin_rel: 'ops/deployment-guard/sql78-check-partner-stakeholder-removals-production-apply.json',
    staging_pin: AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS,
    lock_key: 'sql78_check_partner_stakeholder_removals',
    reader: 'readPartnerStakeholderRemovalsState',
    predecessors: Object.freeze(['sql77']),
    dependencies: Object.freeze([
      'check_stakeholders', 'check_intake_items', 'tenants', 'identity_accounts', 'shared_checks', 'shared_checks_share_key',
      'aws_can_access_tenant', 'aws_can_write_tenant', 'aws_is_cross_tenant_reader', 'role_checksops', 'role_authenticated',
    ]),
    // The new table and its indexes, constraints and policies are the migration.
    scope: Object.freeze({ skip_relations: [PARTNER_STAKEHOLDER_REMOVALS_TABLE], acl_ignored: [], policies_ignored: [] }),
    statementsAllowed: (text, executor) => normalizeStatements(text) === executor.SQL78_NORMALIZED_STATEMENTS,
    // The staging handler refuses any existing table, not only the intended one.
    alreadyApplied: (state) => state.table_present === true,
    preconditionFailures: (state) => [
      ['table_absent', state.table_present === false],
      ['prerequisites_ok', state.prerequisites_ok === true],
      ['grantee_does_not_bypass_rls', state.grantee_bypasses_rls === false],
      ['default_acl_as_expected', state.default_acl_as_expected === true],
    ].filter(([, passed]) => !passed).map(([name]) => name),
    postconditionFailures: (before, after, pin) => [
      ['intended_state', after.live_definition_sha256 === pin.intended_replacement_sha256],
      ['tenant_guard_ok', after.tenant_guard_ok === true],
    ].filter(([, passed]) => !passed).map(([name]) => name),
  }),
  sql79: Object.freeze({
    key: 'sql79',
    label: 'SQL 79',
    pin_rel: 'ops/deployment-guard/sql79-member-stakeholder-writes-production-apply.json',
    staging_pin: AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES,
    lock_key: 'sql79_member_stakeholder_writes',
    reader: 'readMemberStakeholderWritesState',
    predecessors: Object.freeze(['sql77', 'sql78']),
    dependencies: Object.freeze([
      'check_stakeholders', 'check_partner_stakeholder_removals', 'check_intake_items',
      'aws_user_tenant_ids', 'aws_is_authenticated', 'role_checksops', 'role_authenticated',
    ]),
    // Only the four member policies are new; everything else stays identical.
    scope: Object.freeze({ skip_relations: [], acl_ignored: [], policies_ignored: memberPolicyKeys }),
    statementsAllowed: (text, executor) => normalizeStatements(text) === executor.SQL79_NORMALIZED_STATEMENTS,
    productionRead: readStakeholderGranteeAcl,
    alreadyApplied: (state, pin) => state.live_definition_sha256 === pin.intended_replacement_sha256
      || Object.values(state.member_policy_states || {}).some((value) => value !== 'absent'),
    // Production variant of the staging rule: the staging reader's update_granted
    // (and so its tenant_guard_ok) is true / false in production because checksops
    // keeps UPDATE on check_stakeholders after SQL 77. Every other part of
    // tenant_guard_ok is checked by name, and that UPDATE must be the only one on
    // either table.
    preconditionFailures: (state) => [
      ['tables_present', state.tables_present === true],
      ['required_roles_present', state.required_roles_present === true],
      ['required_functions_present', state.required_functions_present === true],
      ['functions_executable', state.functions_executable === true],
      ['grantee_does_not_bypass_rls', state.grantee_bypasses_rls === false],
      ['rls_enabled', state.rls_enabled === true],
      ['reviewed_policies_as_expected', state.reviewed_policies_as_expected === true],
      ['no_other_policies', state.other_policy_count === 0],
      ['functions_as_expected', state.functions_as_expected === true],
      ...productionGuardChecks(state),
    ].filter(([, passed]) => !passed).map(([name]) => name),
    postconditionFailures: (before, after, pin) => [
      ['intended_state', after.live_definition_sha256 === pin.intended_replacement_sha256],
      ['member_policies_present', after.member_policies_present === true],
      ['acl_unchanged', after.acl_sha256 === before.acl_sha256],
      ...productionGuardChecks(after),
      ['grantee_does_not_bypass_rls', after.grantee_bypasses_rls === false],
    ].filter(([, passed]) => !passed).map(([name]) => name),
  }),
});

export function memberStakeholderMigration(key) {
  const spec = MEMBER_STAKEHOLDER_MIGRATIONS[key];
  if (!spec) {
    return fail(CODES.INVALID_MANIFEST, `--migration must be one of ${MEMBER_STAKEHOLDER_MIGRATION_ORDER.join(', ')}`, { migration: key ?? null });
  }
  return ok({ spec });
}

export function loadMemberStakeholderProductionPin(key, root = repoRootFrom(import.meta.url)) {
  const spec = MEMBER_STAKEHOLDER_MIGRATIONS[key];
  if (!spec) throw new Error(`unknown migration ${key}`);
  return JSON.parse(fs.readFileSync(path.join(root, spec.pin_rel), 'utf8'));
}

export function loadAllMemberStakeholderProductionPins(root = repoRootFrom(import.meta.url)) {
  return Object.fromEntries(MEMBER_STAKEHOLDER_MIGRATION_ORDER.map((key) => [key, loadMemberStakeholderProductionPin(key, root)]));
}

/** A pin may only name its own migration's file, environment and component. */
function pinBindingFailures(spec, pin) {
  return [
    ['migration', spec.key],
    ['filename', spec.staging_pin.filename],
    ['migration_id', spec.staging_pin.migration_id],
    ['target_environment', 'production'],
    ['target_component', MEMBER_STAKEHOLDER_PRODUCTION_COMPONENT],
    ['deployment_type', MEMBER_STAKEHOLDER_PRODUCTION_DEPLOYMENT_TYPE],
  ].filter(([field, value]) => pin?.[field] !== value).map(([field]) => field);
}

/** Pinned source bytes, read from the repo and checked against the pin and the reviewed statements. */
export async function readPinnedMemberStakeholderSql(root, pin, spec) {
  const binding = pinBindingFailures(spec, pin);
  if (binding.length) {
    return fail(CODES.SQL_COLLISION, `${spec.label} production pin does not name this migration`, { mismatched: binding });
  }
  const file = path.join(root, pin.filename);
  if (!fs.existsSync(file)) return fail(CODES.STALE_PACKAGE, `pinned ${spec.label} file is missing`);
  const text = fs.readFileSync(file, 'utf8');
  const sha = hashSqlDefinition(text);
  if (sha !== pin.source_sha256) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, `${spec.label} bytes differ from the production pin`, {
      source_sha256: sha,
      pinned_source_sha256: pin.source_sha256,
    });
  }
  const executor = await loadStagingSqlExecutor(root);
  if (!spec.statementsAllowed(text, executor)) {
    return fail(CODES.UNRELATED_MUTATION, `${spec.label} is not exactly the reviewed statements`);
  }
  return ok({ text, source_sha256: sha });
}

/** Manifest checks shared by preflight and apply: exact pin plus the production gate. */
export async function evaluateMemberStakeholderProductionApply(input = {}, { root = repoRootFrom(import.meta.url), migration, pin } = {}) {
  const resolved = memberStakeholderMigration(migration);
  if (!resolved.ok) return resolved;
  const { spec } = resolved.details;
  const thePin = pin || loadMemberStakeholderProductionPin(migration, root);
  const sql = await readPinnedMemberStakeholderSql(root, thePin, spec);
  if (!sql.ok) return sql;
  const mismatched = [
    ['target_environment', 'production'],
    ['target_component', MEMBER_STAKEHOLDER_PRODUCTION_COMPONENT],
    ['deployment_type', MEMBER_STAKEHOLDER_PRODUCTION_DEPLOYMENT_TYPE],
    ['filename', thePin.filename],
    ['migration_id', thePin.migration_id],
    ['source_sha256', thePin.source_sha256],
    ['expected_live_definition_sha256', thePin.expected_live_definition_sha256],
    // The live hash from the inspect; checked here so a typo never spends the receipt.
    ['live_definition_sha256', thePin.expected_live_definition_sha256],
  ].filter(([key, value]) => input[key] !== value).map(([key]) => key);
  if (mismatched.length) {
    return fail(CODES.SQL_COLLISION, `${spec.label} production apply is bound to the exact production pin`, { mismatched });
  }
  if (!thePin.staging_acceptance?.reference || input.staging_acceptance?.reference !== thePin.staging_acceptance.reference) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'staging acceptance must be the reference recorded in the production pin', {
      expected: thePin.staging_acceptance?.reference || null,
    });
  }
  const gate = evaluateProductionGate({ ...input, target_environment: 'production' });
  if (!gate.ok) return gate;
  return ok({
    migration: spec.key,
    member_stakeholder_production_apply_allowed: true,
    expected_live_definition_sha256: thePin.expected_live_definition_sha256,
    intended_replacement_sha256: thePin.intended_replacement_sha256,
    predecessors: [...spec.predecessors],
    staging_acceptance: gate.details.staging_acceptance,
  });
}

export const resolveMemberStakeholderDatabaseUrl = resolveLedgerDatabaseUrl;

// --- catalog reads ----------------------------------------------------------

/** The staging reader's state plus, when the spec has one, its production-only read. */
async function readMigrationState(client, spec, executor, pin) {
  const state = await executor[spec.reader](client);
  if (!state.ok || typeof spec.productionRead !== 'function') return state;
  const extra = await spec.productionRead(client, { pin });
  if (!extra.ok) return extra;
  return ok({ ...state.details, production: extra.details });
}

/** Runs `fn` under a savepoint so a failing read leaves the transaction usable. */
async function guardedRead(client, name, fn) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return fail(CODES.SQL_COLLISION, String(error?.message || error).slice(0, 300));
  }
}

export async function readMemberStakeholderDependencies(client) {
  const row = (await client.query(DEPENDENCIES_SQL))?.rows?.[0] || {};
  return Object.fromEntries(Object.keys(DEPENDENCY_LABELS).map((name) => [name, row[name] === true]));
}

const missingFor = (spec, dependencies) => spec.dependencies.filter((name) => dependencies[name] !== true);

/** A predecessor is applied when its staging reader reads its pin's intended state. */
async function readPredecessors(client, spec, executor, dependencies, pins) {
  const out = {};
  for (const key of spec.predecessors) {
    const predecessor = MEMBER_STAKEHOLDER_MIGRATIONS[key];
    const pin = pins[key];
    const missing = predecessor.key === 'sql78'
      // Applied SQL 78 means the table exists; the reader itself never raises on it.
      ? missingFor(predecessor, dependencies).filter((name) => name !== 'check_partner_stakeholder_removals')
      : missingFor(predecessor, dependencies);
    if (missing.length) {
      out[key] = { applied: false, missing_dependencies: missing.map((name) => DEPENDENCY_LABELS[name]) };
      continue;
    }
    const state = await guardedRead(client, `pred_${key}`, () => executor[predecessor.reader](client));
    if (!state.ok) {
      out[key] = { applied: false, error: state.message };
      continue;
    }
    out[key] = {
      applied: state.details.live_definition_sha256 === pin?.intended_replacement_sha256,
      live_definition_sha256: state.details.live_definition_sha256,
      intended_replacement_sha256: pin?.intended_replacement_sha256 || null,
    };
  }
  return out;
}

const SNAPSHOT_QUERIES = Object.freeze({
  relations: `
SELECT c.oid::regclass::text AS rel, c.relkind::text AS kind, pg_get_userbyid(c.relowner) AS owner,
  c.relrowsecurity AS rls, c.relforcerowsecurity AS rls_forced,
  CASE WHEN c.oid::regclass::text = ANY($2::text[]) THEN NULL ELSE c.relacl::text END AS acl
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND NOT (c.oid::regclass::text = ANY($1::text[]))
  AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = c.oid AND i.indrelid::regclass::text = ANY($1::text[]))
ORDER BY 1, 2`,
  columns: `
SELECT a.attrelid::regclass::text AS rel, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type,
  a.attnotnull, a.attacl::text AS acl, pg_get_expr(d.adbin, d.adrelid) AS default_expr
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c')
  AND a.attnum > 0 AND NOT a.attisdropped
  AND NOT (a.attrelid::regclass::text = ANY($1::text[]))
ORDER BY 1, 2`,
  constraints: `
SELECT con.conrelid::regclass::text AS rel, con.conname, con.contype::text AS type, pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
WHERE con.connamespace = 'public'::regnamespace AND NOT (con.conrelid::regclass::text = ANY($1::text[]))
ORDER BY 1, 2`,
  policies: `
SELECT pol.polrelid::regclass::text AS rel, pol.polname, pol.polcmd::text AS cmd, pol.polpermissive AS permissive,
  ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END FROM unnest(pol.polroles) r ORDER BY 1)::text[] AS roles,
  pg_get_expr(pol.polqual, pol.polrelid) AS qual, pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check
FROM pg_policy pol
WHERE NOT (pol.polrelid::regclass::text = ANY($1::text[]))
  AND NOT ((pol.polrelid::regclass::text || '.' || pol.polname) = ANY($2::text[]))
ORDER BY 1, 2`,
  functions: `
SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prokind::text AS kind,
  md5(p.prosrc) AS src_md5, p.prosecdef, p.provolatile::text AS volatile, p.proconfig::text AS config, p.proacl::text AS acl
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) x WHERE to_regprocedure(x) = p.oid)
ORDER BY 1`,
  triggers: `
SELECT t.tgrelid::regclass::text AS rel, t.tgname, t.tgenabled::text AS enabled, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
ORDER BY 1, 2`,
  roles: `
SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolinherit, r.rolcanlogin, r.rolcreaterole,
  ARRAY(SELECT m.roleid::regrole::text || CASE WHEN m.admin_option THEN ' admin' ELSE '' END
    FROM pg_auth_members m WHERE m.member = r.oid ORDER BY 1)::text[] AS member_of
FROM pg_roles r
ORDER BY 1`,
  default_privileges: `
SELECT pg_get_userbyid(d.defaclrole) AS role, d.defaclnamespace::regnamespace::text AS schema,
  d.defaclobjtype::text AS type, d.defaclacl::text AS acl
FROM pg_default_acl d
ORDER BY 1, 2, 3`,
  schema: `
SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner, n.nspacl::text AS acl
FROM pg_namespace n
WHERE n.nspname = 'public'`,
});

/**
 * Hash of everything in schema public (and the roles) that the migration must
 * not touch. `scope.skip_relations` are the migration's own new relations,
 * `scope.acl_ignored` relations whose table ACL the migration changes, and
 * `scope.policies_ignored` "table.policy" keys of the policies it adds, and
 * `scope.functions_ignored` signatures of the functions it replaces (SQL 80).
 */
export async function readUnrelatedCatalogSnapshot(client, scope = {}) {
  await client.query(PG_CATALOG_SEARCH_PATH_SQL);
  const skip = [...(scope.skip_relations || [])];
  const aclIgnored = [...(scope.acl_ignored || [])];
  const policiesIgnored = [...(scope.policies_ignored || [])];
  const functionsIgnored = [...(scope.functions_ignored || [])];
  const params = {
    relations: [skip, aclIgnored],
    columns: [skip],
    constraints: [skip],
    policies: [skip, policiesIgnored],
    functions: [functionsIgnored],
  };
  const categories = {};
  const counts = {};
  for (const [name, sql] of Object.entries(SNAPSHOT_QUERIES)) {
    const rows = (await client.query(sql.trim(), params[name] || []))?.rows || [];
    categories[name] = hashSqlDefinition(rows.map((row) => JSON.stringify(row)).join('\n'));
    counts[name] = rows.length;
  }
  return {
    categories,
    counts,
    sha256: hashSqlDefinition(JSON.stringify(categories)),
  };
}

const changedCategories = (before, after) => Object.keys(before.categories).filter((name) => before.categories[name] !== after.categories[name]);

// --- inspect ----------------------------------------------------------------

export async function inspectMemberStakeholderProduction({ connect, migration, pin, pins, root = repoRootFrom(import.meta.url) }) {
  const resolved = memberStakeholderMigration(migration);
  if (!resolved.ok) return resolved;
  const { spec } = resolved.details;
  const allPins = { ...loadAllMemberStakeholderProductionPins(root), ...(pins || {}) };
  const thePin = pin || allPins[migration];
  allPins[migration] = thePin;
  const source = await readPinnedMemberStakeholderSql(root, thePin, spec);
  const executor = await loadStagingSqlExecutor(root);
  const client = await connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const dependencies = await readMemberStakeholderDependencies(client);
    const missing = missingFor(spec, dependencies);
    const predecessors = await readPredecessors(client, spec, executor, dependencies, allPins);
    const predecessorsApplied = Object.values(predecessors).every((row) => row.applied === true);
    const state = missing.length
      ? fail(CODES.DEPLOYMENT_COLLISION, `${spec.label} dependencies are missing`, { missing_dependencies: missing.map((name) => DEPENDENCY_LABELS[name]) })
      : await guardedRead(client, `state_${spec.key}`, () => readMigrationState(client, spec, executor, thePin));
    const details = state.ok ? state.details : null;
    const live = details?.live_definition_sha256 || null;
    const preconditionFailures = details ? spec.preconditionFailures(details, thePin) : ['state_unreadable'];
    return ok({
      read_only: true,
      migration: spec.key,
      filename: thePin.filename,
      source_ok: source.ok,
      ...(source.ok ? {} : { source_error: { code: source.code, message: source.message } }),
      pin_execute: thePin.execute === true,
      dependencies: Object.fromEntries(spec.dependencies.map((name) => [name, dependencies[name] === true])),
      missing_dependencies: missing.map((name) => DEPENDENCY_LABELS[name]),
      predecessors,
      predecessors_applied: predecessorsApplied,
      ...(details && typeof spec.inspectSummary === 'function' ? spec.inspectSummary(details) : {}),
      ...(details ? { state: details } : { state_error: { code: state.code, message: state.message, details: state.details } }),
      live_definition_sha256: live,
      expected_live_definition_sha256: thePin.expected_live_definition_sha256,
      intended_replacement_sha256: thePin.intended_replacement_sha256,
      live_matches_expected: live !== null && live === thePin.expected_live_definition_sha256,
      already_applied: live !== null && live === thePin.intended_replacement_sha256,
      precondition_failures: preconditionFailures,
      apply_preconditions_met: source.ok
        && missing.length === 0
        && predecessorsApplied
        && details !== null
        && live === thePin.expected_live_definition_sha256
        && !spec.alreadyApplied(details, thePin)
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

const consumedFileFor = (root, ctx) => ctx.consumedPath || path.join(root, '.deployment-guard', 'sql-member-stakeholder-production-consumed.json');

/** Cheap checks that must pass before the single-use guard receipt is spent. */
export async function precheckMemberStakeholderProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const resolved = memberStakeholderMigration(ctx.migration);
  if (!resolved.ok) return resolved;
  const { spec } = resolved.details;
  const pin = ctx.pin || loadMemberStakeholderProductionPin(ctx.migration, root);
  const evaluation = await evaluateMemberStakeholderProductionApply(input, { root, migration: ctx.migration, pin });
  if (!evaluation.ok) return evaluation;
  if (pin.execute !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, `${spec.label} production execute is not authorized by this pin`);
  }
  if (typeof pin.authorization_phrase !== 'string' || !pin.authorization_phrase || input.authorization_phrase !== pin.authorization_phrase) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, `${spec.label} production apply requires the exact authorization phrase`);
  }
  if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
    return fail(CODES.INVALID_MANIFEST, `${spec.label} production apply requires a single-use id`);
  }
  if (loadConsumed(consumedFileFor(root, ctx)).consumed.includes(input.one_use_id)) {
    return fail(CODES.RECEIPT_REUSED, 'one_use_id has already been consumed; replay is forbidden', { one_use_id: input.one_use_id });
  }
  return evaluation;
}

export async function executeMemberStakeholderProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const resolved = memberStakeholderMigration(ctx.migration);
  if (!resolved.ok) return resolved;
  const { spec } = resolved.details;
  const allPins = { ...loadAllMemberStakeholderProductionPins(root), ...(ctx.pins || {}) };
  const pin = ctx.pin || allPins[spec.key];
  allPins[spec.key] = pin;
  const evaluation = await precheckMemberStakeholderProductionApply(input, { ...ctx, root, pin });
  if (!evaluation.ok) return evaluation;
  const consumedFile = consumedFileFor(root, ctx);
  const sql = await readPinnedMemberStakeholderSql(root, pin, spec);
  if (!sql.ok) return sql;
  if (typeof ctx.connect !== 'function') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, `${spec.label} production apply requires a database connection factory`);
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
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [SERIES_LOCK_KEY]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [spec.lock_key]);
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);

    const dependencies = await readMemberStakeholderDependencies(client);
    const missing = missingFor(spec, dependencies);
    if (missing.length) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, `${spec.label} dependencies are missing`, {
        missing_dependencies: missing.map((name) => DEPENDENCY_LABELS[name]),
      }));
    }
    const before = await readMigrationState(client, spec, executor, pin);
    if (!before.ok) return rollback(before);
    if (spec.alreadyApplied(before.details, pin)) {
      return rollback(fail(CODES.UNRELATED_MUTATION, `${spec.label} is already in place; refuse re-apply`, {
        live_definition_sha256: before.details.live_definition_sha256,
        matches_intended: before.details.live_definition_sha256 === pin.intended_replacement_sha256,
      }));
    }
    // Checked for a pending apply only: a later migration changes an earlier one's fingerprint
    // (SQL 79 adds policies to the SQL 78 table).
    const predecessors = await readPredecessors(client, spec, executor, dependencies, allPins);
    const pending = Object.entries(predecessors).filter(([, row]) => row.applied !== true).map(([key]) => key);
    if (pending.length) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, `${spec.label} must wait until ${pending.join(' and ')} is applied in production`, { predecessors }));
    }
    const preFailures = spec.preconditionFailures(before.details, pin);
    if (preFailures.length) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, `${spec.label} pre-apply conditions are not met`, { failed: preFailures }));
    }
    if (before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== input.live_definition_sha256) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, `${spec.label} live state is not the pinned pre-apply state`, {
        live_definition_sha256: before.details.live_definition_sha256,
        expected_live_definition_sha256: pin.expected_live_definition_sha256,
      }));
    }
    const snapshotBefore = await readUnrelatedCatalogSnapshot(client, spec.scope);

    await client.query(sql.details.text);

    const after = await readMigrationState(client, spec, executor, pin);
    if (!after.ok) return rollback(after);
    const snapshotAfter = await readUnrelatedCatalogSnapshot(client, spec.scope);
    const postFailures = spec.postconditionFailures(before.details, after.details, pin);
    const changed = changedCategories(snapshotBefore, snapshotAfter);
    if (postFailures.length || changed.length) {
      return rollback(fail(CODES.UNRELATED_MUTATION, `${spec.label} did not land exactly on the reviewed state, or changed something else`, {
        failed: postFailures,
        unrelated_changed: changed,
        after_hash: after.details.live_definition_sha256,
      }));
    }

    commitSent = true;
    await client.query('COMMIT');
    inTx = false;
    committed = true;
    return ok({
      receipt: {
        migration: spec.key,
        workstream: input.workstream_id,
        commit: input.commit,
        sql_file: pin.filename,
        before_hash: before.details.live_definition_sha256,
        after_hash: after.details.live_definition_sha256,
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
      return fail(CODES.SQL_COLLISION, `${spec.label} production COMMIT outcome is unknown; re-run --inspect before anything else`, {
        message: String(error?.message || error).slice(0, 300),
      });
    }
    return rollback(fail(CODES.SQL_COLLISION, `${spec.label} production apply failed and was rolled back`, {
      message: String(error?.message || error).slice(0, 300),
    }));
  } finally {
    await client.end().catch(() => {});
    // Recorded after the transaction so a registry write error is never reported as a rollback.
    if (committed) {
      try {
        consumeOneUse(consumedFile, input.one_use_id);
      } catch (error) {
        process.stderr.write(`${spec.label} apply COMMITTED; one_use_id ${input.one_use_id} could not be recorded: ${String(error?.message || error).slice(0, 200)}\n`);
      }
    }
  }
}

export { createProductionDatabaseConnect };
