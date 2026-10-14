/**
 * Production apply path for SQL 77, 78 and 79 (check stakeholder writes).
 *
 * The pins are the staging executor's pins; the catalog fingerprints and
 * statement checks are the staging executor's own exports. The PostgreSQL 16
 * test builds the real RLS helper schema as it stood before SQL 77, then runs
 * the real production inspect and apply for 77, 78 and 79 in order, with the
 * order, drift and unrelated-change refusals in between.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { refuseUnguardedDeploy } from '../../scripts/deployment-guard/require-guard.mjs';
import {
  DEPENDENCY_LABELS,
  MEMBER_STAKEHOLDER_MIGRATIONS,
  MEMBER_STAKEHOLDER_MIGRATION_ORDER,
  SQL77_SINGLE_STATEMENT_RE,
  evaluateMemberStakeholderProductionApply,
  executeMemberStakeholderProductionApply,
  inspectMemberStakeholderProduction,
  loadAllMemberStakeholderProductionPins,
  readPinnedMemberStakeholderSql,
  readUnrelatedCatalogSnapshot,
} from '../../scripts/deployment-guard/lib/sql-member-stakeholder-production-apply.mjs';
import { loadStagingSqlExecutor, stagingExecutorMembers } from '../../scripts/deployment-guard/lib/staging-sql-executor-module.mjs';
import { main as cliMain } from '../../scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { applyBaseSchema, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs');
const COMMITTED = loadAllMemberStakeholderProductionPins(ROOT);
// The committed pins are execute:false (pending owner review); the apply tests run on execute-authorized copies.
const PINS = Object.fromEntries(Object.entries(COMMITTED).map(([key, pin]) => [key, { ...pin, execute: true }]));
const SQL72_PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/sql72-production-apply.json'), 'utf8'));
const STAGING_RUNS = { sql77: '38574715440', sql78: '38602758947', sql79: '38612871864' };
const COMMIT = 'a'.repeat(40);

function manifest(key, overrides = {}) {
  const pin = PINS[key];
  const fingerprint = { sql: pin.expected_live_definition_sha256 };
  const workstream = `prod-${key}-member-stakeholder-test`;
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: COMMIT,
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: pin.expected_live_definition_sha256,
    live_definition_sha256: pin.expected_live_definition_sha256,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `${key}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-14T20:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql77-79-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

/** Runs the CLI in-process with injected guard/consume/connect; returns its output and how often the receipt was spent. */
async function runCli(argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql77-79-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(input));
  }
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await cliMain(file ? [...argv, '--input', file] : argv, env, {
      root: ROOT,
      consumeReceiptOnce: () => { spent += 1; return { ok: true }; },
      connect: neverConnect,
      consumedPath: consumedPath(),
      ...deps,
    });
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
    if (file) fs.rmSync(file, { force: true });
  }
  return { out: writes.join(''), spent };
}

