/**
 * Production apply of the release 2026-10-17 SQL (SQL 90 to SQL 101, aws/workflows/sql/9x_*.sql
 * and 10x_*.sql),
 * one migration per run, on the engine shared with the staging guarded executor
 * (release-sql-state.mjs): the same state reader, code-derived fingerprints, predecessor rules,
 * pre- and post-conditions and unrelated-catalog snapshot. The production rules add the pinned
 * admin login and the pin binding (file, hashes, predecessors, environment, component).
 *
 * --inspect is BEGIN READ ONLY ... ROLLBACK with search_path pg_catalog. It reads the catalog
 * and, where a migration declares one, an aggregate COUNT(*) (SQL 94: rows its doc_type rule
 * would refuse): never ids, names, paths or row data.
 *
 * Apply (fail closed): the pin must be execute: true with an owner-approved authorization, a
 * recorded pre-apply live hash and a staging acceptance reference; the receipt, the
 * CHECKSOPS_DEPLOYMENT_GUARD_APPLY flag, the phrase and a single-use id are checked by the CLI
 * (release-sql-production-cli.mjs) before the receipt is spent. One transaction (lock_timeout
 * 5s, advisory locks): the pinned file only; it rolls back unless the intended fingerprint is
 * reached and everything else in schema public (and auth's functions) is unchanged.
 *
 * A spec with production_noop (SQL 100: it records what production already has) must be a
 * strict no-op on production: the precondition production_state_already_intended refuses
 * every apply whose live state is not already the intended fingerprint, and an apply whose
 * live state is the intended one is refused as already in place. So the production tool never
 * runs that file; its read-only --inspect (already_applied true) is the production record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { homeownerAuthorizationApproved } from './homeowner-sql-production-apply.mjs';
import { evaluateProductionGate } from './production.mjs';
import {
  RELEASE_SQL_KEYS,
  readReleaseSqlState,
  readReleaseUnrelatedSnapshot,
  releaseChangedCategories,
  releasePin,
  releaseSharedPostconditionFailures,
  releaseSharedPreconditionFailures,
  releaseSpec,
  releaseSqlExecutableText,
  releaseSqlReport,
} from './release-sql-state.mjs';
import { hashSqlDefinition } from './sql-apply.mjs';
import {
  createProductionDatabaseConnect,
  resolveMemberStakeholderDatabaseUrl,
} from './sql-member-stakeholder-production-apply.mjs';
import { repoRootFrom } from './paths.mjs';

export const RELEASE_PRODUCTION_COMPONENT = 'production-sql';
export const RELEASE_PRODUCTION_DEPLOYMENT_TYPE = 'sql-apply';

/** Per-migration production tool settings, derived from the specs. */
export const RELEASE_PRODUCTION = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => {
  const spec = releaseSpec(key);
  return [key, Object.freeze({
    key,
    label: spec.label,
    pin_rel: spec.production_pin_rel,
    staging_pin: releasePin(key),
    allowed_key: `${key}_production_apply_allowed`,
    lock_keys: Object.freeze([`${key}_release_sql`, `${key}_release_sql_production`]),
    consumed_file: `${spec.script.replace(/-apply$/, '')}-consumed.json`,
    script: spec.script,
    cli: `scripts/deployment-guard/${spec.script}.mjs`,
  })];
})));

const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PG_CATALOG_SEARCH_PATH_SQL = "SELECT set_config('search_path', 'pg_catalog', false)";
const failed = (checks) => checks.filter(([, passed]) => !passed).map(([name]) => name);
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);

const toolFor = (key) => {
  const tool = RELEASE_PRODUCTION[key];
  if (!tool) throw new Error(`unknown release migration ${key}`);
  return tool;
};

export function releaseAdminLogin(pin) {
  const login = pin?.admin_login;
  return typeof login === 'string' && login ? login : null;
}

export function loadReleaseProductionPin(key, root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, toolFor(key).pin_rel), 'utf8'));
}

