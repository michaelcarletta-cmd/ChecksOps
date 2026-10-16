/**
 * Production apply tools for SQL 29 and SQL 30
 * (scripts/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.mjs,
 * scripts/deployment-guard/sql30-tenant-documents-doc-type-production-apply.mjs; lib
 * sql29-sql30-library-production-apply.mjs), mirroring the SQL 88/89 tool tests:
 *
 *   - the committed pins are pending (authorization "pending", execute false, no pre-state,
 *     no staging acceptance) and bound to the staging pins and the production RDS;
 *   - evaluate / precheck / apply refuse before connecting (no pre-state, no approval, the
 *     staging acceptance, execute false, the phrase, the single-use id, replay, binding);
 *   - the CLI refuses credential flags and arbitrary SQL, and never spends a receipt or
 *     connects on a refusal; a staging receipt cannot authorize production;
 *   - on PostgreSQL 16: --inspect is BEGIN READ ONLY ... ROLLBACK, reads only aggregate
 *     counts of table rows and changes nothing; an execute-authorized copy applies once as
 *     checksops_admin; the superuser login is refused.
 */
import assert from 'node:assert/strict';
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
import { LIBRARY_SQL_PINS } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  LIBRARY_PRODUCTION,
  evaluateLibraryProductionApply,
  executeLibraryProductionApply,
  inspectLibraryProduction,
  loadLibraryProductionPin,
  precheckLibraryProductionApply,
  readPinnedLibrarySql,
} from '../../scripts/deployment-guard/lib/sql29-sql30-library-production-apply.mjs';
import { main as main29 } from '../../scripts/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.mjs';
import { main as main30 } from '../../scripts/deployment-guard/sql30-tenant-documents-doc-type-production-apply.mjs';
import { libraryFixture, pgSkipReason } from './helpers/library-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEYS = Object.freeze(['sql29', 'sql30']);
const MAINS = Object.freeze({ sql29: main29, sql30: main30 });
const CLIS = Object.freeze({
  sql29: path.join(ROOT, 'scripts/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.mjs'),
  sql30: path.join(ROOT, 'scripts/deployment-guard/sql30-tenant-documents-doc-type-production-apply.mjs'),
});
const COMMITTED = Object.freeze({ sql29: loadLibraryProductionPin('sql29', ROOT), sql30: loadLibraryProductionPin('sql30', ROOT) });
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const COMMIT = 'a'.repeat(40);
const PRE = 'e'.repeat(64);
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;

/** An execute-authorized copy with a recorded pre-state and staging acceptance (test only). */
const authorized = (key, live = PRE, extra = {}) => Object.freeze({
  ...COMMITTED[key],
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
  ...extra,
});

function manifest(key, pin, overrides = {}) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${key}-library-test`;
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
    expected_live_definition_sha256: live,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `${key}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-16T20:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql2930-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

