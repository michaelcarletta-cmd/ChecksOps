/**
 * Production apply of SQL 84 (aws/workflows/sql/84_mortgage_return_to_queue.sql:
 * Return to Queue, the request audit table and SQL 84's per-check unique gate), SQL 85
 * (aws/workflows/sql/85_mortgage_compensation_adjust.sql: compensation Adjust, its
 * columns, indexes and action CHECK, dropping the Cursor SQL 49 five-argument body)
 * and SQL 86 (aws/workflows/sql/86_mortgage_compensation_owner_only.sql: the SQL 47
 * compensation helper and reconciliation become platform owner only, and EXECUTE on
 * earn_mortgage_agent_compensation(uuid) is left to its owner). SQL 87
 * (aws/workflows/sql/87_resolve_check_case_tenant_scope.sql: resolve_check_case scoped
 * to its tenant, EXECUTE left to its owner, the two case trigger functions) has SQL
 * 86's shape and is registered here too, and so is SQL 88
 * (aws/workflows/sql/88_claim_id_assign_case_tenant_scope.sql: tg_claim_id_assign_case
 * scoped to the row's tenant, EXECUTE left to its owner), whose inspect also counts the
 * existing cross-tenant links (counts only).
 *
 * Shared by the three official tools (sql84-mortgage-return-to-queue-production-apply.mjs,
 * sql85-mortgage-compensation-adjust-production-apply.mjs,
 * sql86-mortgage-compensation-owner-only-production-apply.mjs), each with its own pin, in
 * the shape of the SQL 82 / 83 tools (homeowner-sql-production-apply.mjs). The
 * fingerprint, the reviewed-text parse, the reconstructed pg_get_functiondef and the
 * replace-safely rules are the staging guarded executor's own
 * (aws/write-path/guarded-sql-executor/index.mjs: readMortgageState,
 * mortgageSqlIsReviewed, mortgageReviewedFunctiondefs, mortgagePreconditionFailures,
 * mortgagePostconditionFailures, readMortgageSchemaSnapshot), loaded from an isolated
 * copy of that module.
 *
 * No production pre-state is code-derived: each pin's expected_live_definition_sha256
 * is null until a read-only --inspect has been recorded in a reviewed pin change, and
 * evaluate and apply refuse until then. Production adds to the staging rules: the
 * connected login is the pinned owner (which owns every existing function and table the
 * file changes, or will own the new ones), authenticated is not a member of that
 * owner, and after the apply each function whose ACL the file sets has exactly the
 * pinned aclitems.
 *
 * Apply is one transaction (lock_timeout 5s, advisory locks) and rolls back unless
 * every postcondition holds and everything else in schema public (and the functions
 * in schema auth) is unchanged. Runs only on a host with private reachability into
 * the production VPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok, sqlGuardErrorMessage } from './errors.mjs';
import { evaluateProductionGate } from './production.mjs';
import { hashSqlDefinition } from './sql-apply.mjs';
import {
  AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE,
  AUTHORIZED_SQL85_MORTGAGE_COMPENSATION_ADJUST,
  AUTHORIZED_SQL86_MORTGAGE_COMPENSATION_OWNER_ONLY,
  AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE,
  AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE,
  MORTGAGE_MIGRATIONS,
} from './sql-executor-auth.mjs';
import {
  createProductionDatabaseConnect,
  readUnrelatedCatalogSnapshot,
  resolveMemberStakeholderDatabaseUrl,
} from './sql-member-stakeholder-production-apply.mjs';
import { loadStagingSqlExecutor } from './staging-sql-executor-module.mjs';
import { repoRootFrom } from './paths.mjs';

export const MORTGAGE_PRODUCTION_COMPONENT = 'production-sql';
export const MORTGAGE_PRODUCTION_DEPLOYMENT_TYPE = 'sql-apply';

/** One entry per tool; the staging pin supplies the file, ids and the code-derived post-state. */
export const MORTGAGE_PRODUCTION = Object.freeze({
  sql84: Object.freeze({
    key: 'sql84',
    label: 'SQL 84',
    pin_rel: 'ops/deployment-guard/sql84-mortgage-return-to-queue-production-apply.json',
    staging_pin: AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE,
    allowed_key: 'sql84_production_apply_allowed',
    // The staging handler's lock key plus a production-only one.
    lock_keys: Object.freeze(['sql84_mortgage_objects', 'sql84_mortgage_objects_production']),
    consumed_file: 'sql84-mortgage-production-consumed.json',
    script: 'sql84-mortgage-return-to-queue-production-apply',
  }),
  sql85: Object.freeze({
    key: 'sql85',
    label: 'SQL 85',
    pin_rel: 'ops/deployment-guard/sql85-mortgage-compensation-adjust-production-apply.json',
    staging_pin: AUTHORIZED_SQL85_MORTGAGE_COMPENSATION_ADJUST,
    allowed_key: 'sql85_production_apply_allowed',
    lock_keys: Object.freeze(['sql85_mortgage_objects', 'sql85_mortgage_objects_production']),
    consumed_file: 'sql85-mortgage-production-consumed.json',
    script: 'sql85-mortgage-compensation-adjust-production-apply',
  }),
  sql86: Object.freeze({
    key: 'sql86',
    label: 'SQL 86',
    pin_rel: 'ops/deployment-guard/sql86-mortgage-compensation-owner-only-production-apply.json',
    staging_pin: AUTHORIZED_SQL86_MORTGAGE_COMPENSATION_OWNER_ONLY,
    allowed_key: 'sql86_production_apply_allowed',
    lock_keys: Object.freeze(['sql86_mortgage_objects', 'sql86_mortgage_objects_production']),
    consumed_file: 'sql86-mortgage-production-consumed.json',
    script: 'sql86-mortgage-compensation-owner-only-production-apply',
    // The definitions the inspect prints in full (SQL 86's two replaced functions).
    print_definitions: Object.freeze([
      'public.aws_can_admin_mortgage_agent_compensation()',
      'public.mortgage_agent_compensation_reconciliation(text)',
    ]),
  }),
  // SQL 87 (resolve_check_case tenant scope; not Mortgage Ops) has SQL 86's shape and
  // shares this tool. The inspect reads no row data, so it prints no PII or row ids.
  sql87: Object.freeze({
    key: 'sql87',
    label: 'SQL 87',
    pin_rel: 'ops/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.json',
    staging_pin: AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE,
    allowed_key: 'sql87_production_apply_allowed',
    // The staging handler's lock key (`${key}_mortgage_objects`) plus a production-only one.
    lock_keys: Object.freeze(['sql87_mortgage_objects', 'sql87_check_case_objects_production']),
    consumed_file: 'sql87-check-case-production-consumed.json',
    script: 'sql87-resolve-check-case-tenant-scope-production-apply',
    print_definitions: Object.freeze(['public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)']),
  }),
  // SQL 88 (tg_claim_id_assign_case tenant scope) has SQL 87's shape. Its inspect reads
  // aggregate counts of existing cross-tenant links only: no PII and no row ids.
  sql88: Object.freeze({
    key: 'sql88',
    label: 'SQL 88',
    pin_rel: 'ops/deployment-guard/sql88-claim-id-assign-case-tenant-scope-production-apply.json',
    staging_pin: AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE,
    allowed_key: 'sql88_production_apply_allowed',
    lock_keys: Object.freeze(['sql88_mortgage_objects', 'sql88_claim_case_objects_production']),
    consumed_file: 'sql88-claim-case-production-consumed.json',
    script: 'sql88-claim-id-assign-case-tenant-scope-production-apply',
    print_definitions: Object.freeze(['public.tg_claim_id_assign_case()']),
  }),
});

