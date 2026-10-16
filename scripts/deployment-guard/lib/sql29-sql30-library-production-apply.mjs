/**
 * Production apply of SQL 29 and SQL 30, the unchanged Mortgage Ops library operator
 * packages (release lock mortgage-ops):
 *
 *   sql29  aws/rls/sql/29_mortgage_ops_library_parity.sql
 *          five SECURITY DEFINER helpers (desk-agent read of attached library:mortgage
 *          rows, the storage-sign path check, the library manage check, the attach INSERT
 *          check, the auto-share trigger function), the two policies on
 *          mortgage_request_library_documents and its SELECT/INSERT-only grants.
 *   sql30  aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql
 *          tenant_documents_doc_type_check: the 3- or 6-value predecessor becomes the
 *          13-value list (6 legacy + 7 canonical library:mortgage:* values).
 *
 * Both run on one engine shared with the staging guarded executor (sql-executor-auth.mjs):
 * the same state reader, code-derived fingerprints (sql29StateText / sql30StateText),
 * pre- and post-conditions and unrelated-catalog snapshot. The production rules add the
 * pinned admin login. SQL 30 carries its own BEGIN/COMMIT; the tool runs the bytes between
 * them in its own transaction (sql30ExecutableText), so it can verify before COMMIT.
 *
 * Order: SQL 29 before SQL 90 (users only): SQL 29 after SQL 90 would bring back the
 * owner/admin tier, so it refuses with sql90_not_applied once SQL 90's marker exists.
 * SQL 30 before SQL 94 (whose CHECK supersedes it; SQL 30 refuses that predecessor).
 *
 * --inspect is BEGIN READ ONLY ... ROLLBACK. Of table rows it reads only aggregate
 * COUNT(*)s (tenant_documents by category prefix and by stored-path form,
 * shared_with_homeowners, mortgage_request_library_documents, rows outside SQL 30's
 * values): never ids, names or paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { homeownerAuthorizationApproved } from './homeowner-sql-production-apply.mjs';
import { evaluateProductionGate } from './production.mjs';
import { hashSqlDefinition } from './sql-apply.mjs';
import {
  LIBRARY_SQL_PINS,
  libraryChangedCategories,
  librarySharedPostconditionFailures,
  librarySharedPreconditionFailures,
  librarySqlExecutableText,
  librarySqlLiveHash,
  librarySqlReport,
  readLibrarySqlState,
  readLibraryUnrelatedSnapshot,
} from './sql-executor-auth.mjs';
import {
  createProductionDatabaseConnect,
  resolveMemberStakeholderDatabaseUrl,
} from './sql-member-stakeholder-production-apply.mjs';
import { repoRootFrom } from './paths.mjs';

export const LIBRARY_PRODUCTION_COMPONENT = 'production-sql';
export const LIBRARY_PRODUCTION_DEPLOYMENT_TYPE = 'sql-apply';

export const LIBRARY_PRODUCTION = Object.freeze({
  sql29: Object.freeze({
    key: 'sql29',
    label: 'SQL 29',
    pin_rel: 'ops/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.json',
    staging_pin: LIBRARY_SQL_PINS.sql29,
    allowed_key: 'sql29_production_apply_allowed',
    lock_keys: Object.freeze(['sql29_library_sql', 'sql29_library_sql_production']),
    consumed_file: 'sql29-mortgage-ops-library-parity-production-consumed.json',
    script: 'sql29-mortgage-ops-library-parity-production-apply',
  }),
  sql30: Object.freeze({
    key: 'sql30',
    label: 'SQL 30',
    pin_rel: 'ops/deployment-guard/sql30-tenant-documents-doc-type-production-apply.json',
    staging_pin: LIBRARY_SQL_PINS.sql30,
    allowed_key: 'sql30_production_apply_allowed',
    lock_keys: Object.freeze(['sql30_library_sql', 'sql30_library_sql_production']),
    consumed_file: 'sql30-tenant-documents-doc-type-production-consumed.json',
    script: 'sql30-tenant-documents-doc-type-production-apply',
  }),
});

export const SQL29_PRODUCTION_PIN_REL = LIBRARY_PRODUCTION.sql29.pin_rel;
export const SQL30_PRODUCTION_PIN_REL = LIBRARY_PRODUCTION.sql30.pin_rel;

const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PG_CATALOG_SEARCH_PATH_SQL = "SELECT set_config('search_path', 'pg_catalog', false)";
const failed = (checks) => checks.filter(([, passed]) => !passed).map(([name]) => name);

const toolFor = (key) => {
  const tool = LIBRARY_PRODUCTION[key];
  if (!tool) throw new Error(`unknown library migration ${key}`);
  return tool;
};

export function libraryAdminLogin(pin) {
  const login = pin?.admin_login;
  return typeof login === 'string' && login ? login : null;
}

export function loadLibraryProductionPin(key, root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, toolFor(key).pin_rel), 'utf8'));
}

/** Production pre-apply rule: the pinned login plus the shared rules. */
export function libraryProductionPreconditionFailures(key, state, pin) {
  const login = libraryAdminLogin(pin);
  return [
    ...failed([['login_is_pinned_admin', login !== null && state?.current_user === login && state?.session_user === login]]),
    ...librarySharedPreconditionFailures(key, state),
  ];
}

