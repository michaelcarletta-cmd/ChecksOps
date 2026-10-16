/**
 * Production apply of SQL 89 (aws/workflows/sql/89_check_intake_items_column_update.sql):
 *
 *   REVOKE UPDATE ON TABLE public.check_intake_items FROM checksops;
 *   GRANT UPDATE (<the 43 SQL89_COLUMNS>) ON TABLE public.check_intake_items TO checksops;
 *
 * Production's checksops holds table-level UPDATE (ACL checksops=arwd/checksops_admin),
 * so every column is updatable. SQL 89 leaves UPDATE on exactly the columns the API
 * writes; SELECT, INSERT and DELETE stay as they are. With it, SQL 71's state (amount
 * updatable, no table-level UPDATE) holds in production.
 *
 * The live fingerprint is the staging guarded executor's (readSql89State, shared through
 * sql-executor-auth.mjs): sha256 of columnUpdateStateText, i.e. whether checksops has
 * table-level UPDATE by any route and the sorted set of columns it can UPDATE by any
 * route. The post-state is the same text for "no table-level UPDATE, exactly
 * SQL89_COLUMNS" (2a1d45f9…) in both environments. The production rules add:
 *
 *   - the login (current_user and session_user) is the pinned admin login;
 *   - the shared rules: every SQL 89 column exists, checksops has no grant option, every
 *     UPDATE entry of checksops was granted by the login (the REVOKE removes only those),
 *     the login may grant UPDATE, no SECURITY INVOKER function (or one owned by a role
 *     with checksops' privileges) UPDATEs the table, and SQL 70's SECURITY DEFINER
 *     aws_ingest_shared_check(jsonb) exists (otherwise the ingest falls back to an
 *     inline UPDATE as checksops of columns SQL 89 does not grant);
 *   - the table owner, the table ACL and the set of columns checksops can UPDATE equal
 *     the values the reviewed production inspect recorded in the pin
 *     (production_inspect), so drift since that inspect refuses.
 *
 * Apply is one transaction (lock_timeout 5s, advisory locks): the pinned file only.
 * It rolls back unless afterwards checksops has no table-level UPDATE (directly, via
 * PUBLIC or membership), can UPDATE exactly SQL89_COLUMNS through direct column grants
 * by the login, every other table privilege (SELECT, INSERT, DELETE, …), table ACL
 * entry and column ACL entry is unchanged, and everything else in schema public (and
 * schema auth's functions) is unchanged. Runs only on a host with private reachability
 * into the production VPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { homeownerAuthorizationApproved } from './homeowner-sql-production-apply.mjs';
import { evaluateProductionGate } from './production.mjs';
import { hashSqlDefinition } from './sql-apply.mjs';
import {
  AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE,
  SQL89_CANONICAL_STATEMENTS,
  SQL89_COLUMNS,
  readSql89State,
  readSql89UnrelatedSnapshot,
  sql89ChangedCategories,
  sql89PostconditionFailures,
  sql89SharedPreconditionFailures,
  sql89StatementText,
} from './sql-executor-auth.mjs';
import {
  createProductionDatabaseConnect,
  readUnrelatedCatalogSnapshot,
  resolveMemberStakeholderDatabaseUrl,
} from './sql-member-stakeholder-production-apply.mjs';
import { repoRootFrom } from './paths.mjs';

export const SQL89_PRODUCTION_COMPONENT = 'production-sql';
export const SQL89_PRODUCTION_DEPLOYMENT_TYPE = 'sql-apply';
export const SQL89_PRODUCTION_PIN_REL = 'ops/deployment-guard/sql89-check-intake-column-update-production-apply.json';
export const SQL89_STAGING_PIN = AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE;
export const SQL89_TABLE = SQL89_STAGING_PIN.table;
export const SQL89_GRANTEE = SQL89_STAGING_PIN.grantee;
export { SQL89_COLUMNS };
// The staging handler's lock key plus a production-only one.
const LOCK_KEYS = Object.freeze(['sql89_check_intake_column_update', 'sql89_check_intake_column_update_production']);
const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PG_CATALOG_SEARCH_PATH_SQL = "SELECT set_config('search_path', 'pg_catalog', false)";

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);
const failed = (checks) => checks.filter(([, passed]) => !passed).map(([name]) => name);

/** The pinned admin login (the only login the tool runs as). */
export function sql89AdminLogin(pin) {
  const login = pin?.admin_login;
  return typeof login === 'string' && login ? login : null;
}