test('production pins are the staging-applied pins, pending, with distinct phrases and the production RDS', () => {
  const phrases = new Set();
  for (const key of MEMBER_STAKEHOLDER_MIGRATION_ORDER) {
    const pin = COMMITTED[key];
    const spec = MEMBER_STAKEHOLDER_MIGRATIONS[key];
    for (const field of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256']) {
      assert.equal(pin[field], spec.staging_pin[field], `${key} ${field}`);
    }
    assert.equal(pin.staging_pin_commit, spec.staging_pin.commit, key);
    assert.equal(pin.migration, key);
    assert.equal(pin.authorization, 'pending', key);
    assert.equal(pin.execute, false, key);
    assert.equal(pin.target_environment, 'production');
    assert.equal(pin.target_component, 'production-sql');
    assert.equal(pin.deployment_type, 'sql-apply');
    assert.deepEqual(pin.predecessors, [...spec.predecessors], key);
    for (const field of ['rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[field], SQL72_PIN[field], `${key} ${field}`);
    assert.equal(pin.staging_acceptance.ok, true);
    assert.equal(pin.staging_acceptance.reference, `https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/${STAGING_RUNS[key]}`);
    assert.match(pin.authorization_phrase, /^[A-Z_]{12,}$/);
    assert.notEqual(pin.authorization_phrase, SQL72_PIN.authorization_phrase);
    phrases.add(pin.authorization_phrase);
    const text = fs.readFileSync(path.join(ROOT, pin.filename));
    assert.equal(createHash('sha256').update(text).digest('hex'), pin.source_sha256, key);
  }
  assert.equal(phrases.size, 3);
  assert.deepEqual(MEMBER_STAKEHOLDER_MIGRATION_ORDER, ['sql77', 'sql78', 'sql79']);
});

test('the fingerprints and statement checks are the staging executor\'s own', async () => {
  const loaded = await loadStagingSqlExecutor(ROOT);
  const { module: reference } = await importGuardedSqlExecutor();
  for (const name of ['readStakeholderGrantState', 'readPartnerStakeholderRemovalsState', 'readMemberStakeholderWritesState']) {
    assert.equal(typeof loaded[name], 'function', name);
    assert.equal(loaded[name].toString(), reference[name].toString(), name);
  }
  assert.equal(loaded.SQL78_NORMALIZED_STATEMENTS, reference.SQL78_NORMALIZED_STATEMENTS);
  assert.equal(loaded.SQL79_NORMALIZED_STATEMENTS, reference.SQL79_NORMALIZED_STATEMENTS);
  // The copied libraries are exactly what the executor imports.
  assert.deepEqual(stagingExecutorMembers(ROOT).libs, [
    'collection-v2-synthetic-uat-cleanup.mjs', 'errors.mjs', 'function-def-lookup.mjs', 'identity.mjs',
    'sql-apply.mjs', 'sql-executor-auth.mjs', 'tmp-rls-catalog.mjs',
  ]);
  // SQL 77's single-statement check is the executor's expression, character for character.
  const source = fs.readFileSync(path.join(ROOT, 'aws/write-path/guarded-sql-executor/index.mjs'), 'utf8');
  assert.ok(source.includes(`const SQL77_SINGLE_STATEMENT_RE = /${SQL77_SINGLE_STATEMENT_RE.source}/;`));

  for (const key of MEMBER_STAKEHOLDER_MIGRATION_ORDER) {
    const spec = MEMBER_STAKEHOLDER_MIGRATIONS[key];
    const text = fs.readFileSync(path.join(ROOT, PINS[key].filename), 'utf8');
    assert.equal(spec.statementsAllowed(text, loaded), true, key);
    for (const variant of [
      `${text}\nGRANT UPDATE ON TABLE public.check_stakeholders TO authenticated;`,
      text.replace(/TO checksops, authenticated|TO authenticated/, 'TO authenticated, anon'),
      text.replace('public.aws_is_authenticated()', 'true OR public.aws_is_authenticated()'),
    ].filter((variant) => variant !== text)) {
      assert.equal(spec.statementsAllowed(variant, loaded), false, `${key}: ${variant.slice(-80)}`);
    }
    assert.equal((await readPinnedMemberStakeholderSql(ROOT, PINS[key], spec)).ok, true, key);
  }
  // A pin may not point one migration's tool at another migration's file.
  const crossed = await readPinnedMemberStakeholderSql(ROOT, { ...PINS.sql78, migration: 'sql77' }, MEMBER_STAKEHOLDER_MIGRATIONS.sql77);
  assert.equal(crossed.code, CODES.SQL_COLLISION);
  const tampered = await readPinnedMemberStakeholderSql(ROOT, { ...PINS.sql79, source_sha256: 'b'.repeat(64) }, MEMBER_STAKEHOLDER_MIGRATIONS.sql79);
  assert.equal(tampered.code, CODES.SOURCE_RECONCILIATION_REQUIRED);
});

test('evaluation is bound to the exact pin and the production gate', async () => {
  for (const key of MEMBER_STAKEHOLDER_MIGRATION_ORDER) {
    const evaluate = (overrides) => evaluateMemberStakeholderProductionApply(manifest(key, overrides), { root: ROOT, migration: key, pin: PINS[key] });
    assert.equal((await evaluate({})).ok, true, key);
    const wrongHash = await evaluate({ expected_live_definition_sha256: 'b'.repeat(64) });
    assert.equal(wrongHash.code, CODES.SQL_COLLISION);
    assert.deepEqual(wrongHash.details.mismatched, ['expected_live_definition_sha256']);
    for (const live of [undefined, 'c'.repeat(64)]) {
      const result = await evaluate({ live_definition_sha256: live });
      assert.equal(result.code, CODES.SQL_COLLISION);
      assert.deepEqual(result.details.mismatched, ['live_definition_sha256']);
    }
    const otherFile = await evaluate({ filename: PINS[key === 'sql77' ? 'sql78' : 'sql77'].filename });
    assert.equal(otherFile.code, CODES.SQL_COLLISION);
    assert.equal((await evaluate({ target_environment: 'staging' })).code, CODES.SQL_COLLISION);
    assert.equal((await evaluate({ approval: { approved: true, workstream_id: 'someone-else' } })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.equal((await evaluate({ staging_acceptance: { ok: false } })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const otherRun = { ok: true, reference: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/1' };
    assert.equal((await evaluate({ staging_acceptance: otherRun })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    // Another migration's staging run does not accept this one.
    const crossRun = PINS[key === 'sql79' ? 'sql78' : 'sql79'].staging_acceptance;
    assert.equal((await evaluate({ staging_acceptance: crossRun })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.equal((await evaluate({ immediately_before_fingerprint: { sql: 'c'.repeat(64) } })).code, CODES.DEPLOYMENT_COLLISION);
  }
  const unknown = await evaluateMemberStakeholderProductionApply(manifest('sql77'), { root: ROOT, migration: 'sql80' });
  assert.equal(unknown.code, CODES.INVALID_MANIFEST);
});

test('CLI refuses without a receipt (real guard, exit 2) and never connects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql77-79-prod-noreceipt-'));
  try {
    for (const key of MEMBER_STAKEHOLDER_MIGRATION_ORDER) {
      const input = path.join(dir, `${key}.json`);
      fs.writeFileSync(input, JSON.stringify(manifest(key)));
      for (const extra of [{ CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {}]) {
        const result = spawnSync(process.execPath, [CLI, '--migration', key, '--apply', '--input', input], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: dir, ...extra },
        });
        assert.equal(result.status, 2, `${key}: ${result.stdout}${result.stderr}`);
        assert.match(result.stderr, /DEPLOYMENT_GUARD_REQUIRED/);
      }
    }
    const unknown = spawnSync(process.execPath, [CLI, '--migration', 'sql80', '--inspect'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /INVALID_MANIFEST/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI does not spend the receipt on a wrong phrase, execute false, a wrong owner, a reused id, a staging receipt or a missing guard flag', async () => {
  const owned = (key) => ({ ok: true, details: { receipt: { owned_components: [PINS[key].filename] } } });
  for (const key of MEMBER_STAKEHOLDER_MIGRATION_ORDER) {
    const argv = ['--migration', key, '--apply'];
    const phrase = await runCli(argv, { input: manifest(key, { authorization_phrase: 'yes' }), deps: { pin: PINS[key], enforceScriptGuard: () => owned(key) } });
    assert.equal(phrase.spent, 0);
    assert.match(phrase.out, /PRODUCTION_APPROVAL_REQUIRED/);
    // Another migration's phrase is not this one's.
    const otherPhrase = PINS[key === 'sql77' ? 'sql78' : 'sql77'].authorization_phrase;
    const crossPhrase = await runCli(argv, { input: manifest(key, { authorization_phrase: otherPhrase }), deps: { pin: PINS[key], enforceScriptGuard: () => owned(key) } });
    assert.equal(crossPhrase.spent, 0);
    assert.match(crossPhrase.out, /PRODUCTION_APPROVAL_REQUIRED/);

    const committed = await runCli(argv, { input: manifest(key), deps: { enforceScriptGuard: () => owned(key) } });
    assert.equal(committed.spent, 0);
    assert.match(committed.out, /GUARD_APPLY_FORBIDDEN/);
    assert.match(committed.out, /execute is not authorized/);

    const otherKey = key === 'sql79' ? 'sql78' : 'sql79';
    const wrongOwner = await runCli(argv, { input: manifest(key), deps: { pin: PINS[key], enforceScriptGuard: () => owned(otherKey) } });
    assert.equal(wrongOwner.spent, 0);
    assert.match(wrongOwner.out, /RECEIPT_MISMATCH/);
    const noReceipt = await runCli(argv, { input: manifest(key), deps: { pin: PINS[key], enforceScriptGuard: () => ({ ok: true }) } });
    assert.equal(noReceipt.spent, 0);
    assert.match(noReceipt.out, /RECEIPT_MISMATCH/);

    const reusedFile = consumedPath();
    fs.writeFileSync(reusedFile, JSON.stringify({ consumed: [`${key}-prod-reused-id`] }));
    const reused = await runCli(argv, { input: manifest(key, { one_use_id: `${key}-prod-reused-id` }), deps: { pin: PINS[key], enforceScriptGuard: () => owned(key), consumedPath: reusedFile } });
    assert.equal(reused.spent, 0);
    assert.match(reused.out, /RECEIPT_REUSED/);

    const noFlag = await runCli(argv, { env: {}, input: manifest(key), deps: { pin: PINS[key], enforceScriptGuard: () => owned(key) } });
    assert.equal(noFlag.spent, 0);
    assert.match(noFlag.out, /blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1/);

    const arbitrary = await runCli(argv, { input: { ...manifest(key), sql_text: 'DROP TABLE public.check_stakeholders' }, deps: { pin: PINS[key], enforceScriptGuard: () => owned(key) } });
    assert.equal(arbitrary.spent, 0);
    assert.match(arbitrary.out, /arbitrary SQL text is forbidden/);

    for (const r of [phrase, crossPhrase, committed, wrongOwner, noReceipt, reused, noFlag, arbitrary]) assert.doesNotMatch(r.out, /should-not-connect/);
  }
});

test('the real guard: a staging receipt cannot authorize production; a production receipt reaches the pin checks', async () => {
  const NOW = Date.parse('2026-10-14T20:00:00.000Z');
  const issue = (root, key, overrides) => {
    const input = manifest(key);
    const spec = {
      workstream_id: input.workstream_id,
      branch: 'main',
      commit: COMMIT,
      operator: 'owner',
      target_environment: 'production',
      target_component: 'production-sql',
      deployment_type: 'sql-apply',
      owned_components: [PINS[key].filename],
      preflight_live_fingerprint: input.preflight_live_fingerprint,
      ...overrides,
    };
    const lease = acquireLease(root, {
      workstream_id: spec.workstream_id, component: spec.target_component, environment: spec.target_environment, commit: spec.commit, operator: spec.operator,
    }, NOW);
    assert.equal(lease.ok, true, lease.message);
    spec.lease = lease.details.lease;
    const issued = issueReceipt(root, spec, { now: NOW, ttlMs: 15 * 60 * 1000 });
    assert.equal(issued.ok, true, issued.message);
    return { input, receipt: issued.details.receipt };
  };
  const guardWith = (root, receipt) => (spec) => refuseUnguardedDeploy({ ...spec, receipt_path: undefined, receipt }, { root, now: NOW + 1000, env: {} });

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql77-79-prod-staging-receipt-'));
  const staging = issue(stagingRoot, 'sql77', { target_environment: 'staging', target_component: 'staging-sql' });
  const refused = await runCli(['--migration', 'sql77', '--apply'], { input: staging.input, deps: { pin: PINS.sql77, enforceScriptGuard: guardWith(stagingRoot, staging.receipt) } });
  assert.equal(refused.spent, 0);
  assert.match(refused.out, /RECEIPT_MISMATCH/);

  const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql77-79-prod-receipt-'));
  const production = issue(prodRoot, 'sql78', {});
  // The committed pin (execute:false) stops it after the guard, before the receipt is spent.
  const pending = await runCli(['--migration', 'sql78', '--apply'], { input: production.input, deps: { enforceScriptGuard: guardWith(prodRoot, production.receipt) } });
  assert.equal(pending.spent, 0);
  assert.match(pending.out, /GUARD_APPLY_FORBIDDEN/);
  // An execute-authorized pin spends it exactly once, then rolls back at a database that refuses every query.
  const refusingDb = async () => ({ query: async () => { throw new Error('db-unavailable'); }, end: async () => {} });
  const valid = await runCli(['--migration', 'sql78', '--apply'], { input: production.input, deps: { pin: PINS.sql78, enforceScriptGuard: guardWith(prodRoot, production.receipt), connect: refusingDb } });
  assert.equal(valid.spent, 1);
  assert.match(valid.out, /rolled back/);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.rmSync(prodRoot, { recursive: true, force: true });
});

test('apply refuses before connecting without the phrase, a single-use id or execute', async () => {
  for (const key of MEMBER_STAKEHOLDER_MIGRATION_ORDER) {
    const run = (overrides, pin = PINS[key]) => executeMemberStakeholderProductionApply(manifest(key, overrides), {
      root: ROOT, migration: key, pin, pins: PINS, connect: neverConnect, consumedPath: consumedPath(),
    });
    assert.equal((await run({ authorization_phrase: 'yes' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.equal((await run({ one_use_id: 'x' })).code, CODES.INVALID_MANIFEST);
    assert.equal((await run({}, COMMITTED[key])).code, CODES.GUARD_APPLY_FORBIDDEN);
    assert.equal((await run({}, { ...PINS[key], authorization_phrase: '' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  }
});

test('inspect is read-only and reports missing dependencies by name', async () => {
  const seen = [];
  const recording = async () => ({
    end: async () => {},
    query: async (sql) => { seen.push(String(sql)); return { rows: [] }; },
  });
  for (const key of MEMBER_STAKEHOLDER_MIGRATION_ORDER) {
    seen.length = 0;
    const result = await inspectMemberStakeholderProduction({ connect: recording, migration: key, pins: PINS, root: ROOT });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.details.read_only, true);
    assert.equal(result.details.apply_preconditions_met, false);
    assert.deepEqual(result.details.missing_dependencies, MEMBER_STAKEHOLDER_MIGRATIONS[key].dependencies.map((name) => DEPENDENCY_LABELS[name]));
    assert.equal(seen[0], 'BEGIN READ ONLY');
    assert.equal(seen.at(-1), 'ROLLBACK');
    for (const text of seen) {
      assert.match(text, /^(BEGIN READ ONLY|ROLLBACK|SAVEPOINT \w+|RELEASE SAVEPOINT \w+|ROLLBACK TO SAVEPOINT \w+|\s*(SELECT|WITH)\b[\s\S]*)$/, text.slice(0, 80));
    }
  }
  const sql78 = await inspectMemberStakeholderProduction({ connect: recording, migration: 'sql78', pins: PINS, root: ROOT });
  assert.ok(sql78.details.missing_dependencies.includes('primary key or unique constraint on public.shared_checks (check_id, source_tenant_id, target_tenant_id)'));
  assert.equal(sql78.details.predecessors.sql77.applied, false);
});

test('PostgreSQL 16: inspect and apply 77, 78 and 79 in order; order, drift and unrelated changes are refused', { timeout: 300000 }, async (t) => {
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
  const server = startPg('pg-sql77-79-prod-', 55100);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = (user) => async () => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  // Like the production admin login: a non-superuser that owns the tables.
  const connect = connectAs('prod_admin');
  const ctx = (key) => ({ root: ROOT, migration: key, pin: PINS[key], pins: PINS, connect, consumedPath: consumedPath() });
  const inspect = (key) => inspectMemberStakeholderProduction({ connect, migration: key, pins: PINS, root: ROOT });
  const apply = (key, overrides) => executeMemberStakeholderProductionApply(manifest(key, overrides), ctx(key));
  const snapshot = async () => {
    const client = await connect();
    try {
      return await readUnrelatedCatalogSnapshot(client, {});
    } finally {
      await client.end();
    }
  };
  try {
    await applyBaseSchema(admin, { through: 76 });
    await admin.query('CREATE ROLE prod_admin LOGIN NOSUPERUSER');
    await admin.query('GRANT USAGE, CREATE ON SCHEMA public TO prod_admin');
    for (const table of ['check_stakeholders', 'check_intake_items', 'tenants', 'identity_accounts', 'shared_checks']) {
      await admin.query(`ALTER TABLE public.${table} OWNER TO prod_admin`);
    }

    // Before anything: 77 is ready; 78 waits for 77; 79 waits for both and reports the missing table.
    const before = await snapshot();
    const i77 = await inspect('sql77');
    assert.equal(i77.ok, true, JSON.stringify(i77));
    assert.equal(i77.details.live_definition_sha256, PINS.sql77.expected_live_definition_sha256, JSON.stringify(i77.details));
    assert.equal(i77.details.apply_preconditions_met, true, JSON.stringify(i77.details));
    const i78 = await inspect('sql78');
    assert.equal(i78.details.live_definition_sha256, PINS.sql78.expected_live_definition_sha256, JSON.stringify(i78.details));
    assert.equal(i78.details.predecessors.sql77.applied, false);
    assert.deepEqual(i78.details.precondition_failures, []);
    assert.equal(i78.details.apply_preconditions_met, false);
    const i79 = await inspect('sql79');
    assert.deepEqual(i79.details.missing_dependencies, [DEPENDENCY_LABELS.check_partner_stakeholder_removals]);
    assert.equal(i79.details.apply_preconditions_met, false);
    assert.deepEqual((await snapshot()).categories, before.categories, 'inspect changed the catalog');
    const early78 = await apply('sql78');
    assert.equal(early78.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(early78));
    assert.match(early78.message, /must wait until sql77 is applied/);
    const early79 = await apply('sql79');
    assert.equal(early79.code, CODES.DEPLOYMENT_COLLISION);
    assert.match(early79.message, /dependencies are missing/);

    // Production drift: authenticated already has SELECT, so the live hash differs from the pin.
    await admin.query('GRANT SELECT ON public.check_stakeholders TO authenticated');
    const drifted = await inspect('sql77');
    assert.equal(drifted.details.live_matches_expected, false);
    assert.equal(drifted.details.apply_preconditions_met, false);
    assert.equal((await apply('sql77', { live_definition_sha256: PINS.sql77.expected_live_definition_sha256 })).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query('REVOKE SELECT ON public.check_stakeholders FROM authenticated');

    // An unrelated change made inside the apply transaction (an event trigger) rolls everything back.
    await admin.query(`
      CREATE FUNCTION public.sql77_79_sneak() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF tg_tag = 'GRANT' THEN EXECUTE 'ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY'; END IF;
      END $$;
      CREATE EVENT TRIGGER sql77_79_sneak ON ddl_command_end EXECUTE FUNCTION public.sql77_79_sneak();`);
    const sneaky = await apply('sql77');
    assert.equal(sneaky.code, CODES.UNRELATED_MUTATION, JSON.stringify(sneaky));
    assert.ok(sneaky.details.unrelated_changed.includes('relations'), JSON.stringify(sneaky.details));
    await admin.query('DROP EVENT TRIGGER sql77_79_sneak; DROP FUNCTION public.sql77_79_sneak()');
    assert.equal((await inspect('sql77')).details.apply_preconditions_met, true);

    const a77 = await apply('sql77');
    assert.equal(a77.ok, true, JSON.stringify(a77));
    assert.equal(a77.details.receipt.before_hash, PINS.sql77.expected_live_definition_sha256);
    assert.equal(a77.details.receipt.after_hash, PINS.sql77.intended_replacement_sha256);
    assert.equal((await inspect('sql77')).details.already_applied, true);
    const again77 = await apply('sql77');
    assert.equal(again77.code, CODES.UNRELATED_MUTATION);
    assert.match(again77.message, /already in place/);

    const ready78 = await inspect('sql78');
    assert.equal(ready78.details.predecessors.sql77.applied, true);
    assert.equal(ready78.details.apply_preconditions_met, true, JSON.stringify(ready78.details));
    // 79 still waits for 78.
    const still79 = await apply('sql79');
    assert.equal(still79.code, CODES.DEPLOYMENT_COLLISION);
    const a78 = await apply('sql78');
    assert.equal(a78.ok, true, JSON.stringify(a78));
    assert.equal(a78.details.receipt.after_hash, PINS.sql78.intended_replacement_sha256);
    assert.equal((await inspect('sql78')).details.already_applied, true);
    assert.equal((await apply('sql78')).code, CODES.UNRELATED_MUTATION);

    const ready79 = await inspect('sql79');
    assert.equal(ready79.details.live_definition_sha256, PINS.sql79.expected_live_definition_sha256, JSON.stringify(ready79.details));
    assert.deepEqual(ready79.details.predecessors, {
      sql77: { applied: true, live_definition_sha256: PINS.sql77.intended_replacement_sha256, intended_replacement_sha256: PINS.sql77.intended_replacement_sha256 },
      sql78: { applied: true, live_definition_sha256: PINS.sql78.intended_replacement_sha256, intended_replacement_sha256: PINS.sql78.intended_replacement_sha256 },
    });
    assert.equal(ready79.details.apply_preconditions_met, true, JSON.stringify(ready79.details));
    const a79 = await apply('sql79');
    assert.equal(a79.ok, true, JSON.stringify(a79));
    assert.equal(a79.details.receipt.before_hash, PINS.sql79.expected_live_definition_sha256);
    assert.equal(a79.details.receipt.after_hash, PINS.sql79.intended_replacement_sha256);
    const done79 = await inspect('sql79');
    assert.equal(done79.details.already_applied, true);
    assert.equal(done79.details.apply_preconditions_met, false);
    assert.equal((await apply('sql79')).code, CODES.UNRELATED_MUTATION);

    // The member policies, the grant and the table are exactly what staging has.
    const { rows } = await admin.query("SELECT tablename, policyname FROM pg_policies WHERE policyname LIKE 'aws_member_%' ORDER BY 1, 2");
    assert.deepEqual(rows.map((row) => `${row.tablename}.${row.policyname}`), [
      'check_partner_stakeholder_removals.aws_member_delete_check_partner_stakeholder_removals',
      'check_partner_stakeholder_removals.aws_member_insert_check_partner_stakeholder_removals',
      'check_stakeholders.aws_member_delete_check_stakeholders',
      'check_stakeholders.aws_member_insert_check_stakeholders',
    ]);
  } finally {
    await admin.end();
    server.stop();
  }
});