/** Production pre-apply rule: the pinned login plus the shared rules (and, for a production_noop spec, the intended state already live). */
export function releaseProductionPreconditionFailures(key, state, pin, text) {
  const login = releaseAdminLogin(pin);
  const noop = releaseSpec(key).production_noop === true;
  return [
    ...failed([['login_is_pinned_admin', login !== null && state?.current_user === login && state?.session_user === login]]),
    ...releaseSharedPreconditionFailures(key, state, text),
    ...(noop ? failed([['production_state_already_intended', typeof state?.live_definition_sha256 === 'string'
      && state.live_definition_sha256 === pin?.intended_replacement_sha256]]) : []),
  ];
}

export function releaseProductionPostconditionFailures(key, before, after, pin) {
  const login = releaseAdminLogin(pin);
  return [
    ...releaseSharedPostconditionFailures(key, before, after, pin),
    ...failed([['login_is_pinned_admin', login !== null && after?.current_user === login && after?.session_user === login]]),
  ];
}

/** A pin may only name its migration's file, hashes, predecessors, environment and component. */
function pinBindingFailures(key, pin) {
  const staging = toolFor(key).staging_pin;
  const scalar = [
    ['migration', key],
    ['filename', staging.filename],
    ['migration_id', staging.migration_id],
    ['source_sha256', staging.source_sha256],
    ['staging_pin_commit', staging.commit],
    ['intended_replacement_sha256', staging.intended_replacement_sha256],
    ['target_environment', 'production'],
    ['target_component', RELEASE_PRODUCTION_COMPONENT],
    ['deployment_type', RELEASE_PRODUCTION_DEPLOYMENT_TYPE],
  ].filter(([field, value]) => pin?.[field] !== value).map(([field]) => field);
  const lists = [
    ['predecessors', releaseSpec(key).predecessors || []],
    ['function_identities', [...staging.function_identities]],
  ].filter(([field, value]) => !sameList(pin?.[field], value)).map(([field]) => field);
  return [...scalar, ...lists];
}

/** Pinned source bytes, checked against the pin and the reviewed file shape. */
export function readPinnedReleaseSql(key, root, pin) {
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
  const executable = releaseSqlExecutableText(key, text);
  if (!executable) return fail(CODES.UNRELATED_MUTATION, `${tool.label} is not the reviewed file`);
  return ok({ text, executable, source_sha256: sha });
}