/** Everything SQL 89 must not touch: schema public (this table's ACLs aside) and schema auth's functions. */
export async function readSql89ProductionUnrelatedSnapshot(client) {
  const catalog = await readUnrelatedCatalogSnapshot(client, { skip_relations: [SQL89_TABLE] });
  const own = await readSql89UnrelatedSnapshot(client);
  const categories = { ...catalog.categories, ...own.categories };
  return { categories, counts: { ...catalog.counts, ...own.counts }, sha256: hashSqlDefinition(JSON.stringify(categories)) };
}

/** Production pre-apply rule. */
export function sql89ProductionPreconditionFailures(state, pin) {
  const recorded = pin?.production_inspect || {};
  const login = sql89AdminLogin(pin);
  return [
    ...failed([['login_is_pinned_admin', login !== null && state?.current_user === login && state?.session_user === login]]),
    ...sql89SharedPreconditionFailures(state),
    ...failed([
      ['table_owner_as_inspected', typeof recorded.table_owner === 'string' && state?.table_owner === recorded.table_owner],
      ['table_acl_as_inspected', typeof recorded.table_acl === 'string' && state?.table_acl === recorded.table_acl],
      ['updatable_columns_as_inspected', Array.isArray(recorded.updatable_columns)
        && sameList(state?.updatable_columns, recorded.updatable_columns)
        && state?.updatable_columns_sha256 === recorded.updatable_columns_sha256],
    ]),
  ];
}

/** Production post-apply rule: the shared one, run as the pinned login. */
export function sql89ProductionPostconditionFailures(before, after, pin) {
  const login = sql89AdminLogin(pin);
  return [
    ...sql89PostconditionFailures(before, after),
    ...failed([['login_is_pinned_admin', login !== null && after?.current_user === login && after?.session_user === login]]),
  ];
}

export function loadSql89ProductionPin(root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, SQL89_PRODUCTION_PIN_REL), 'utf8'));
}

/** A pin may only name SQL 89's file, statements, columns, environment and component. */
function pinBindingFailures(pin) {
  const scalar = [
    ['migration', 'sql89'],
    ['filename', SQL89_STAGING_PIN.filename],
    ['migration_id', SQL89_STAGING_PIN.migration_id],
    ['source_sha256', SQL89_STAGING_PIN.source_sha256],
    ['staging_pin_commit', SQL89_STAGING_PIN.commit],
    ['intended_replacement_sha256', SQL89_STAGING_PIN.intended_replacement_sha256],
    ['table', SQL89_TABLE],
    ['grantee', SQL89_GRANTEE],
    ['target_environment', 'production'],
    ['target_component', SQL89_PRODUCTION_COMPONENT],
    ['deployment_type', SQL89_PRODUCTION_DEPLOYMENT_TYPE],
  ].filter(([field, value]) => pin?.[field] !== value).map(([field]) => field);
  return sameList(pin?.columns, [...SQL89_COLUMNS]) ? scalar : [...scalar, 'columns'];
}

/** Pinned source bytes, checked against the pin and the two reviewed statements. */
export function readPinnedSql89(root, pin) {
  const binding = pinBindingFailures(pin);
  if (binding.length) {
    return fail(CODES.SQL_COLLISION, 'SQL 89 production pin does not name this migration', { mismatched: binding });
  }
  const file = path.join(root, pin.filename);
  if (!fs.existsSync(file)) return fail(CODES.STALE_PACKAGE, 'pinned SQL 89 file is missing');
  const text = fs.readFileSync(file, 'utf8');
  const sha = hashSqlDefinition(text);
  if (sha !== pin.source_sha256) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, 'SQL 89 bytes differ from the production pin', {
      source_sha256: sha,
      pinned_source_sha256: pin.source_sha256,
    });
  }
  if (sql89StatementText(text) !== SQL89_CANONICAL_STATEMENTS) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 89 is not exactly the pinned REVOKE and column GRANT');
  }
  return ok({ text, source_sha256: sha });
}

