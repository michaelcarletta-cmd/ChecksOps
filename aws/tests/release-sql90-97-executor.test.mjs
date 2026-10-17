/**
 * SQL 90 to SQL 97 (release 2026-10-17, aws/workflows/sql/9x_*.sql) in the staging guarded
 * executor, on the shared engine (scripts/deployment-guard/lib/release-sql-state.mjs):
 *
 *   - the pins: the reviewed bytes, no pre-state yet, the code-derived intended fingerprints,
 *     allowlisted, selectable, packed, and in step with the specs and the production pins;
 *   - the reviewed-file check: every function body parsed; transaction or role control,
 *     an extra or renamed function refuses;
 *   - refusals before connecting: no pre-state, a mismatched pin, the read-live sentinel;
 *   - inspect through the executor is read-only (fake client) and the read-live summary keeps
 *     only the report;
 *   - on PostgreSQL 16 (the real SQL 29 / SQL 30 / SQL 90-97 files, a non-superuser
 *     checksops_admin owning everything, like production), in the release order
 *     29 -> 30 -> 90 -> 91 -> 92 -> 93 -> 94 -> 96 -> 97 -> 95: each inspect is read-only and
 *     reports no precondition failure; apply lands exactly once on the intended fingerprint;
 *     drift between inspect and apply refuses; predecessors are enforced (SQL 90 before SQL 29
 *     and SQL 30, SQL 93 before SQL 90, SQL 96 before SQL 93, SQL 94 before SQL 90); SQL 93
 *     refuses after SQL 96; a file that changes anything else rolls back.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSqlExecutableText,
  releaseStateHash,
  releaseStateText,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL, readLiveSummary } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { stagingExecutorMembers } from '../../scripts/deployment-guard/lib/staging-sql-executor-module.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { MEMBER_A, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-17T12:00:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, fs.readFileSync(path.join(ROOT, PINS[key].filename), 'utf8')])));
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const ORDER = Object.freeze(['sql90', 'sql91', 'sql92', 'sql93', 'sql94', 'sql96', 'sql97', 'sql95']);
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = (key) => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[key].production_pin_rel), 'utf8'));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(key, overrides = {}) {
  const pin = overrides.pin || PINS[key];
  const oneUse = overrides.one_use_id || `${key}-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const rest = { ...overrides };
  delete rest.pin;
  const event = {
    action: 'apply',
    workstream_id: `staging-${RELEASE_SQL_SPECS[key].choice}`,
    branch: 'main',
    commit: pin.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    expected_live_definition_sha256: pin.expected_live_definition_sha256 || READ_LIVE_EXPECTED_SENTINEL,
    one_use_id: oneUse,
    expiry: '2026-10-17T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.one_use_id = oneUse;
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (key, overrides = {}) => releaseEvent(key, { action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL, ...overrides });

function handlerFor(connect, { files = FILES, pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql9097-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: files, releaseSqlPins: { ...PINS, ...pins } });
}
const neverConnect = async () => { throw new Error('should-not-connect'); };

test('pins: the reviewed bytes, pending pre-states, code-derived post-states, selectable, packed and in step with the production pins', () => {
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.deepEqual(RELEASE_SQL_KEYS, ['sql90', 'sql91', 'sql92', 'sql93', 'sql94', 'sql95', 'sql96', 'sql97']);
  for (const key of RELEASE_SQL_KEYS) {
    const pin = PINS[key];
    const spec = RELEASE_SQL_SPECS[key];
    assert.equal(sha(TEXT[key]), pin.source_sha256, key);
    assert.equal(pin.expected_live_definition_sha256, null, key);
    assert.equal(pin.execute, false, key);
    assert.match(pin.intended_replacement_sha256, /^[0-9a-f]{64}$/, key);
    assert.equal(releaseIntendedHash(key, TEXT[key]), pin.intended_replacement_sha256, key);
    assert.equal(sha(releaseStateText(key, releaseIntendedState(key, TEXT[key]))), pin.intended_replacement_sha256, key);
    assert.ok(AUTHORIZED_STAGING_SQL.includes(pin), key);
    assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin, key);
    assert.equal(resolveAuthorizedMigration({ migration_id: pin.migration_id }), pin, key);
    assert.equal(MIGRATIONS[spec.choice], pin, key);
    assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`, key);
    assert.match(workflow, new RegExp(`- ${spec.choice}\\n`), key);
    assert.deepEqual(spec.functions.map((fn) => fn.identity), [...pin.function_identities], key);
    const prod = productionPin(key);
    assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256, key);
    assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256, key);
    assert.deepEqual(prod.predecessors, spec.predecessors, key);
    assert.equal(prod.tooling.staging_workflow_choice, spec.choice, key);
    assert.ok(fs.existsSync(path.join(ROOT, prod.tooling.production_tool)), key);
    assert.ok(fs.existsSync(path.join(ROOT, prod.tooling.runbook)), key);
  }
  // The executor's guard-library closure carries the engine and its specs, and both are packed.
  const { libs } = stagingExecutorMembers(ROOT);
  assert.ok(libs.includes('release-sql-state.mjs') && libs.includes('release-sql-specs.mjs'));
  assert.equal(packed['scripts/deployment-guard/lib/release-sql-state.mjs'], 'lib/release-sql-state.mjs');
  assert.equal(packed['scripts/deployment-guard/lib/release-sql-specs.mjs'], 'lib/release-sql-specs.mjs');
  assert.match(workflow, /node --test aws\/tests\/release-sql90-97-executor\.test\.mjs/);
});

test('reviewed files: every function body parsed; transaction or role control, extra or renamed functions refuse', () => {
  for (const key of RELEASE_SQL_KEYS) {
    const defs = releaseFunctionDefinitions(TEXT[key]);
    assert.deepEqual(Object.keys(defs).sort(), RELEASE_SQL_SPECS[key].functions.map((fn) => /^public\.([a-z0-9_]+)\(/.exec(fn.identity)[1]).sort(), key);
    assert.equal(releaseSqlExecutableText(key, TEXT[key]), TEXT[key], key);
    for (const tail of ['\nCOMMIT;\n', '\nBEGIN;\n', '\nSET ROLE checksops;\n', '\nROLLBACK;\n', '\nSET SESSION AUTHORIZATION checksops;\n']) {
      assert.equal(releaseSqlExecutableText(key, `${TEXT[key]}${tail}`), null, `${key} ${tail.trim()}`);
    }
    assert.equal(releaseSqlExecutableText(key, `${TEXT[key]}\nCREATE OR REPLACE FUNCTION public.zz_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n`), null, key);
  }
  // SQL 90's nested EXECUTE $fn$ ... $body$ ... $fn$ bodies are what pg_proc.prosrc holds.
  const sql90 = releaseFunctionDefinitions(TEXT.sql90);
  assert.match(sql90.aws_save_checkalt_tenant_auto_deposit.prosrc, /^\nDECLARE\n {2}_key text;/);
  assert.equal(sql90.aws_first_invite_allowed.volatility, 'v');
  assert.deepEqual(sql90.aws_is_tenant_member.config, ['row_security=off', 'search_path=public']);
  assert.equal(releaseFunctionDefinitions(TEXT.sql94).aws_tenant_document_doc_type_ok.parallel, 's');
  assert.equal(releaseFunctionDefinitions(TEXT.sql96).aws_tenant_pricing_columns.result, 'text[]');
  // A renamed function is caught by the spec comparison.
  assert.equal(releaseSqlExecutableText('sql97', TEXT.sql97.replaceAll('aws_financial_stepup_log_writer_guard()', 'aws_financial_stepup_log_writer_guard2()')), null);
  // Different file bytes give a different intended fingerprint.
  assert.notEqual(releaseIntendedHash('sql93', TEXT.sql93.replace("'updated_at'", "'updated_at', 'slug'")), PINS.sql93.intended_replacement_sha256);
  // SQL 96 replaces SQL 93's guard; SQL 95 skips what it drops in the unrelated snapshot.
  assert.deepEqual(RELEASE_SQL_SPECS.sql96.supersedes, ['sql93']);
  assert.ok(releaseUnrelatedScope('sql95').skip_functions.includes('public.aws_ingest_shared_check(jsonb)'));
  assert.equal(releaseStateHash('sql95', {}), releaseStateHash('sql95', { functions: {} }));
});

test('apply refuses before connecting: no pre-state, a mismatched pin, the read-live sentinel, an unknown action', async () => {
  for (const key of RELEASE_SQL_KEYS) {
    const noPre = await handlerFor(neverConnect)(releaseEvent(key, { expected_live_definition_sha256: 'a'.repeat(64) }));
    assert.equal(noPre.code, CODES.SQL_COLLISION, key);
    assert.match(noPre.message, /no reviewed pre-apply live definition hash/, key);
    const recorded = Object.freeze({ ...PINS[key], expected_live_definition_sha256: 'b'.repeat(64) });
    const mismatched = await handlerFor(neverConnect, { pins: { [key]: recorded } })(releaseEvent(key, { expected_live_definition_sha256: 'c'.repeat(64) }));
    assert.equal(mismatched.code, CODES.SQL_COLLISION, key);
    assert.match(mismatched.message, /bound to the exact allowlisted pin/, key);
    const sentinel = await handlerFor(neverConnect, { pins: { [key]: recorded } })(releaseEvent(key, { expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
    assert.equal(sentinel.code, CODES.SQL_COLLISION, key);
    const unknown = await handlerFor(neverConnect)(releaseEvent(key, { action: 'verify_data_x' }));
    assert.equal(unknown.ok, false, key);
    // Another file's bytes under this pin.
    const tampered = await handlerFor(neverConnect, { files: { ...FILES, [key]: path.join(ROOT, 'aws/workflows/sql/89_check_intake_items_column_update.sql') } })(inspectEvent(key));
    assert.equal(tampered.code, CODES.SQL_COLLISION, key);
    assert.match(tampered.message, /SHA256 does not match/, key);
  }
});

function recordingConnect() {
  const seen = [];
  return {
    seen,
    connect: async () => ({
      query: async (sql) => {
        seen.push(String(sql));
        const text = String(sql);
        if (/count\(\*\)/.test(text)) return { rows: [{ n: 0 }] };
        if (/current_user::text/.test(text)) return { rows: [{ current_user: 'checksops_admin', session_user: 'checksops_admin' }] };
        return { rows: [] };
      },
      end: async () => {},
    }),
  };
}

test('inspect through the executor is read-only (fake client): BEGIN READ ONLY, only reads, rolled back; read-live keeps the report', async () => {
  for (const key of RELEASE_SQL_KEYS) {
    const rec = recordingConnect();
    const result = await handlerFor(rec.connect)(inspectEvent(key));
    assert.equal(result.ok, true, `${key}: ${JSON.stringify(result)}`);
    const receipt = result.details.receipt;
    assert.equal(receipt.result, 'inspect');
    assert.equal(receipt.before_hash, receipt.after_hash);
    assert.equal(receipt.apply_preconditions_met, false);
    assert.ok(receipt.precondition_failures.length > 0, key);
    assert.equal(rec.seen[0], 'BEGIN READ ONLY');
    assert.ok(rec.seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(rec.seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
    assert.ok(rec.seen.includes('ROLLBACK'));
    const summary = readLiveSummary({ ok: true, details: { ok: true, details: result.details } }, { migration: RELEASE_SQL_SPECS[key].choice, pin: PINS[key] });
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.ok(summary.details.release_sql_inspect, key);
    assert.equal(summary.details.release_sql_inspect.live_definition_sha256, receipt.live_definition_sha256);
    assert.doesNotMatch(JSON.stringify(summary.details), /unrecognized/, key);
  }
});

async function withPg(t, prefix, port, fn) {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await releaseFixture(pg, prefix, port);
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: the release order through the executor: read-only inspects, predecessors, drift, one apply each on the intended fingerprint', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql9097-exec-', 58500, async ({ admin, connectAs, applyPredecessors }) => {
  const seen = [];
  const connect = async () => {
    const client = await connectAs('checksops_admin');
    const query = client.query.bind(client);
    client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
    return client;
  };
  const inspect = async (key) => {
    seen.length = 0;
    const result = await handlerFor(connect)(inspectEvent(key));
    assert.equal(result.ok, true, `${key}: ${JSON.stringify(result)}`);
    assert.equal(seen[0], 'BEGIN READ ONLY', key);
    assert.ok(seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), `${key}: ${JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text)))}`);
    return result.details.receipt;
  };
  const apply = async (key, live, extra = {}) => {
    const pin = Object.freeze({ ...PINS[key], expected_live_definition_sha256: live, ...extra.pin });
    return handlerFor(connect, { pins: { [key]: pin }, files: extra.files || FILES })(releaseEvent(key, { pin }));
  };

  // Before SQL 29 / SQL 30: SQL 90 refuses (its predecessors and SQL 29's helper are missing).
  const early90 = await inspect('sql90');
  assert.deepEqual(early90.release_sql_inspect.predecessors, { sql29: false, sql30: false });
  assert.ok(early90.precondition_failures.includes('predecessors_applied'));
  assert.ok(early90.release_sql_inspect.prerequisites_missing.includes('public.aws_can_manage_mortgage_library(uuid)'));
  const refused90 = await apply('sql90', early90.live_definition_sha256);
  assert.equal(refused90.code, CODES.DEPLOYMENT_COLLISION);
  assert.ok(refused90.details.failed.includes('predecessors_applied'));
  await applyPredecessors();

  // SQL 93 and SQL 94 before SQL 90, SQL 96 before SQL 93: refused.
  for (const [key, missing] of [['sql93', 'sql90'], ['sql94', 'sql90'], ['sql96', 'sql93']]) {
    const r = await inspect(key);
    assert.equal(r.release_sql_inspect.predecessors[missing], false, key);
    assert.ok(r.precondition_failures.includes('predecessors_applied'), key);
    const refused = await apply(key, r.live_definition_sha256);
    assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, key);
  }

  for (const key of ORDER) {
    const r = await inspect(key);
    assert.deepEqual(r.precondition_failures, [], `${key}: ${JSON.stringify(r.release_sql_inspect)}`);
    assert.equal(r.already_applied, false, key);
    assert.ok(Object.values(r.release_sql_inspect.predecessors).every(Boolean), key);
    assert.doesNotMatch(JSON.stringify(r), /Private|example\.invalid|checksopsadmin@/, key);
    if (key === 'sql90') {
      // Drift between the recorded pre-state and the apply refuses.
      await admin.query('GRANT EXECUTE ON FUNCTION public.aws_can_write_tenant(uuid) TO PUBLIC');
      const drifted = await apply(key, r.live_definition_sha256);
      assert.equal(drifted.code, CODES.DEPLOYMENT_COLLISION, key);
      await admin.query('REVOKE EXECUTE ON FUNCTION public.aws_can_write_tenant(uuid) FROM PUBLIC');
    }
    if (key === 'sql92') {
      // Other bytes are refused by the allowlist even when a pin names them (the production
      // test covers the rollback of a file that changes anything outside its scope).
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql92-tampered-'));
      const file = path.join(dir, path.basename(PINS.sql92.filename));
      const tampered = `${TEXT.sql92}\nCREATE TABLE public.zz_unrelated (id int);\n`;
      fs.writeFileSync(file, tampered);
      const refused = await apply(key, r.live_definition_sha256, { files: { ...FILES, sql92: file }, pin: { source_sha256: sha(tampered) } });
      assert.equal(refused.code, CODES.SQL_COLLISION, JSON.stringify(refused));
      const wrongBytes = await apply(key, r.live_definition_sha256, { files: { ...FILES, sql92: file } });
      assert.equal(wrongBytes.code, CODES.SQL_COLLISION, JSON.stringify(wrongBytes));
      assert.equal((await admin.query("SELECT to_regclass('public.zz_unrelated') IS NULL AS gone")).rows[0].gone, true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const applied = await apply(key, r.live_definition_sha256);
    assert.equal(applied.ok, true, `${key}: ${JSON.stringify(applied)}`);
    assert.equal(applied.details.receipt.after_hash, PINS[key].intended_replacement_sha256, key);
    const after = await inspect(key);
    assert.equal(after.already_applied, true, key);
    assert.ok(after.release_sql_inspect.functions.every((row) => row.state === 'intended'), `${key}: ${JSON.stringify(after.release_sql_inspect.functions)}`);
    const again = await apply(key, r.live_definition_sha256);
    assert.equal(again.code, CODES.UNRELATED_MUTATION, key);
    if (key === 'sql96') {
      // Do not re-run SQL 93 after SQL 96.
      const r93 = await inspect('sql93');
      assert.deepEqual(r93.release_sql_inspect.successors_applied, ['sql96']);
      assert.ok(r93.precondition_failures.includes('successors_not_applied'));
    }
  }

  // The applied state behaves as the files say (spot checks; the per-file PG tests cover the rest).
  const asMember = async (fn) => {
    const c = await connectAs('checksops');
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER_A]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  };
  assert.equal(await asMember(async (c) => (await c.query('SELECT public.aws_is_tenant_member($1::uuid) AS ok', [TENANT_A])).rows[0].ok), true);
  await assert.rejects(asMember((c) => c.query(`INSERT INTO public.financial_stepup_log (user_id, action_key, metadata)
    VALUES ($1::uuid, 'deposit.submit', '{"source": "app_financial_totp"}')`, [MEMBER_A])), (error) => error.code === '42501');
  // SQL 93 / SQL 96 column guard: a member may not change partner_code.
  await assert.rejects(asMember((c) => c.query('UPDATE public.tenants SET partner_code = $1 WHERE id = $2', ['x', TENANT_A])), (error) => error.code === '42501');
  const dropped = (await admin.query("SELECT to_regprocedure('public.aws_ingest_shared_check(jsonb)') IS NULL AS gone")).rows[0].gone;
  assert.equal(dropped, true);
}));