async function runCli(key, argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql2930-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(input));
  }
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await MAINS[key](file ? [...argv, '--input', file] : argv, env, {
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

test('committed pins are pending and bound to the staging pins and the production RDS', () => {
  for (const key of KEYS) {
    const pin = COMMITTED[key];
    const staging = LIBRARY_SQL_PINS[key];
    assert.equal(pin.migration, key);
    assert.equal(pin.authorization, 'pending');
    assert.equal(pin.execute, false);
    assert.equal(pin.expected_live_definition_sha256, null);
    assert.equal(pin.staging_acceptance.ok, false);
    assert.equal(pin.staging_acceptance.reference, null);
    assert.equal(pin.production_inspect.status, 'pending');
    assert.equal(pin.filename, staging.filename);
    assert.equal(pin.migration_id, staging.migration_id);
    assert.equal(pin.source_sha256, staging.source_sha256);
    assert.equal(pin.staging_pin_commit, staging.commit);
    assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
    assert.equal(pin.admin_login, 'checksops_admin');
    assert.equal(pin.rds_identifier, 'checksops-production');
    assert.match(pin.admin_secret_arn, /^arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials\/checksops-production\/checksops_admin\//);
    assert.equal(LIBRARY_PRODUCTION[key].pin_rel, `ops/deployment-guard/${pin.id}.json`);
    assert.equal(readPinnedLibrarySql(key, ROOT, pin).ok, true);
  }
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const rows = JSON.stringify(inventory);
  assert.match(rows, /sql29-mortgage-ops-library-parity-production-apply\.mjs/);
  assert.match(rows, /sql30-tenant-documents-doc-type-production-apply\.mjs/);
});

test('a tampered pin or file is refused', () => {
  for (const key of KEYS) {
    for (const field of ['filename', 'source_sha256', 'intended_replacement_sha256', 'target_environment', 'staging_pin_commit']) {
      const bad = { ...COMMITTED[key], [field]: field === 'target_environment' ? 'staging' : 'x' };
      const result = readPinnedLibrarySql(key, ROOT, bad);
      assert.equal(result.code, CODES.SQL_COLLISION, `${key} ${field}`);
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sql2930-tamper-'));
  try {
    const pin = COMMITTED.sql30;
    fs.mkdirSync(path.join(tmp, path.dirname(pin.filename)), { recursive: true });
    fs.writeFileSync(path.join(tmp, pin.filename), `${fs.readFileSync(path.join(ROOT, pin.filename), 'utf8')}\nSELECT 1;\n`);
    assert.equal(readPinnedLibrarySql('sql30', tmp, pin).code, CODES.SOURCE_RECONCILIATION_REQUIRED);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('evaluate, precheck and apply refuse before connecting', async () => {
  for (const key of KEYS) {
    const committed = await evaluateLibraryProductionApply(key, manifest(key, { ...COMMITTED[key], expected_live_definition_sha256: PRE }), { root: ROOT, pin: COMMITTED[key] });
    assert.equal(committed.code, CODES.SQL_COLLISION, key);
    assert.match(committed.message, /no recorded pre-apply live definition hash/);
    const pendingWithPre = { ...COMMITTED[key], expected_live_definition_sha256: PRE };
    const notApproved = await evaluateLibraryProductionApply(key, manifest(key, pendingWithPre), { root: ROOT, pin: pendingWithPre });
    assert.equal(notApproved.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const pin = authorized(key);
    const good = await evaluateLibraryProductionApply(key, manifest(key, pin), { root: ROOT, pin });
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.details[LIBRARY_PRODUCTION[key].allowed_key], true);
    const wrongLive = await evaluateLibraryProductionApply(key, manifest(key, pin, { live_definition_sha256: 'f'.repeat(64) }), { root: ROOT, pin });
    assert.equal(wrongLive.code, CODES.SQL_COLLISION);
    const wrongStaging = await evaluateLibraryProductionApply(key, manifest(key, pin, { staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }), { root: ROOT, pin });
    assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const noApproval = await evaluateLibraryProductionApply(key, manifest(key, pin, { approval: null }), { root: ROOT, pin });
    assert.equal(noApproval.ok, false);

    const ctx = { root: ROOT, pin, consumedPath: consumedPath(), connect: neverConnect };
    const executeFalse = await executeLibraryProductionApply(key, manifest(key, pin), { ...ctx, pin: authorized(key, PRE, { execute: false }) });
    assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN);
    const wrongPhrase = await executeLibraryProductionApply(key, manifest(key, pin, { authorization_phrase: 'APPLY' }), ctx);
    assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const noOneUse = await executeLibraryProductionApply(key, manifest(key, pin, { one_use_id: 'x' }), ctx);
    assert.equal(noOneUse.code, CODES.INVALID_MANIFEST);
    const spentPath = consumedPath();
    fs.writeFileSync(spentPath, JSON.stringify({ consumed: ['reused-id-0001'] }));
    const replay = await precheckLibraryProductionApply(key, manifest(key, pin, { one_use_id: 'reused-id-0001' }), { root: ROOT, pin, consumedPath: spentPath });
    assert.equal(replay.code, CODES.RECEIPT_REUSED);
  }
});

test('CLI: credential flags and arbitrary SQL are refused; pending pins stop before the guard; no receipt is spent and nothing connects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql2930-cli-'));
  try {
    for (const key of KEYS) {
      for (const flag of ['--password=x', '--database-url=postgresql://u:p@h/d', '--host=h', '--user=u', '--secret-arn=x']) {
        const result = spawnSync(process.execPath, [CLIS[key], '--inspect', flag], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
        assert.notEqual(result.status, 0, flag);
        assert.match(`${result.stdout}${result.stderr}`, /credential flags are refused/, flag);
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secretsmanager|ECONNREFUSED/i, flag);
      }
      const committed = await runCli(key, ['--apply'], { input: manifest(key, { ...COMMITTED[key], expected_live_definition_sha256: PRE }), deps: { enforceScriptGuard: () => { throw new Error('guard-called'); } } });
      assert.equal(committed.spent, 0);
      assert.match(committed.out, /SQL_COLLISION/);
      assert.doesNotMatch(committed.out, /guard-called|should-not-connect/);
      const sqlText = await runCli(key, ['--apply'], { input: { ...manifest(key, authorized(key)), sql_text: 'DROP TABLE x' }, deps: { pin: authorized(key) } });
      assert.match(sqlText.out, /arbitrary SQL text is forbidden/);
      const emptyRoot = fs.mkdtempSync(path.join(dir, 'noreceipt-'));
      const noReceipt = await runCli(key, ['--apply'], {
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: emptyRoot, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' } }) },
      });
      assert.equal(noReceipt.spent, 0);
      assert.match(noReceipt.out, /DEPLOYMENT_GUARD_REQUIRED/);
      const noFlag = await runCli(key, ['--apply'], {
        env: {},
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: () => ({ ok: true, details: { receipt: { owned_components: [COMMITTED[key].filename] } } }) },
      });
      assert.equal(noFlag.spent, 0);
      assert.match(noFlag.out, /GUARD_APPLY_FORBIDDEN/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real guard: a staging receipt cannot authorize production; a production receipt is spent once and a refusing DB rolls back', async () => {
  const NOW = Date.parse('2026-10-16T20:00:00.000Z');
  for (const key of KEYS) {
    const pin = authorized(key);
    const issue = (root, overrides) => {
      const input = manifest(key, pin);
      const spec = {
        workstream_id: input.workstream_id,
        branch: 'main',
        commit: COMMIT,
        operator: 'owner',
        target_environment: 'production',
        target_component: 'production-sql',
        deployment_type: 'sql-apply',
        owned_components: [pin.filename],
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
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${key}-staging-receipt-`));
    const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${key}-prod-receipt-`));
    try {
      const staging = issue(stagingRoot, { target_environment: 'staging', target_component: 'staging-sql' });
      const refused = await runCli(key, ['--apply'], { input: staging.input, deps: { pin, enforceScriptGuard: guardWith(stagingRoot, staging.receipt) } });
      assert.equal(refused.spent, 0);
      assert.match(refused.out, /RECEIPT_MISMATCH/);
      const prod = issue(prodRoot, {});
      const refusingDb = async () => ({ query: async () => { throw new Error('db-unavailable'); }, end: async () => {} });
      const valid = await runCli(key, ['--apply'], { input: prod.input, deps: { pin, enforceScriptGuard: guardWith(prodRoot, prod.receipt), connect: refusingDb } });
      assert.equal(valid.spent, 1);
      assert.match(valid.out, /rolled back/);
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      fs.rmSync(prodRoot, { recursive: true, force: true });
    }
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
  const fx = await libraryFixture(pg, prefix, port);
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: inspect is read-only and counts only; an authorized copy applies once as checksops_admin; the superuser is refused', { timeout: 300000 }, async (t) => withPg(t, 'pg-sql2930-prod-', 57600, async ({ admin, connectAs }) => {
  await admin.query(`INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name, shared_with_homeowners)
    VALUES ('11111111-1111-4111-8111-111111111111', 'w9', 'https://x.supabase.co/storage/v1/object/sign/tenant-documents/a/w9.pdf', 'Private W-9.pdf', true),
           ('11111111-1111-4111-8111-111111111111', 'license', '11111111-1111-4111-8111-111111111111/library/mortgage/l.pdf', 'Private License.pdf', false)`);
  const seen = [];
  const connectWith = (user) => async () => {
    const client = await connectAs(user);
    const query = client.query.bind(client);
    client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
    return client;
  };
  const connect = connectWith('checksops_admin');
  for (const key of KEYS) {
    seen.length = 0;
    const inspected = await inspectLibraryProduction(key, { connect, pin: COMMITTED[key], root: ROOT });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const d = inspected.details;
    assert.equal(d.read_only, true);
    assert.equal(d.source_ok, true);
    assert.equal(d.pin_execute, false);
    assert.equal(d.apply_preconditions_met, false, 'no recorded pre-state');
    assert.deepEqual(d.precondition_failures, []);
    assert.deepEqual(d.counts.tenant_documents_by_category, { legacy: 2, mortgage: 0, template: 0, shingle: 0, siding: 0, catalog: 0, letterhead: 0, library_other: 0, other: 0 });
    assert.deepEqual(d.counts.tenant_documents_by_path_form, { aws_library: 1, url: 1, bucket_prefixed: 0, other_tenant_library: 0, other: 0 });
    assert.equal(d.counts.shared_with_homeowners_true, 1);
    assert.equal(d.counts.mortgage_request_library_documents, 0);
    assert.equal(d.sql30.check_shape, 'predecessor_6');
    assert.match(d.sql30.check_definition_sha256, /^[0-9a-f]{64}$/);
    // SQL 29 runs first: before it only the Lovable trigger function exists.
    assert.equal(d.sql29.functions_present, key === 'sql29' ? 1 : 5);
    assert.equal(seen[0], 'BEGIN READ ONLY');
    assert.equal(seen.at(-1), 'ROLLBACK');
    assert.ok(seen.slice(1, -1).every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
    assert.doesNotMatch(JSON.stringify(d), /Private|supabase\.co/);

    const pin = authorized(key, d.live_definition_sha256);
    const asSuper = await executeLibraryProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
    assert.equal(asSuper.code, CODES.DEPLOYMENT_COLLISION);
    assert.ok(asSuper.details.failed.includes('login_is_pinned_admin'));
    const applied = await executeLibraryProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, pin.intended_replacement_sha256);
    const after = await inspectLibraryProduction(key, { connect, pin, root: ROOT });
    assert.equal(after.details.already_applied, true);
    const replay = await executeLibraryProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(replay.code, CODES.UNRELATED_MUTATION);
  }
}));