/** Manifest checks shared by preflight and apply: exact pin, a recorded pre-state, an owner approval and the production gate. */
export async function evaluateSql89ProductionApply(input = {}, { root = repoRootFrom(import.meta.url), pin } = {}) {
  const thePin = pin || loadSql89ProductionPin(root);
  const sql = readPinnedSql89(root, thePin);
  if (!sql.ok) return sql;
  if (!SHA256_RE.test(String(thePin.expected_live_definition_sha256 || ''))) {
    return fail(CODES.SQL_COLLISION, 'SQL 89 production pin has no recorded pre-apply live definition hash yet; run --inspect and record it in a reviewed pin change');
  }
  if (!homeownerAuthorizationApproved(thePin)) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, `SQL 89 production pin authorization is not an owner approval (it is ${JSON.stringify(String(thePin.authorization ?? null).slice(0, 40))}); a reviewed pin change must record it`);
  }
  const mismatched = [
    ['target_environment', 'production'],
    ['target_component', SQL89_PRODUCTION_COMPONENT],
    ['deployment_type', SQL89_PRODUCTION_DEPLOYMENT_TYPE],
    ['filename', thePin.filename],
    ['migration_id', thePin.migration_id],
    ['source_sha256', thePin.source_sha256],
    ['expected_live_definition_sha256', thePin.expected_live_definition_sha256],
    ['intended_replacement_sha256', thePin.intended_replacement_sha256],
    // The live hash from the inspect; checked here so a typo never spends the receipt.
    ['live_definition_sha256', thePin.expected_live_definition_sha256],
  ].filter(([key, value]) => input[key] !== value).map(([key]) => key);
  if (mismatched.length) {
    return fail(CODES.SQL_COLLISION, 'SQL 89 production apply is bound to the exact production pin', { mismatched });
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
    migration: 'sql89',
    sql89_production_apply_allowed: true,
    expected_live_definition_sha256: thePin.expected_live_definition_sha256,
    intended_replacement_sha256: thePin.intended_replacement_sha256,
    staging_acceptance: gate.details.staging_acceptance,
  });
}

export const resolveSql89DatabaseUrl = resolveMemberStakeholderDatabaseUrl;

// --- inspect ----------------------------------------------------------------