const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PG_CATALOG_SEARCH_PATH_SQL = "SELECT set_config('search_path', 'pg_catalog', false)";

// Whether authenticated is a member of the pinned owner role, directly or through other
// roles; every pg_auth_members row counts (INHERIT FALSE and SET FALSE included). NULL
// (owner or authenticated missing, or no owner given) is treated as yes.
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
// Every non-owner function ACL entry with its grantor; a NULL proacl reads as the default (PUBLIC EXECUTE).
const FUNCTION_ACL_ENTRIES_SQL = `
SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, pg_catalog.pg_get_userbyid(a.grantor) AS grantor, a.privilege_type, a.is_grantable
FROM pg_catalog.pg_proc p
CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
WHERE p.oid = pg_catalog.to_regprocedure($1) AND a.grantee <> p.proowner
ORDER BY 1, 3, 2
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
/** The aclitems of a proacl text, sorted ('{a=X/a,b=X/a}' -> ['a=X/a', 'b=X/a']). */
const aclItems = (text) => (typeof text === 'string' && /^\{.*\}$/.test(text) ? text.slice(1, -1).split(',').filter(Boolean).sort() : null);

export function mortgageProductionTool(key) {
  const tool = MORTGAGE_PRODUCTION[key];
  if (!tool) throw new Error(`unknown mortgage production migration ${key}`);
  return tool;
}

/** The pinned owner of the objects (the login that must run the apply). */
export function mortgageObjectOwner(pin) {
  const owner = pin?.intended_post_state?.function_owner;
  return typeof owner === 'string' && owner ? owner : null;
}

/** The functions whose ACL the file sets: the targets it grants, and SQL 86's earn function. */
export const mortgageAclSetFunctions = (key) => MORTGAGE_MIGRATIONS[key].functions.filter((fn) => Array.isArray(fn.grantees));

/**
 * `{owner=X/owner,checksops=X/owner,authenticated=X/owner}` (or `{owner=X/owner}` for
 * SQL 86's earn function): what the function's proacl must read after the apply, in
 * the order a fresh apply leaves it. Compared as a set of aclitems.
 */
export function mortgageIntendedFunctionAcl(pin, fn) {
  const owner = mortgageObjectOwner(pin);
  if (!owner || !Array.isArray(fn?.grantees)) return null;
  const order = ['checksops', 'authenticated'].filter((role) => fn.grantees.includes(role));
  return `{${[`${owner}=X/${owner}`, ...order.map((g) => `${g}=X/${owner}`)].join(',')}}`;
}

/** The staging reader's state plus `production` (grantors, owner membership), which is never hashed. */
async function readState(client, executor, key, pin) {
  const state = await executor.readMortgageState(client, key);
  if (!state.ok) return state;
  const owner = mortgageObjectOwner(pin);
  const ownerMember = (await client.query(AUTHENTICATED_IN_OWNER_SQL, [owner ? [owner] : []]))?.rows?.[0]?.member;
  const grantors = {};
  for (const fn of MORTGAGE_MIGRATIONS[key].functions) {
    if (!state.details.functions[fn.key]?.exists) {
      grantors[fn.key] = [];
      continue;
    }
    const rows = (await client.query(FUNCTION_ACL_ENTRIES_SQL, [fn.identity]))?.rows || [];
    grantors[fn.key] = rows.map((row) => `${entryLine(row)} granted by ${row.grantor}`).sort();
  }
  return ok({
    ...state.details,
    production: {
      owner_roles: owner ? [owner] : [],
      authenticated_member_of_owner: ownerMember === false ? false : true,
      function_acl_entries_with_grantor: grantors,
    },
  });
}

async function readAuthFunctions(client) {
  const rows = (await client.query(AUTH_FUNCTIONS_SQL))?.rows || [];
  return hashSqlDefinition(rows.map((row) => JSON.stringify(row)).join('\n'));
}

/**
 * Everything the migration must not touch: schema public (roles, default privileges and
 * the schema ACL included) except its own new relations, the tables it alters and its
 * functions, plus the staging executor's finer snapshot (which re-reads the altered
 * tables except the reviewed column, index and constraint changes) and schema auth's
 * functions.
 */
export async function readMortgageUnrelatedSnapshot(client, key, executor) {
  const spec = MORTGAGE_MIGRATIONS[key];
  const scope = executor.mortgageSnapshotScope(key);
  const snapshot = await readUnrelatedCatalogSnapshot(client, {
    skip_relations: [...spec.new_relations, ...spec.altered_tables],
    functions_ignored: scope.functions_ignored,
  });
  const fine = await executor.readMortgageSchemaSnapshot(client, key);
  const authFunctions = await readAuthFunctions(client);
  const categories = {
    ...snapshot.categories,
    ...Object.fromEntries(Object.entries(fine).map(([name, value]) => [`fine_${name}`, value])),
    auth_functions: authFunctions,
  };
  return {
    categories,
    counts: snapshot.counts,
    sha256: hashSqlDefinition(JSON.stringify(categories)),
  };
}

/** The tables whose owner must be the pinned login for the file to run. */
function ownedTables(key, state) {
  if (key === 'sql84') {
    return [
      ...(state?.objects?.audit_table?.present ? [state.objects.audit_table.owner ?? null] : []),
      ...(state?.objects?.per_check_unique_present === true ? [] : [state?.tables?.check_billing_events?.owner ?? null]),
    ];
  }
  if (key === 'sql85') {
    return ['mortgage_agent_compensation_entries', 'mortgage_agent_compensation_batches'].map((table) => state?.tables?.[table]?.owner ?? null);
  }
  return [];
}

/** Production-only checks that hold before and after: the login, its ownership and authenticated's membership. */
const productionChecks = (key, state, pin) => {
  const owner = mortgageObjectOwner(pin);
  return [
    ['login_is_pinned_owner', owner !== null && state?.current_user === owner && state?.session_user === owner],
    ['objects_owned_by_pinned_owner', owner !== null
      && MORTGAGE_MIGRATIONS[key].functions.every((fn) => state?.functions?.[fn.key]?.exists !== true || state.functions[fn.key].owner === owner)
      && ownedTables(key, state).every((tableOwner) => tableOwner === owner)],
    ['authenticated_not_member_of_owner', state?.production?.authenticated_member_of_owner === false
      && sameList(state?.production?.owner_roles, owner ? [owner] : null)],
  ];
};

/** Production pre-apply rule: the executor's replace-safely rules plus the production checks. */
export function mortgageProductionPreconditionFailures(key, state, pin, executor) {
  return [
    ...executor.mortgagePreconditionFailures(state, key),
    ...failed(productionChecks(key, state, pin)),
  ];
}

/**
 * Production post-apply rule. `reviewed` maps each identity to the sha256 of the
 * pg_get_functiondef reconstructed from the pinned file's own bodies, so the live
 * definitions are compared with the reviewed text, not only with constants; `before`
 * is the pre-apply state.
 */
export function mortgageProductionPostconditionFailures(key, after, pin, reviewed, executor, before) {
  return [
    ...executor.mortgagePostconditionFailures(after, key, reviewed, pin?.intended_replacement_sha256, before),
    ...failed(productionChecks(key, after, pin)),
    ...failed(mortgageAclSetFunctions(key).flatMap((fn) => {
      const intended = mortgageIntendedFunctionAcl(pin, fn);
      const row = after?.functions?.[fn.key];
      return [
        [`public_execute_revoked:${fn.key}`, !(row?.acl_entries || ['PUBLIC']).some((line) => line.startsWith('PUBLIC '))],
        [`function_acl_as_intended:${fn.key}`, intended !== null && sameList(aclItems(row?.proacl), aclItems(intended))
          && pin?.intended_post_state?.function_acl?.[fn.key] === intended],
      ];
    })),
  ];
}

/**
 * A pin authorizes execution only with an owner approval recorded in `authorization`:
 * the SQL 77-83 pins' "Owner approved …" / "owner-approved …" convention. "pending",
 * an empty or a missing value refuses.
 */
export const OWNER_APPROVED_AUTHORIZATION_RE = /^owner[- ]approved\b/i;
export function mortgageAuthorizationApproved(pin) {
  const value = typeof pin?.authorization === 'string' ? pin.authorization.trim() : '';
  return value !== '' && value.toLowerCase() !== 'pending' && OWNER_APPROVED_AUTHORIZATION_RE.test(value);
}

const alreadyApplied = (state, pin) => state.live_definition_sha256 === pin.intended_replacement_sha256;

export function loadMortgageProductionPin(key, root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, mortgageProductionTool(key).pin_rel), 'utf8'));
}

/** A pin may only name its migration's file, functions, environment and component. */
function pinBindingFailures(key, pin) {
  const staging = mortgageProductionTool(key).staging_pin;
  return [
    ['migration', key],
    ['filename', staging.filename],
    ['migration_id', staging.migration_id],
    ['source_sha256', staging.source_sha256],
    ['staging_pin_commit', staging.commit],
    ['intended_replacement_sha256', staging.intended_replacement_sha256],
    ['target_environment', 'production'],
    ['target_component', MORTGAGE_PRODUCTION_COMPONENT],
    ['deployment_type', MORTGAGE_PRODUCTION_DEPLOYMENT_TYPE],
  ].filter(([field, value]) => pin?.[field] !== value).map(([field]) => field)
    .concat(sameList(pin?.function_identities, [...staging.function_identities]) ? [] : ['function_identities']);
}

/**
 * Pinned source bytes, checked against the pin and, through the staging
 * executor's parse, against the reviewed statements and functiondefs.
 */
export async function readPinnedMortgageSql(key, root, pin) {
  const { label } = mortgageProductionTool(key);
  const binding = pinBindingFailures(key, pin);
  if (binding.length) {
    return fail(CODES.SQL_COLLISION, `${label} production pin does not name this migration`, { mismatched: binding });
  }
  const file = path.join(root, pin.filename);
  if (!fs.existsSync(file)) return fail(CODES.STALE_PACKAGE, `pinned ${label} file is missing`);
  const text = fs.readFileSync(file, 'utf8');
  const sha = hashSqlDefinition(text);
  if (sha !== pin.source_sha256) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, `${label} bytes differ from the production pin`, {
      source_sha256: sha,
      pinned_source_sha256: pin.source_sha256,
    });
  }
  const executor = await loadStagingSqlExecutor(root);
  if (!executor.mortgageSqlIsReviewed(key, text)) {
    return fail(CODES.UNRELATED_MUTATION, `${label} is not exactly the reviewed statements`);
  }
  const defs = executor.mortgageReviewedFunctiondefs(key, text);
  const reviewed = Object.fromEntries(Object.entries(defs).map(([identity, def]) => [identity, hashSqlDefinition(def)]));
  return ok({ text, source_sha256: sha, reviewed_definition_sha256: reviewed });
}

/** Manifest checks shared by preflight and apply: exact pin, a recorded pre-state and the production gate. */
export async function evaluateMortgageProductionApply(key, input = {}, { root = repoRootFrom(import.meta.url), pin } = {}) {
  const tool = mortgageProductionTool(key);
  const thePin = pin || loadMortgageProductionPin(key, root);
  const sql = await readPinnedMortgageSql(key, root, thePin);
  if (!sql.ok) return sql;
  if (!SHA256_RE.test(String(thePin.expected_live_definition_sha256 || ''))) {
    return fail(CODES.SQL_COLLISION, `${tool.label} production pin has no recorded pre-apply live definition hash yet; run --inspect and record it in a reviewed pin change`);
  }
  if (!mortgageAuthorizationApproved(thePin)) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, `${tool.label} production pin authorization is not an owner approval (it is ${JSON.stringify(String(thePin.authorization ?? null).slice(0, 40))}); a reviewed pin change must record it`);
  }
  const mismatched = [
    ['target_environment', 'production'],
    ['target_component', MORTGAGE_PRODUCTION_COMPONENT],
    ['deployment_type', MORTGAGE_PRODUCTION_DEPLOYMENT_TYPE],
    ['filename', thePin.filename],
    ['migration_id', thePin.migration_id],
    ['source_sha256', thePin.source_sha256],
    ['expected_live_definition_sha256', thePin.expected_live_definition_sha256],
    ['intended_replacement_sha256', thePin.intended_replacement_sha256],
    // The live hash from the inspect; checked here so a typo never spends the receipt.
    ['live_definition_sha256', thePin.expected_live_definition_sha256],
  ].filter(([field, value]) => input[field] !== value).map(([field]) => field);
  if (mismatched.length) {
    return fail(CODES.SQL_COLLISION, `${tool.label} production apply is bound to the exact production pin`, { mismatched });
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
    migration: key,
    [tool.allowed_key]: true,
    expected_live_definition_sha256: thePin.expected_live_definition_sha256,
    intended_replacement_sha256: thePin.intended_replacement_sha256,
    staging_acceptance: gate.details.staging_acceptance,
  });
}

export const resolveMortgageDatabaseUrl = resolveMemberStakeholderDatabaseUrl;

// --- inspect ----------------------------------------------------------------

/** The production report of each migration's own objects (owner names, definitions, predicates and check ids included). */
function migrationReport(key, details) {
  const objects = details.objects || {};
  const report = details.report || {};
  if (key === 'sql84') {
    return {
      audit_table: objects.audit_table,
      per_check_unique_present: objects.per_check_unique_present === true,
      billing_per_check_indexes: report.billing_per_check_indexes || [],
      fallback_index_name_taken: report.fallback_index_name_taken === true,
      billing_duplicates: report.billing_duplicates || null,
    };
  }
  if (key === 'sql85') {
    return {
      added_columns: objects.columns || {},
      indexes: objects.indexes || {},
      constraints: objects.constraints || {},
      batch_actions_outside_check: report.batch_actions_outside_check || null,
      duplicate_adjust_idempotency_keys: report.duplicate_adjust_idempotency_keys || null,
    };
  }
  if (key === 'sql87') {
    // The helper and both case trigger functions: owner, SECURITY DEFINER and ACL.
    const caseOwners = Object.fromEntries(MORTGAGE_MIGRATIONS.sql87.functions.map((fn) => {
      const row = details.functions[fn.key] || {};
      return [fn.key, {
        exists: row.exists === true,
        rolname: row.owner ?? null,
        rolsuper: row.owner_rolsuper ?? null,
        security_definer: row.security_definer ?? null,
        member_of_checksops: row.owner_member_of_checksops ?? null,
        member_of_authenticated: row.owner_member_of_authenticated ?? null,
        proacl: row.proacl ?? null,
      }];
    }));
    return { case_owner: report.case_owner || null, case_owners: caseOwners, case_triggers: report.case_triggers || null, other_callers: report.other_callers || null };
  }
  if (key === 'sql88') {
    // Counts only (no ids, names or row data), first; then the four case functions'
    // owner, SECURITY DEFINER and ACL, the six triggers and other callers.
    const caseOwners = Object.fromEntries(MORTGAGE_MIGRATIONS.sql88.functions.map((fn) => {
      const row = details.functions[fn.key] || {};
      return [fn.key, {
        exists: row.exists === true,
        rolname: row.owner ?? null,
        rolsuper: row.owner_rolsuper ?? null,
        security_definer: row.security_definer ?? null,
        member_of_checksops: row.owner_member_of_checksops ?? null,
        member_of_authenticated: row.owner_member_of_authenticated ?? null,
        proacl: row.proacl ?? null,
      }];
    }));
    return {
      cross_tenant_links: report.cross_tenant_links || null,
      case_owner: report.case_owner || null,
      case_owners: caseOwners,
      claim_triggers: report.claim_triggers || null,
      other_callers: report.other_callers || null,
    };
  }
  const owners = Object.fromEntries(MORTGAGE_MIGRATIONS.sql86.functions.filter((fn) => fn.role === 'acl_only' || fn.role === 'referenced')
    .map((fn) => {
      const row = details.functions[fn.key] || {};
      return [fn.key, {
        exists: row.exists === true,
        rolname: row.owner ?? null,
        rolsuper: row.owner_rolsuper ?? null,
        member_of_checksops: row.owner_member_of_checksops ?? null,
        member_of_authenticated: row.owner_member_of_authenticated ?? null,
        proacl: row.proacl ?? null,
      }];
    }));
  return { earn_owner: report.earn_owner || null, earn_owners: owners };
}

export async function inspectMortgageProduction(key, { connect, pin, root = repoRootFrom(import.meta.url) }) {
  const tool = mortgageProductionTool(key);
  const thePin = pin || loadMortgageProductionPin(key, root);
  const source = await readPinnedMortgageSql(key, root, thePin);
  const executor = await loadStagingSqlExecutor(root);
  const client = await connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const state = await readState(client, executor, key, thePin);
    if (!state.ok) {
      return ok({ read_only: true, migration: key, state_error: { code: state.code, message: state.message }, apply_preconditions_met: false });
    }
    const details = state.details;
    const live = details.live_definition_sha256;
    const preRecorded = SHA256_RE.test(String(thePin.expected_live_definition_sha256 || ''));
    const preconditionFailures = mortgageProductionPreconditionFailures(key, details, thePin, executor);
    if (source.ok) executor.withMortgageBodyComparison(details, key, source.details.text, { keepDefinitions: tool.print_definitions || [] });
    const functions = Object.fromEntries(Object.entries(details.functions).map(([name, row]) => {
      const rest = { ...row };
      delete rest._def;
      return [name, {
        ...rest,
        acl_entries_with_grantor: details.production.function_acl_entries_with_grantor[name] || [],
      }];
    }));
    return ok({
      read_only: true,
      migration: key,
      filename: thePin.filename,
      // SQL 88: existing cross-tenant links (counts only, informational), at the top.
      ...(details.report?.cross_tenant_links ? { cross_tenant_links: details.report.cross_tenant_links } : {}),
      source_ok: source.ok,
      ...(source.ok ? {} : { source_error: { code: source.code, message: source.message } }),
      pin_execute: thePin.execute === true,
      current_user: details.current_user,
      session_user: details.session_user,
      login_rolsuper: details.login_rolsuper,
      login_rolbypassrls: details.login_rolbypassrls,
      owner_roles: details.production.owner_roles,
      authenticated_member_of_owner: details.production.authenticated_member_of_owner,
      prerequisites: details.prerequisites,
      sql47_prerequisites_present: details.sql47_prerequisites_present,
      missing_prerequisites: details.missing_prerequisites,
      functions,
      function_states: details.function_states,
      ...migrationReport(key, details),
      tables: details.tables,
      required_roles_present: details.required_roles_present,
      required_tables_present: details.required_tables_present,
      required_columns_present: details.required_columns_present,
      missing_columns: details.missing_columns,
      live_definition_sha256: live,
      expected_live_definition_sha256: thePin.expected_live_definition_sha256 ?? null,
      pre_state_recorded: preRecorded,
      intended_replacement_sha256: thePin.intended_replacement_sha256,
      live_matches_expected: preRecorded && live === thePin.expected_live_definition_sha256,
      already_applied: alreadyApplied(details, thePin),
      precondition_failures: preconditionFailures,
      apply_preconditions_met: source.ok
        && preRecorded
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

const consumedFileFor = (key, root, ctx) => ctx.consumedPath || path.join(root, '.deployment-guard', mortgageProductionTool(key).consumed_file);

/** Cheap checks that must pass before the single-use guard receipt is spent. */
export async function precheckMortgageProductionApply(key, input = {}, ctx = {}) {
  const { label } = mortgageProductionTool(key);
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadMortgageProductionPin(key, root);
  const evaluation = await evaluateMortgageProductionApply(key, input, { root, pin });
  if (!evaluation.ok) return evaluation;
  if (pin.execute !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, `${label} production execute is not authorized by this pin`);
  }
  if (!mortgageAuthorizationApproved(pin)) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, `${label} production pin authorization is not an owner approval`);
  }
  if (typeof pin.authorization_phrase !== 'string' || !pin.authorization_phrase || input.authorization_phrase !== pin.authorization_phrase) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, `${label} production apply requires the exact authorization phrase`);
  }
  if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
    return fail(CODES.INVALID_MANIFEST, `${label} production apply requires a single-use id`);
  }
  if (loadConsumed(consumedFileFor(key, root, ctx)).consumed.includes(input.one_use_id)) {
    return fail(CODES.RECEIPT_REUSED, 'one_use_id has already been consumed; replay is forbidden', { one_use_id: input.one_use_id });
  }
  return evaluation;
}

export async function executeMortgageProductionApply(key, input = {}, ctx = {}) {
  const tool = mortgageProductionTool(key);
  const { label } = tool;
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadMortgageProductionPin(key, root);
  const evaluation = await precheckMortgageProductionApply(key, input, { ...ctx, root, pin });
  if (!evaluation.ok) return evaluation;
  const consumedFile = consumedFileFor(key, root, ctx);
  const sql = await readPinnedMortgageSql(key, root, pin);
  if (!sql.ok) return sql;
  if (typeof ctx.connect !== 'function') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, `${label} production apply requires a database connection factory`);
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
    for (const lockKey of tool.lock_keys) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);

    const before = await readState(client, executor, key, pin);
    if (!before.ok) return rollback(before);
    if (alreadyApplied(before.details, pin)) {
      return rollback(fail(CODES.UNRELATED_MUTATION, `${label} is already in place; refuse re-apply`, {
        live_definition_sha256: before.details.live_definition_sha256,
        function_states: before.details.function_states,
      }));
    }
    const preFailures = mortgageProductionPreconditionFailures(key, before.details, pin, executor);
    if (preFailures.length) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, `${label} pre-apply conditions are not met`, {
        failed: preFailures,
        current_user: before.details.current_user,
        function_states: before.details.function_states,
      }));
    }
    if (before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== input.live_definition_sha256) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, `${label} live state is not the pinned pre-apply state`, {
        live_definition_sha256: before.details.live_definition_sha256,
        expected_live_definition_sha256: pin.expected_live_definition_sha256,
      }));
    }
    const snapshotBefore = await readMortgageUnrelatedSnapshot(client, key, executor);

    await client.query(sql.details.text);

    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const after = await readState(client, executor, key, pin);
    if (!after.ok) return rollback(after);
    const snapshotAfter = await readMortgageUnrelatedSnapshot(client, key, executor);
    const postFailures = mortgageProductionPostconditionFailures(key, after.details, pin, sql.details.reviewed_definition_sha256, executor, before.details);
    const changed = Object.keys(snapshotBefore.categories).filter((name) => snapshotBefore.categories[name] !== snapshotAfter.categories[name]);
    if (postFailures.length || changed.length) {
      return rollback(fail(CODES.UNRELATED_MUTATION, `${label} did not land exactly on the reviewed state, or changed something else`, {
        failed: postFailures,
        unrelated_changed: changed,
        after_hash: after.details.live_definition_sha256,
        function_states: after.details.function_states,
      }));
    }

    commitSent = true;
    await client.query('COMMIT');
    inTx = false;
    committed = true;
    return ok({
      receipt: {
        migration: key,
        workstream: input.workstream_id,
        commit: input.commit,
        sql_file: pin.filename,
        before_hash: before.details.live_definition_sha256,
        after_hash: after.details.live_definition_sha256,
        object_owner: mortgageObjectOwner(pin),
        function_acl_after: Object.fromEntries(Object.entries(after.details.functions).map(([name, row]) => [name, row.proacl])),
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
      return fail(CODES.SQL_COLLISION, `${label} production COMMIT outcome is unknown; re-run --inspect before anything else`, {
        message: applyErrorMessage(error),
      });
    }
    return rollback(fail(CODES.SQL_COLLISION, `${label} production apply failed and was rolled back`, {
      message: applyErrorMessage(error),
    }));
  } finally {
    await client.end().catch(() => {});
    // Recorded after the transaction so a registry write error is never reported as a rollback.
    if (committed) {
      try {
        consumeOneUse(consumedFile, input.one_use_id);
      } catch (error) {
        process.stderr.write(`${label} apply COMMITTED; one_use_id ${input.one_use_id} could not be recorded: ${String(error?.message || error).slice(0, 200)}\n`);
      }
    }
  }
}

/** Fixed messages for SQL 84/86 guard errors (shared with the staging executor). */
export const applyErrorMessage = (error) => sqlGuardErrorMessage(error, 300);

export { createProductionDatabaseConnect };