export function libraryProductionPostconditionFailures(key, before, after, pin) {
  const login = libraryAdminLogin(pin);
  return [
    ...librarySharedPostconditionFailures(key, before, after, pin),
    ...failed([['login_is_pinned_admin', login !== null && after?.current_user === login && after?.session_user === login]]),
  ];
}

/** A pin may only name its migration's file, hashes, environment and component. */
function pinBindingFailures(key, pin) {
  const staging = toolFor(key).staging_pin;
  return [
    ['migration', key],
    ['filename', staging.filename],
    ['migration_id', staging.migration_id],
    ['source_sha256', staging.source_sha256],
    ['staging_pin_commit', staging.commit],
    ['intended_replacement_sha256', staging.intended_replacement_sha256],
    ['target_environment', 'production'],
    ['target_component', LIBRARY_PRODUCTION_COMPONENT],
    ['deployment_type', LIBRARY_PRODUCTION_DEPLOYMENT_TYPE],
  ].filter(([field, value]) => pin?.[field] !== value).map(([field]) => field);
}

/** Pinned source bytes, checked against the pin and the reviewed package shape. */
export function readPinnedLibrarySql(key, root, pin) {
  const tool = toolFor(key);
  const binding = pinBindingFailures(key, pin);
  if (binding.length) {
    return fail(CODES.SQL_COLLISION, `${tool.label} production pin does not name this migration`, { mismatched: binding });
  }
  const file = path.join(root, pin.filename);
  if (!fs.existsSync(file)) return fail(CODES.STALE_PACKAGE, `pinned ${tool.label} file is missing`);
  const text = fs.readFileSync(file, 'utf8');
  const sha = hashSqlDefinition(text);
  if (sha !== pin.source_sha256) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, `${tool.label} bytes differ from the production pin`, {
      source_sha256: sha,
      pinned_source_sha256: pin.source_sha256,
    });
  }
  const executable = librarySqlExecutableText(key, text);
  if (!executable) return fail(CODES.UNRELATED_MUTATION, `${tool.label} is not the reviewed operator package`);
  return ok({ text, executable, source_sha256: sha });
}