/** Manifest checks shared by preflight and apply (no connection). */
export async function evaluateReleaseProductionApply(key, input = {}, { root = repoRootFrom(import.meta.url), pin } = {}) {
  const tool = toolFor(key);
  const thePin = pin || loadReleaseProductionPin(key, root);
  const sql = readPinnedReleaseSql(key, root, thePin);
  if (!sql.ok) return sql;
  if (!SHA256_RE.test(String(thePin.expected_live_definition_sha256 || ''))) {
    return fail(CODES.SQL_COLLISION, `${tool.label} production pin has no recorded pre-apply live definition hash yet; run --inspect and record it in a reviewed pin change`);
  }
  if (!homeownerAuthorizationApproved(thePin)) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, `${tool.label} production pin authorization is not an owner approval (it is ${JSON.stringify(String(thePin.authorization ?? null).slice(0, 40))}); a reviewed pin change must record it`);
  }
  const mismatched = [
    ['target_environment', 'production'],
    ['target_component', RELEASE_PRODUCTION_COMPONENT],
    ['deployment_type', RELEASE_PRODUCTION_DEPLOYMENT_TYPE],
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

export const resolveReleaseDatabaseUrl = resolveMemberStakeholderDatabaseUrl;

// --- inspect ----------------------------------------------------------------

export async function inspectReleaseProduction(key, { connect, pin, root = repoRootFrom(import.meta.url) }) {
  const thePin = pin || loadReleaseProductionPin(key, root);
  const source = readPinnedReleaseSql(key, root, thePin);
  const text = source.ok ? source.details.text : null;
  const client = await connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const state = await readReleaseSqlState(client, key);
    if (!state.ok) {
      return ok({ read_only: true, migration: key, state_error: { code: state.code, message: state.message }, apply_preconditions_met: false });
    }
    const d = state.details;
    const live = d.live_definition_sha256;
    const failures = releaseProductionPreconditionFailures(key, d, thePin, text);
    const applied = live === thePin.intended_replacement_sha256;
    const report = releaseSqlReport(key, d, text);
    return ok({
      read_only: true,
      migration: key,
      filename: thePin.filename,
      // Aggregate row counts first (informational unless a precondition names one).
      counts: report.counts,
      source_ok: source.ok,
      ...(source.ok ? {} : { source_error: { code: source.code, message: source.message } }),
      pin_execute: thePin.execute === true,
      current_user: d.current_user,
      session_user: d.session_user,
      admin_login: releaseAdminLogin(thePin),
      missing_dependencies: report.prerequisites_missing,
      predecessors: report.predecessors,
      predecessors_applied: d.predecessors_applied === true,
      successors_applied: report.successors_applied,
      release_sql_inspect: report,
      live_definition_sha256: live,
      expected_live_definition_sha256: thePin.expected_live_definition_sha256 ?? null,
      intended_replacement_sha256: thePin.intended_replacement_sha256,
      live_matches_expected: typeof live === 'string' && live === thePin.expected_live_definition_sha256,
      already_applied: applied,
      // SQL 100: the file must change nothing on production; the tool never runs it there.
      ...(releaseSpec(key).production_noop === true ? { production_noop: { required: true, live_is_intended: applied } } : {}),
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
export async function precheckReleaseProductionApply(key, input = {}, ctx = {}) {
  const tool = toolFor(key);
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadReleaseProductionPin(key, root);
  const evaluation = await evaluateReleaseProductionApply(key, input, { root, pin });
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

export async function executeReleaseProductionApply(key, input = {}, ctx = {}) {
  const tool = toolFor(key);
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadReleaseProductionPin(key, root);
  const evaluation = await precheckReleaseProductionApply(key, input, { ...ctx, root, pin });
  if (!evaluation.ok) return evaluation;
  const consumedFile = consumedFileFor(key, root, ctx);
  const sql = readPinnedReleaseSql(key, root, pin);
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

    const before = await readReleaseSqlState(client, key);
    if (!before.ok) return rollback(before);
    const b = before.details;
    const liveBefore = b.live_definition_sha256;
    if (liveBefore === pin.intended_replacement_sha256) {
      return rollback(fail(CODES.UNRELATED_MUTATION, `${tool.label} is already in place; refuse re-apply`, { live_definition_sha256: liveBefore }));
    }
    const preFailures = releaseProductionPreconditionFailures(key, b, pin, sql.details.text);
    if (preFailures.length) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, `${tool.label} pre-apply conditions are not met`, {
        failed: preFailures,
        missing_dependencies: b.prerequisites_missing,
        predecessors: b.predecessors,
      }));
    }
    if (liveBefore !== pin.expected_live_definition_sha256 || liveBefore !== input.live_definition_sha256) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, `${tool.label} live state is not the pinned pre-apply state`, {
        live_definition_sha256: liveBefore,
        expected_live_definition_sha256: pin.expected_live_definition_sha256,
      }));
    }
    const snapshotBefore = await readReleaseUnrelatedSnapshot(client, key);
    await client.query(PG_CATALOG_SEARCH_PATH_SQL);

    await client.query(sql.details.executable);

    await client.query(PG_CATALOG_SEARCH_PATH_SQL);
    const after = await readReleaseSqlState(client, key);
    if (!after.ok) return rollback(after);
    const snapshotAfter = await readReleaseUnrelatedSnapshot(client, key);
    const postFailures = releaseProductionPostconditionFailures(key, b, after.details, pin);
    const changed = releaseChangedCategories(snapshotBefore, snapshotAfter);
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
        after_hash: after.details.live_definition_sha256,
        release_sql_inspect: releaseSqlReport(key, after.details, sql.details.text),
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
