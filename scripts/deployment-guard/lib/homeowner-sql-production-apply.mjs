/**
 * Production apply of SQL 82 (aws/workflows/sql/82_homeowner_ledger_view.sql,
 * CREATE OR REPLACE of public.aws_public_homeowner_ledger_by_token(text)) and
 * SQL 83 (aws/workflows/sql/83_homeowner_signing_capabilities.sql, CREATE OR
 * REPLACE of public.aws_public_homeowner_ledger_endorse_capability(text, uuid),
 * public.aws_public_homeowner_pending_signatures(text) and
 * public.aws_public_homeowner_document_sign_capability(text, uuid)). Each file
 * REVOKEs ALL FROM PUBLIC and authenticated and GRANTs EXECUTE TO checksops.
 *
 * Shared by the two official tools (sql82-homeowner-ledger-production-apply.mjs,
 * sql83-homeowner-signing-production-apply.mjs), each with its own pin. The
 * fingerprint, the reviewed-text parse, the reconstructed pg_get_functiondef and
 * the replace-safely rules are the staging guarded executor's own
 * (aws/write-path/guarded-sql-executor/index.mjs: readHomeownerState,
 * readHomeownerReport, parseHomeownerSql, homeownerReviewedFunctiondefs,
 * homeownerPreconditionFailures, homeownerPostconditionFailures), loaded from an
 * isolated copy of that module, as SQL 81's tool does.
 *
 * Neither production pre-state is code-derived: each pin's
 * expected_live_definition_sha256 is null until a read-only --inspect has been
 * recorded in a reviewed pin change, and evaluate and apply refuse until then.
 * Production adds to the staging rules: the connected login is the pinned function
 * owner (which owns every existing target function, or will own the new ones),
 * authenticated is not a member of that owner, and after the apply each function's
 * proacl is exactly the pinned owner plus checksops EXECUTE.
 *
 * Apply is one transaction (lock_timeout 5s, advisory locks) and rolls back unless
 * every postcondition holds and everything else in schema public (and the
 * functions in schema auth) is unchanged. Runs only on a host with private
 * reachability into the production VPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { functionDefsMatchExactly } from './function-def-lookup.mjs';
import { evaluateProductionGate } from './production.mjs';
import { hashSqlDefinition } from './sql-apply.mjs';
import {
  AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW,
  AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES,
  HOMEOWNER_EXECUTE_GRANTEES,
  HOMEOWNER_MIGRATIONS,
} from './sql-executor-auth.mjs';
import {
  createProductionDatabaseConnect,
  readUnrelatedCatalogSnapshot,
  resolveMemberStakeholderDatabaseUrl,
} from './sql-member-stakeholder-production-apply.mjs';
import { loadStagingSqlExecutor } from './staging-sql-executor-module.mjs';
import { repoRootFrom } from './paths.mjs';

export const HOMEOWNER_PRODUCTION_COMPONENT = 'production-sql';
export const HOMEOWNER_PRODUCTION_DEPLOYMENT_TYPE = 'sql-apply';

/** One entry per tool; the staging pin supplies the file, ids and the code-derived post-state. */
export const HOMEOWNER_PRODUCTION = Object.freeze({
  sql82: Object.freeze({
    key: 'sql82',
    label: 'SQL 82',
    pin_rel: 'ops/deployment-guard/sql82-homeowner-ledger-view-production-apply.json',
    staging_pin: AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW,
    allowed_key: 'sql82_production_apply_allowed',
    // The staging handler's lock key plus a production-only one.
    lock_keys: Object.freeze(['sql82_homeowner_functions', 'sql82_homeowner_functions_production']),
    consumed_file: 'sql82-homeowner-production-consumed.json',
    script: 'sql82-homeowner-ledger-production-apply',
  }),
  sql83: Object.freeze({
    key: 'sql83',
    label: 'SQL 83',
    pin_rel: 'ops/deployment-guard/sql83-homeowner-signing-capabilities-production-apply.json',
    staging_pin: AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES,
    allowed_key: 'sql83_production_apply_allowed',
    lock_keys: Object.freeze(['sql83_homeowner_functions', 'sql83_homeowner_functions_production']),
    consumed_file: 'sql83-homeowner-production-consumed.json',
    script: 'sql83-homeowner-signing-production-apply',
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

export function homeownerProductionTool(key) {
  const tool = HOMEOWNER_PRODUCTION[key];
  if (!tool) throw new Error(`unknown homeowner production migration ${key}`);
  return tool;
}

/** The pinned owner of the functions (the login that must run the apply). */
export function homeownerFunctionOwner(pin) {
  const owner = pin?.intended_post_state?.function_owner;
  return typeof owner === 'string' && owner ? owner : null;
}

/** `{owner=X/owner,checksops=X/owner}`: what each function's proacl must read after the apply. */
export function homeownerIntendedFunctionAcl(pin) {
  const owner = homeownerFunctionOwner(pin);
  return owner ? `{${owner}=X/${owner},${HOMEOWNER_EXECUTE_GRANTEES.map((g) => `${g}=X/${owner}`).join(',')}}` : null;
}

/** The staging reader's state plus `production` (grantors, owner membership), which is never hashed. */
async function readState(client, executor, key, pin) {
  const state = await executor.readHomeownerState(client, key);
  if (!state.ok) return state;
  const owner = homeownerFunctionOwner(pin);
  const ownerMember = (await client.query(AUTHENTICATED_IN_OWNER_SQL, [owner ? [owner] : []]))?.rows?.[0]?.member;
  const grantors = {};
  for (const fn of HOMEOWNER_MIGRATIONS[key].functions) {
    if (!state.details.functions[fn.name]?.exists) {
      grantors[fn.name] = [];
      continue;
    }
    const rows = (await client.query(FUNCTION_ACL_ENTRIES_SQL, [fn.identity]))?.rows || [];
    grantors[fn.name] = rows.map((row) => `${entryLine(row)} granted by ${row.grantor}`).sort();
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

/** Everything the migration must not touch: schema public except its functions, plus schema auth's functions. */
export async function readHomeownerUnrelatedSnapshot(client, key) {
  const identities = HOMEOWNER_MIGRATIONS[key].functions.map((fn) => fn.identity);
  const snapshot = await readUnrelatedCatalogSnapshot(client, { functions_ignored: identities });
  const authFunctions = await readAuthFunctions(client);
  return {
    categories: { ...snapshot.categories, auth_functions: authFunctions },
    counts: snapshot.counts,
    sha256: hashSqlDefinition(JSON.stringify({ ...snapshot.categories, auth_functions: authFunctions })),
  };
}

/** Production-only checks that hold before and after: the login, its ownership and authenticated's membership. */
const productionChecks = (key, state, pin) => {
  const owner = homeownerFunctionOwner(pin);
  return [
    ['login_is_pinned_owner', owner !== null && state?.current_user === owner && state?.session_user === owner],
    ['functions_owned_by_pinned_owner', owner !== null && HOMEOWNER_MIGRATIONS[key].functions
      .every((fn) => state?.functions?.[fn.name]?.exists !== true || state.functions[fn.name].owner === owner)],
    ['authenticated_not_member_of_owner', state?.production?.authenticated_member_of_owner === false
      && sameList(state?.production?.owner_roles, owner ? [owner] : null)],
  ];
};

/** Production pre-apply rule: the executor's replace-safely rules plus the production checks. */
export function homeownerProductionPreconditionFailures(key, state, pin, executor) {
  return [
    ...executor.homeownerPreconditionFailures(state, key),
    ...failed(productionChecks(key, state, pin)),
  ];
}

/**
 * Production post-apply rule. `reviewed` maps each identity to the sha256 of the
 * pg_get_functiondef reconstructed from the pinned file's own bodies, so the live
 * definitions are compared with the reviewed text, not only with constants.
 */
export function homeownerProductionPostconditionFailures(key, after, pin, reviewed, executor) {
  const intendedAcl = homeownerIntendedFunctionAcl(pin);
  return [
    ...executor.homeownerPostconditionFailures(after, key, reviewed, pin?.intended_replacement_sha256),
    ...failed(productionChecks(key, after, pin)),
    ...failed(HOMEOWNER_MIGRATIONS[key].functions.flatMap((fn) => [
      [`public_execute_revoked:${fn.name}`, !(after?.functions?.[fn.name]?.acl_entries || ['PUBLIC']).some((line) => line.startsWith('PUBLIC '))],
      [`function_acl_as_intended:${fn.name}`, intendedAcl !== null && after?.functions?.[fn.name]?.proacl === intendedAcl
        && typeof pin?.intended_post_state?.function_acl === 'string' && pin.intended_post_state.function_acl === intendedAcl],
    ])),
  ];
}

/**
 * A pin authorizes execution only with an owner approval recorded in `authorization`:
 * the SQL 77-81 pins' "Owner approved …" / "owner-approved …" convention. "pending",
 * an empty or a missing value refuses.
 */
export const OWNER_APPROVED_AUTHORIZATION_RE = /^owner[- ]approved\b/i;
export function homeownerAuthorizationApproved(pin) {
  const value = typeof pin?.authorization === 'string' ? pin.authorization.trim() : '';
  return value !== '' && value.toLowerCase() !== 'pending' && OWNER_APPROVED_AUTHORIZATION_RE.test(value);
}

const alreadyApplied = (state, pin) => state.live_definition_sha256 === pin.intended_replacement_sha256;

export function loadHomeownerProductionPin(key, root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, homeownerProductionTool(key).pin_rel), 'utf8'));
}

/** A pin may only name its migration's file, functions, environment and component. */
function pinBindingFailures(key, pin) {
  const staging = homeownerProductionTool(key).staging_pin;
  return [
    ['migration', key],
    ['filename', staging.filename],
    ['migration_id', staging.migration_id],
    ['source_sha256', staging.source_sha256],
    ['staging_pin_commit', staging.commit],
    ['intended_replacement_sha256', staging.intended_replacement_sha256],
    ['target_environment', 'production'],
    ['target_component', HOMEOWNER_PRODUCTION_COMPONENT],
    ['deployment_type', HOMEOWNER_PRODUCTION_DEPLOYMENT_TYPE],
  ].filter(([field, value]) => pin?.[field] !== value).map(([field]) => field)
    .concat(sameList(pin?.function_identities, [...staging.function_identities]) ? [] : ['function_identities']);
}

/**
 * Pinned source bytes, checked against the pin and, through the staging
 * executor's parse, against the reviewed statements and functiondefs.
 */
export async function readPinnedHomeownerSql(key, root, pin) {
  const { label } = homeownerProductionTool(key);
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
  if (!executor.homeownerSqlIsReviewed(key, text)) {
    return fail(CODES.UNRELATED_MUTATION, `${label} is not exactly the reviewed statements`);
  }
  const defs = executor.homeownerReviewedFunctiondefs(key, text);
  const reviewed = Object.fromEntries(Object.entries(defs).map(([identity, def]) => [identity, hashSqlDefinition(def)]));
  return ok({ text, source_sha256: sha, reviewed_definition_sha256: reviewed });
}

/** Manifest checks shared by preflight and apply: exact pin, a recorded pre-state and the production gate. */
export async function evaluateHomeownerProductionApply(key, input = {}, { root = repoRootFrom(import.meta.url), pin } = {}) {
  const tool = homeownerProductionTool(key);
  const thePin = pin || loadHomeownerProductionPin(key, root);
  const sql = await readPinnedHomeownerSql(key, root, thePin);
  if (!sql.ok) return sql;
  if (!SHA256_RE.test(String(thePin.expected_live_definition_sha256 || ''))) {
    return fail(CODES.SQL_COLLISION, `${tool.label} production pin has no recorded pre-apply live definition hash yet; run --inspect and record it in a reviewed pin change`);
  }
  if (!homeownerAuthorizationApproved(thePin)) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, `${tool.label} production pin authorization is not an owner approval (it is ${JSON.stringify(String(thePin.authorization ?? null).slice(0, 40))}); a reviewed pin change must record it`);
  }
  const mismatched = [
    ['target_environment', 'production'],
    ['target_component', HOMEOWNER_PRODUCTION_COMPONENT],
    ['deployment_type', HOMEOWNER_PRODUCTION_DEPLOYMENT_TYPE],
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

export const resolveHomeownerDatabaseUrl = resolveMemberStakeholderDatabaseUrl;

// --- inspect ----------------------------------------------------------------

export async function inspectHomeownerProduction(key, { connect, pin, root = repoRootFrom(import.meta.url) }) {
  const thePin = pin || loadHomeownerProductionPin(key, root);
  const source = await readPinnedHomeownerSql(key, root, thePin);
  const executor = await loadStagingSqlExecutor(root);
  const client = await connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const state = await readState(client, executor, key, thePin);
    if (!state.ok) {
      return ok({ read_only: true, migration: key, state_error: { code: state.code, message: state.message }, apply_preconditions_met: false });
    }
    const report = await executor.readHomeownerReport(client);
    const details = state.details;
    const live = details.live_definition_sha256;
    const preRecorded = SHA256_RE.test(String(thePin.expected_live_definition_sha256 || ''));
    const preconditionFailures = homeownerProductionPreconditionFailures(key, details, thePin, executor);
    const reviewedDefs = source.ok ? executor.homeownerReviewedFunctiondefs(key, source.details.text) || {} : {};
    const functions = Object.fromEntries(Object.entries(details.functions).map(([name, row]) => {
      const { _def: def, ...rest } = row;
      const reviewedDef = reviewedDefs[row.identity];
      return [name, {
        ...rest,
        // function-def-lookup comparison with the definition reconstructed from the file.
        body_matches_migration: def && reviewedDef ? functionDefsMatchExactly(def, reviewedDef) : null,
        acl_entries_with_grantor: details.production.function_acl_entries_with_grantor[name] || [],
      }];
    }));
    return ok({
      read_only: true,
      migration: key,
      filename: thePin.filename,
      source_ok: source.ok,
      ...(source.ok ? {} : { source_error: { code: source.code, message: source.message } }),
      pin_execute: thePin.execute === true,
      current_user: details.current_user,
      session_user: details.session_user,
      login_rolsuper: details.login_rolsuper,
      login_rolbypassrls: details.login_rolbypassrls,
      owner_roles: details.production.owner_roles,
      authenticated_member_of_owner: details.production.authenticated_member_of_owner,
      functions,
      function_states: details.function_states,
      ...(key === 'sql82' ? { ledger_view_raw_endorse_token_link: functions.aws_public_homeowner_ledger_by_token?.raw_endorse_token_link ?? null } : {}),
      legacy_remint_signer: report.ok ? report.details.legacy_remint_signer : null,
      row_security: details.row_security,
      row_security_off_supported: details.row_security_off_supported,
      tables: details.tables,
      required_roles_present: details.required_roles_present,
      required_tables_present: details.required_tables_present,
      required_columns_present: details.required_columns_present,
      missing_columns: details.missing_columns,
      status_constraints: report.ok ? report.details.status_constraints : null,
      status_counts: report.ok ? report.details.status_counts : null,
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

const consumedFileFor = (key, root, ctx) => ctx.consumedPath || path.join(root, '.deployment-guard', homeownerProductionTool(key).consumed_file);

/** Cheap checks that must pass before the single-use guard receipt is spent. */
export async function precheckHomeownerProductionApply(key, input = {}, ctx = {}) {
  const { label } = homeownerProductionTool(key);
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadHomeownerProductionPin(key, root);
  const evaluation = await evaluateHomeownerProductionApply(key, input, { root, pin });
  if (!evaluation.ok) return evaluation;
  if (pin.execute !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, `${label} production execute is not authorized by this pin`);
  }
  if (!homeownerAuthorizationApproved(pin)) {
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

export async function executeHomeownerProductionApply(key, input = {}, ctx = {}) {
  const tool = homeownerProductionTool(key);
  const { label } = tool;
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadHomeownerProductionPin(key, root);
  const evaluation = await precheckHomeownerProductionApply(key, input, { ...ctx, root, pin });
  if (!evaluation.ok) return evaluation;
  const consumedFile = consumedFileFor(key, root, ctx);
  const sql = await readPinnedHomeownerSql(key, root, pin);
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
    const preFailures = homeownerProductionPreconditionFailures(key, before.details, pin, executor);
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
    const snapshotBefore = await readHomeownerUnrelatedSnapshot(client, key);

    await client.query(sql.details.text);

    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const after = await readState(client, executor, key, pin);
    if (!after.ok) return rollback(after);
    const snapshotAfter = await readHomeownerUnrelatedSnapshot(client, key);
    const postFailures = homeownerProductionPostconditionFailures(key, after.details, pin, sql.details.reviewed_definition_sha256, executor);
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
        function_owner: homeownerFunctionOwner(pin),
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
        message: String(error?.message || error).slice(0, 300),
      });
    }
    return rollback(fail(CODES.SQL_COLLISION, `${label} production apply failed and was rolled back`, {
      message: String(error?.message || error).slice(0, 300),
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

export { createProductionDatabaseConnect };