/** Manifest checks shared by preflight and apply. */
export async function evaluateLibraryProductionApply(key, input = {}, { root = repoRootFrom(import.meta.url), pin } = {}) {
  const tool = toolFor(key);
  const thePin = pin || loadLibraryProductionPin(key, root);
  const sql = readPinnedLibrarySql(key, root, thePin);
  if (!sql.ok) return sql;
  if (!SHA256_RE.test(String(thePin.expected_live_definition_sha256 || ''))) {
    return fail(CODES.SQL_COLLISION, `${tool.label} production pin has no recorded pre-apply live definition hash yet; run --inspect and record it in a reviewed pin change`);
  }
  if (!homeownerAuthorizationApproved(thePin)) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, `${tool.label} production pin authorization is not an owner approval (it is ${JSON.stringify(String(thePin.authorization ?? null).slice(0, 40))}); a reviewed pin change must record it`);
  }
  const mismatched = [
    ['target_environment', 'production'],
    ['target_component', LIBRARY_PRODUCTION_COMPONENT],
    ['deployment_type', LIBRARY_PRODUCTION_DEPLOYMENT_TYPE],
    ['filename', thePin.filename],
    ['migration_id', thePin.migration_id],
    ['source_sha256', thePin.source_sha256],
    ['expected_live_definition_sha256', thePin.expected_live_definition_sha256],
    ['intended_replacement_sha256', thePin.intended_replacement_sha256],
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

export const resolveLibraryDatabaseUrl = resolveMemberStakeholderDatabaseUrl;

// --- inspect ----------------------------------------------------------------

export async function inspectLibraryProduction(key, { connect, pin, root = repoRootFrom(import.meta.url) }) {
  const thePin = pin || loadLibraryProductionPin(key, root);
  const source = readPinnedLibrarySql(key, root, thePin);
  const client = await connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const state = await readLibrarySqlState(client);
    if (!state.ok) {
      return ok({ read_only: true, migration: key, state_error: { code: state.code, message: state.message }, apply_preconditions_met: false });
    }
    const d = state.details;
    const live = librarySqlLiveHash(key, d);
    const failures = libraryProductionPreconditionFailures(key, d, thePin);
    const applied = live === thePin.intended_replacement_sha256;
    const report = librarySqlReport(d);
    return ok({
      read_only: true,
      migration: key,
      filename: thePin.filename,
      // Aggregate row counts first (no ids, names or paths; informational).
      counts: report.counts,
      source_ok: source.ok,
      ...(source.ok ? {} : { source_error: { code: source.code, message: source.message } }),
      pin_execute: thePin.execute === true,
      current_user: d.current_user,
      session_user: d.session_user,
      admin_login: libraryAdminLogin(thePin),
      prerequisites_missing: report.prerequisites_missing,
      sql90_applied: report.sql90_applied,
      sql29: report.sql29,
      sql30: report.sql30,
      live_definition_sha256: live,
      expected_live_definition_sha256: thePin.expected_live_definition_sha256 ?? null,
      intended_replacement_sha256: thePin.intended_replacement_sha256,
      live_matches_expected: typeof live === 'string' && live === thePin.expected_live_definition_sha256,
      already_applied: applied,
      precondition_failures: failures,
      apply_preconditions_met: source.ok
        && live === thePin.expected_live_definition_sha256
        && !applied
        && failures.length === 0,
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

const consumedFileFor = (key, root, ctx) => ctx.consumedPath || path.join(root, '.deployment-guard', toolFor(key).consumed_file);

/** Cheap checks that must pass before the single-use guard receipt is spent. */
export async function precheckLibraryProductionApply(key, input = {}, ctx = {}) {
  const tool = toolFor(key);
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadLibraryProductionPin(key, root);
  const evaluation = await evaluateLibraryProductionApply(key, input, { root, pin });
  if (!evaluation.ok) return evaluation;
  if (pin.execute !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, `${tool.label} production execute is not authorized by this pin`);
  }
  if (typeof pin.authorization_phrase !== 'string' || !pin.authorization_phrase || input.authorization_phrase !== pin.authorization_phrase) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, `${tool.label} production apply requires the exact authorization phrase`);
  }
  if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
    return fail(CODES.INVALID_MANIFEST, `${tool.label} production apply requires a single-use id`);
  }
  if (loadConsumed(consumedFileFor(key, root, ctx)).consumed.includes(input.one_use_id)) {
    return fail(CODES.RECEIPT_REUSED, 'one_use_id has already been consumed; replay is forbidden', { one_use_id: input.one_use_id });
  }
  return evaluation;
}