export async function inspectSql89Production({ connect, pin, root = repoRootFrom(import.meta.url) }) {
  const thePin = pin || loadSql89ProductionPin(root);
  const source = readPinnedSql89(root, thePin);
  const client = await connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const state = await readSql89State(client);
    if (!state.ok) {
      return ok({ read_only: true, migration: 'sql89', state_error: { code: state.code, message: state.message }, apply_preconditions_met: false });
    }
    const d = state.details;
    const live = d.live_definition_sha256;
    const preconditionFailures = sql89ProductionPreconditionFailures(d, thePin);
    const applied = d.already_applied === true;
    return ok({
      read_only: true,
      migration: 'sql89',
      filename: thePin.filename,
      source_ok: source.ok,
      ...(source.ok ? {} : { source_error: { code: source.code, message: source.message } }),
      pin_execute: thePin.execute === true,
      current_user: d.current_user,
      session_user: d.session_user,
      admin_login: sql89AdminLogin(thePin),
      grantee: SQL89_GRANTEE,
      table: SQL89_TABLE,
      table_owner: d.table_owner,
      table_acl: d.table_acl,
      table_acl_entries: d.table_acl_entries || [],
      // checksops' privileges on the table, readable.
      table_privileges: d.table_privileges || {},
      table_level_update: d.table_level_update ?? null,
      column_count: (d.columns || []).length,
      updatable_columns: d.updatable_columns || [],
      updatable_columns_sha256: d.updatable_columns_sha256 || null,
      column_update_entries: d.column_update_entries || [],
      grantee_grant_option: d.grantee_grant_option ?? null,
      grantee_update_grantors: d.grantee_update_grantors || [],
      login_can_grant: d.login_can_grant ?? null,
      // The plan.
      sql89_columns: d.sql89_columns || [...SQL89_COLUMNS],
      sql89_columns_missing: d.sql89_columns_missing || [],
      columns_to_grant: d.columns_to_grant || [],
      columns_losing_update: d.columns_losing_update || [],
      // Prerequisites.
      update_functions: d.update_functions || [],
      unsafe_update_functions: d.unsafe_update_functions || [],
      ingest_function_present: d.ingest_function_present ?? null,
      ingest_function_security_definer: d.ingest_function_security_definer ?? null,
      live_definition_sha256: live,
      expected_live_definition_sha256: thePin.expected_live_definition_sha256 ?? null,
      intended_replacement_sha256: thePin.intended_replacement_sha256,
      live_matches_expected: typeof live === 'string' && live === thePin.expected_live_definition_sha256,
      already_applied: applied,
      // What the apply must leave.
      post_state: {
        live_definition_sha256: thePin.intended_replacement_sha256,
        updatable_columns: [...SQL89_COLUMNS],
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

const consumedFileFor = (root, ctx) => ctx.consumedPath || path.join(root, '.deployment-guard', 'sql89-check-intake-column-update-production-consumed.json');

/** Cheap checks that must pass before the single-use guard receipt is spent. */
export async function precheckSql89ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadSql89ProductionPin(root);
  const evaluation = await evaluateSql89ProductionApply(input, { root, pin });
  if (!evaluation.ok) return evaluation;
  if (pin.execute !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 89 production execute is not authorized by this pin');
  }
  if (typeof pin.authorization_phrase !== 'string' || !pin.authorization_phrase || input.authorization_phrase !== pin.authorization_phrase) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL 89 production apply requires the exact authorization phrase');
  }
  if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
    return fail(CODES.INVALID_MANIFEST, 'SQL 89 production apply requires a single-use id');
  }
  if (loadConsumed(consumedFileFor(root, ctx)).consumed.includes(input.one_use_id)) {
    return fail(CODES.RECEIPT_REUSED, 'one_use_id has already been consumed; replay is forbidden', { one_use_id: input.one_use_id });
  }
  return evaluation;
}

export async function executeSql89ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadSql89ProductionPin(root);
  const evaluation = await precheckSql89ProductionApply(input, { ...ctx, root, pin });
  if (!evaluation.ok) return evaluation;
  const consumedFile = consumedFileFor(root, ctx);
  const sql = readPinnedSql89(root, pin);
  if (!sql.ok) return sql;
  if (typeof ctx.connect !== 'function') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 89 production apply requires a database connection factory');
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

    const before = await readSql89State(client);
    if (!before.ok) return rollback(before);
    const b = before.details;
    if (b.already_applied === true) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'checksops already has exactly the SQL 89 column UPDATE grants; SQL 89 is already in place; refuse re-apply', {
        live_definition_sha256: b.live_definition_sha256,
      }));
    }
    const preFailures = sql89ProductionPreconditionFailures(b, pin);
    if (preFailures.length) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, 'SQL 89 pre-apply conditions are not met', {
        failed: preFailures,
        current_user: b.current_user,
        sql89_columns_missing: b.sql89_columns_missing || [],
        unsafe_update_functions: b.unsafe_update_functions || [],
      }));
    }
    if (b.live_definition_sha256 !== pin.expected_live_definition_sha256
      || b.live_definition_sha256 !== input.live_definition_sha256) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, 'SQL 89 live state is not the pinned pre-apply state', {
        live_definition_sha256: b.live_definition_sha256,
        expected_live_definition_sha256: pin.expected_live_definition_sha256,
      }));
    }
    const snapshotBefore = await readSql89ProductionUnrelatedSnapshot(client);
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);

    await client.query(sql.details.text);

    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const after = await readSql89State(client);
    if (!after.ok) return rollback(after);
    const snapshotAfter = await readSql89ProductionUnrelatedSnapshot(client);
    const postFailures = sql89ProductionPostconditionFailures(b, after.details, pin);
    const changed = sql89ChangedCategories(snapshotBefore, snapshotAfter);
    if (postFailures.length || changed.length) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'SQL 89 did not leave exactly the pinned checksops UPDATE columns and nothing else', {
        failed: postFailures,
        unrelated_changed: changed,
        updatable_columns_after: after.details.updatable_columns,
      }));
    }

    commitSent = true;
    await client.query('COMMIT');
    inTx = false;
    committed = true;
    return ok({
      receipt: {
        migration: 'sql89',
        workstream: input.workstream_id,
        commit: input.commit,
        sql_file: pin.filename,
        before_hash: b.live_definition_sha256,
        after_hash: after.details.live_definition_sha256,
        table_level_update_before: b.table_level_update,
        table_level_update: after.details.table_level_update,
        updatable_columns_before: b.updatable_columns,
        updatable_columns_after: after.details.updatable_columns,
        columns_lost_update: b.columns_losing_update,
        columns_gained_update: b.columns_to_grant,
        column_update_entries_after: after.details.column_update_entries,
        table_privileges_after: after.details.table_privileges,
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
      return fail(CODES.SQL_COLLISION, 'SQL 89 production COMMIT outcome is unknown; re-run --inspect before anything else', {
        message: String(error?.message || error).slice(0, 300),
      });
    }
    return rollback(fail(CODES.SQL_COLLISION, 'SQL 89 production apply failed and was rolled back', {
      message: String(error?.message || error).slice(0, 300),
    }));
  } finally {
    await client.end().catch(() => {});
    // Recorded after the transaction so a registry write error is never reported as a rollback.
    if (committed) {
      try {
        consumeOneUse(consumedFile, input.one_use_id);
      } catch (error) {
        process.stderr.write(`SQL 89 apply COMMITTED; one_use_id ${input.one_use_id} could not be recorded: ${String(error?.message || error).slice(0, 200)}\n`);
      }
    }
  }
}

export { createProductionDatabaseConnect };