export async function executeLibraryProductionApply(key, input = {}, ctx = {}) {
  const tool = toolFor(key);
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadLibraryProductionPin(key, root);
  const evaluation = await precheckLibraryProductionApply(key, input, { ...ctx, root, pin });
  if (!evaluation.ok) return evaluation;
  const consumedFile = consumedFileFor(key, root, ctx);
  const sql = readPinnedLibrarySql(key, root, pin);
  if (!sql.ok) return sql;
  if (typeof ctx.connect !== 'function') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, `${tool.label} production apply requires a database connection factory`);
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
    for (const lockKey of tool.lock_keys) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);

    const before = await readLibrarySqlState(client);
    if (!before.ok) return rollback(before);
    const b = before.details;
    const liveBefore = librarySqlLiveHash(key, b);
    if (liveBefore === pin.intended_replacement_sha256) {
      return rollback(fail(CODES.UNRELATED_MUTATION, `${tool.label} is already in place; refuse re-apply`, { live_definition_sha256: liveBefore }));
    }
    const preFailures = libraryProductionPreconditionFailures(key, b, pin);
    if (preFailures.length) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, `${tool.label} pre-apply conditions are not met`, { failed: preFailures }));
    }
    if (liveBefore !== pin.expected_live_definition_sha256 || liveBefore !== input.live_definition_sha256) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, `${tool.label} live state is not the pinned pre-apply state`, {
        live_definition_sha256: liveBefore,
        expected_live_definition_sha256: pin.expected_live_definition_sha256,
      }));
    }
    const snapshotBefore = await readLibraryUnrelatedSnapshot(client, key);
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);

    await client.query(sql.details.executable);

    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const after = await readLibrarySqlState(client);
    if (!after.ok) return rollback(after);
    const snapshotAfter = await readLibraryUnrelatedSnapshot(client, key);
    const postFailures = libraryProductionPostconditionFailures(key, b, after.details, pin);
    const changed = libraryChangedCategories(snapshotBefore, snapshotAfter);
    if (postFailures.length || changed.length) {
      return rollback(fail(CODES.UNRELATED_MUTATION, `${tool.label} did not leave exactly the reviewed state and nothing else`, {
        failed: postFailures,
        unrelated_changed: changed,
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
        before_hash: liveBefore,
        after_hash: librarySqlLiveHash(key, after.details),
        library_inspect: librarySqlReport(after.details),
        unrelated_catalog_sha256: snapshotAfter.sha256,
        unrelated_catalog_counts: snapshotAfter.counts,
        staging_acceptance: evaluation.details.staging_acceptance,
        result: 'applied',
      },
    });
  } catch (error) {
    if (commitSent) {
      inTx = false;
      return fail(CODES.SQL_COLLISION, `${tool.label} production COMMIT outcome is unknown; re-run --inspect before anything else`, {
        message: String(error?.message || error).slice(0, 300),
      });
    }
    return rollback(fail(CODES.SQL_COLLISION, `${tool.label} production apply failed and was rolled back`, {
      message: String(error?.message || error).slice(0, 300),
    }));
  } finally {
    await client.end().catch(() => {});
    if (committed) {
      try {
        consumeOneUse(consumedFile, input.one_use_id);
      } catch (error) {
        process.stderr.write(`${tool.label} apply COMMITTED; one_use_id ${input.one_use_id} could not be recorded: ${String(error?.message || error).slice(0, 200)}\n`);
      }
    }
  }
}

export { createProductionDatabaseConnect };
