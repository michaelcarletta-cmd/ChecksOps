/**
 * Production apply path for SQL 87 (resolve_check_case tenant scope): its own tool
 * (scripts/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.mjs)
 * and pin (ops/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.json),
 * on the SQL 84-86 engine.
 *
 * The committed pin is pending: authorization "pending", execute false, no recorded
 * production pre-state (expected_live_definition_sha256 null) and no staging acceptance,
 * so evaluate and apply refuse before any connection. The apply tests use an
 * execute-authorized copy (authorized()) with a placeholder staging acceptance and,
 * against PostgreSQL, the pre-state the fixture's inspect read. The PostgreSQL fixture is
 * production-like: the real Supabase migrations, every object owned by the non-superuser
 * login checksops_admin.
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
import { AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE, MORTGAGE_DEFINITION_SHA256 } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { mortgageIntendedFunctionAcl, MORTGAGE_PRODUCTION } from '../../scripts/deployment-guard/lib/mortgage-sql-production-apply.mjs';
import * as sql87 from '../../scripts/deployment-guard/lib/sql87-resolve-check-case-tenant-scope-production-apply.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { main as cli87 } from '../../scripts/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.mjs';
import { CLAIM_A, CLAIM_B, TENANT_A, assertNoSeededPii, caseRolesSql, caseSchemaSql } from './helpers/check-case-sql-pg.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const COMMIT = 'a'.repeat(40);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const FIXTURE_PRE = 'e'.repeat(64);
const SCRIPT = 'scripts/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.mjs';
const PIN_REL = 'ops/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.json';
const COMMITTED = JSON.parse(fs.readFileSync(path.join(ROOT, PIN_REL), 'utf8'));
const STAGING = AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE;
const SQL86_PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/sql86-mortgage-compensation-owner-only-production-apply.json'), 'utf8'));
const FN = 'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const OWNER_APPROVED = 'owner-approved 2026-10-16 in session ("approve applying SQL 87 to production"): test fixture';
/** Execute-authorized copy with a placeholder staging acceptance and pre-state. */
const authorized = (extra = {}) => Object.freeze({
  ...COMMITTED,
  authorization: OWNER_APPROVED,
  execute: true,
  expected_live_definition_sha256: FIXTURE_PRE,
  staging_acceptance: { ...COMMITTED.staging_acceptance, ok: true, reference: STAGING_REF, basis: 'test fixture' },
  ...extra,
});

function manifest(pin, overrides = {}) {
  const fingerprint = { sql: pin.expected_live_definition_sha256 };
  const workstream = 'prod-sql87-check-case-test';
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
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: pin.expected_live_definition_sha256,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `sql87-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-16T12:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql87-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

async function runCli(argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql87-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(input));
  }
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await cli87(file ? [...argv, '--input', file] : argv, env, {
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

test('the production pin is pending: authorization pending, execute false, no recorded pre-state, no staging acceptance; it names SQL 87 exactly and the production RDS; registered for the one-shot', () => {
  assert.equal(COMMITTED.id, 'sql87-resolve-check-case-tenant-scope-production-apply');
  assert.equal(COMMITTED.migration, 'sql87');
  assert.equal(COMMITTED.authorization, 'pending');
  assert.equal(COMMITTED.execute, false);
  assert.equal(COMMITTED.expected_live_definition_sha256, null);
  assert.equal(COMMITTED.production_inspect.status, 'pending');
  assert.equal(COMMITTED.production_inspect.live_definition_sha256, null);
  assert.equal(COMMITTED.staging_acceptance.ok, false);
  assert.equal(COMMITTED.staging_acceptance.reference, null);
  for (const field of ['filename', 'migration_id', 'source_sha256', 'intended_replacement_sha256']) assert.equal(COMMITTED[field], STAGING[field], field);
  assert.equal(COMMITTED.staging_pin_commit, STAGING.commit);
  assert.deepEqual(COMMITTED.function_identities, [...STAGING.function_identities]);
  assert.equal(sha(fs.readFileSync(path.join(ROOT, COMMITTED.filename))), COMMITTED.source_sha256);
  assert.equal(COMMITTED.intended_replacement_sha256, '794dcd33b4cd61d8fc607f8e4f84df0daaf8a655afad2c7794ecf084c3a52a30');
  assert.equal(COMMITTED.authorization_phrase, 'APPLY_RESOLVE_CHECK_CASE_TENANT_SCOPE');
  for (const field of ['rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(COMMITTED[field], SQL86_PIN[field], field);
  assert.deepEqual(COMMITTED.intended_post_state.function_definition_sha256, { resolve_check_case: MORTGAGE_DEFINITION_SHA256[FN] });
  assert.equal(COMMITTED.intended_post_state.function_owner, 'checksops_admin');
  assert.deepEqual(COMMITTED.intended_post_state.function_acl, { resolve_check_case: '{checksops_admin=X/checksops_admin}' });
  const fn = { grantees: [] };
  assert.equal(mortgageIntendedFunctionAcl(COMMITTED, fn), COMMITTED.intended_post_state.function_acl.resolve_check_case);
  assert.equal(sql87.SQL87_PRODUCTION_PIN_REL, PIN_REL);
  assert.equal(MORTGAGE_PRODUCTION.sql87.staging_pin, STAGING);
  assert.deepEqual(ONE_SHOT_TOOLS.sql87, { key: 'sql87', script: SCRIPT, args: [], pin_rel: PIN_REL, allowed_key: 'sql87_production_apply_allowed' });
});

test('the tool is inventoried as GUARDED and its tests run in test:deployment-guard and the deployment-guard workflow', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const rows = JSON.stringify(inventory);
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql87-resolve-check-case-tenant-scope-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql87-production-apply"\]/);
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/sql87-resolve-check-case-executor.test.mjs', 'aws/tests/sql87-resolve-check-case-production-apply.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'ops/production-sql-87-apply.md')));
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8'), /\| `sql87` \| `scripts\/deployment-guard\/sql87-resolve-check-case-tenant-scope-production-apply\.mjs` \(`ops\/production-sql-87-apply\.md`\) \|/);
});

test('the committed (pending) pin is refused before any connection: no pre-state is SQL_COLLISION, a recorded one with authorization pending is PRODUCTION_APPROVAL_REQUIRED', async () => {
  const noPre = await sql87.evaluateSql87ProductionApply(manifest(COMMITTED), { root: ROOT });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  assert.match(noPre.message, /no recorded pre-apply live definition hash/);
  const recorded = { ...COMMITTED, expected_live_definition_sha256: FIXTURE_PRE, staging_acceptance: authorized().staging_acceptance };
  const pendingApproval = await sql87.evaluateSql87ProductionApply(manifest(recorded), { root: ROOT, pin: recorded });
  assert.equal(pendingApproval.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const run = (overrides, pin = authorized()) => sql87.executeSql87ProductionApply(manifest(authorized(), overrides), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal((await sql87.executeSql87ProductionApply(manifest(authorized()), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.SQL_COLLISION, 'the committed pin');
  assert.equal((await run({}, { ...authorized(), staging_acceptance: COMMITTED.staging_acceptance })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({}, { ...authorized(), execute: false })).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await run({ authorization_phrase: 'yes' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({ authorization_phrase: SQL86_PIN.authorization_phrase })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({ one_use_id: 'x' })).code, CODES.INVALID_MANIFEST);
  for (const authorization of ['pending', '', undefined, 'approved']) {
    assert.equal((await run({}, authorized({ authorization }))).code, CODES.PRODUCTION_APPROVAL_REQUIRED, JSON.stringify(authorization));
  }
  // A pin naming another migration's file or post-state is refused.
  for (const forged of [authorized({ filename: SQL86_PIN.filename }), authorized({ intended_replacement_sha256: 'c'.repeat(64) }), authorized({ function_identities: [] })]) {
    const result = await sql87.evaluateSql87ProductionApply(manifest(forged), { root: ROOT, pin: forged });
    assert.equal(result.code, CODES.SQL_COLLISION, JSON.stringify(result));
  }
  const passes = await run({}).catch((error) => error);
  assert.match(String(passes?.message || ''), /should-not-connect/);
});

test('CLI: the committed pin refuses at evaluation; with an authorized copy no receipt is DEPLOYMENT_GUARD_REQUIRED; the receipt is never spent on a wrong phrase, execute false, a wrong owner, a reused id, a missing guard flag or arbitrary SQL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql87-prod-noreceipt-'));
  try {
    const input = path.join(dir, 'sql87.json');
    fs.writeFileSync(input, JSON.stringify(manifest(COMMITTED)));
    const result = spawnSync(process.execPath, [path.join(ROOT, SCRIPT), '--apply', '--input', input], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    });
    const out = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, out);
    assert.match(out, /SQL_COLLISION/);
    assert.doesNotMatch(out, /secretsmanager|ECONNREFUSED|rolled back/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const pin = authorized();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sql87-prod-noreceipt-root-'));
  try {
    const noReceipt = await runCli(['--apply'], {
      input: manifest(pin),
      deps: { pin, enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: empty, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' } }) },
    });
    assert.equal(noReceipt.spent, 0);
    assert.match(noReceipt.out, /DEPLOYMENT_GUARD_REQUIRED/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
  const owned = (filename = pin.filename) => ({ ok: true, details: { receipt: { owned_components: [filename] } } });
  const argv = ['--apply'];
  const phrase = await runCli(argv, { input: manifest(pin, { authorization_phrase: 'yes' }), deps: { pin, enforceScriptGuard: () => owned() } });
  assert.match(phrase.out, /PRODUCTION_APPROVAL_REQUIRED/);
  const notExecutable = await runCli(argv, { input: manifest(pin), deps: { pin: { ...pin, execute: false }, enforceScriptGuard: () => owned() } });
  assert.match(notExecutable.out, /execute is not authorized/);
  const committed = await runCli(argv, { input: manifest(pin), deps: { pin: COMMITTED, enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.match(committed.out, /SQL_COLLISION/);
  assert.doesNotMatch(committed.out, /guard-called/);
  const wrongOwner = await runCli(argv, { input: manifest(pin), deps: { pin, enforceScriptGuard: () => owned(SQL86_PIN.filename) } });
  assert.match(wrongOwner.out, /RECEIPT_MISMATCH/);
  const reusedFile = consumedPath();
  fs.writeFileSync(reusedFile, JSON.stringify({ consumed: ['sql87-prod-reused-id'] }));
  const reused = await runCli(argv, { input: manifest(pin, { one_use_id: 'sql87-prod-reused-id' }), deps: { pin, enforceScriptGuard: () => owned(), consumedPath: reusedFile } });
  assert.match(reused.out, /RECEIPT_REUSED/);
  const noFlag = await runCli(argv, { env: {}, input: manifest(pin), deps: { pin, enforceScriptGuard: () => owned() } });
  assert.match(noFlag.out, /blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1/);
  const arbitrary = await runCli(argv, { input: { ...manifest(pin), sql_text: `GRANT EXECUTE ON FUNCTION ${FN} TO authenticated` }, deps: { pin, enforceScriptGuard: () => owned() } });
  assert.match(arbitrary.out, /arbitrary SQL text is forbidden/);
  for (const r of [phrase, notExecutable, committed, wrongOwner, reused, noFlag, arbitrary]) {
    assert.equal(r.spent, 0);
    assert.doesNotMatch(r.out, /should-not-connect/);
  }
});

test('--inspect reads the secret from the pinned ARN only, never a flag, and never connects when the secret is refused', async () => {
  const asked = [];
  const refused = await runCli(['--inspect', '--password', 'hunter2'], {
    deps: { connect: undefined, getSecretValue: async (id) => { asked.push(id); return 'not json'; } },
  });
  assert.deepEqual(asked, [COMMITTED.admin_secret_arn]);
  assert.match(refused.out, /could not read the production admin secret/);
  assert.doesNotMatch(refused.out, /hunter2|should-not-connect/);
  const otherSecret = await runCli(['--inspect'], {
    deps: { connect: undefined, pin: { ...COMMITTED, admin_secret_arn: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:other' }, getSecretValue: async () => { throw new Error('must not be asked'); } },
  });
  assert.match(otherSecret.out, /not the existing production checksops_admin secret/);
});

test('the real guard: a staging receipt cannot authorize production; a production receipt is spent once and a refusing DB rolls back', async () => {
  const NOW = Date.parse('2026-10-16T12:00:00.000Z');
  const pin = authorized();
  const issue = (root, overrides) => {
    const input = manifest(pin);
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
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql87-prod-staging-receipt-'));
  const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql87-prod-receipt-'));
  try {
    const staging = issue(stagingRoot, { target_environment: 'staging', target_component: 'staging-sql' });
    const refused = await runCli(['--apply'], { input: staging.input, deps: { pin, enforceScriptGuard: guardWith(stagingRoot, staging.receipt) } });
    assert.equal(refused.spent, 0);
    assert.match(refused.out, /RECEIPT_MISMATCH/);
    const prod = issue(prodRoot, {});
    const refusingDb = async () => ({ query: async () => { throw new Error('db-unavailable'); }, end: async () => {} });
    const valid = await runCli(['--apply'], { input: prod.input, deps: { pin, enforceScriptGuard: guardWith(prodRoot, prod.receipt), connect: refusingDb } });
    assert.equal(valid.spent, 1);
    assert.match(valid.out, /rolled back/);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(prodRoot, { recursive: true, force: true });
  }
});

// --- PostgreSQL 16 ---------------------------------------------------------------

const PROD_OWNER = 'checksops_admin';
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK TO)\b/i;

test('PostgreSQL 16: production inspect is read-only and prints no PII or row ids; SQL 87 applies exactly once; a wrong login, drift and collateral changes are refused', { timeout: 300000 }, async (t) => {
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
  const server = startPg('pg-sql87-prod-', 58700);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  try {
    await admin.query(caseRolesSql(PROD_OWNER));
    const setup = await connectAs(PROD_OWNER);
    await setup.query(caseSchemaSql());
    await setup.end();
    const seen = [];
    const connectWith = (user) => async () => {
      const client = await connectAs(user);
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const connect = connectWith(PROD_OWNER);
    const first = await sql87.inspectSql87Production({ connect, pin: COMMITTED, root: ROOT });
    assert.equal(first.ok, true, JSON.stringify(first));
    const d = first.details;
    assert.equal(seen[0], 'BEGIN READ ONLY');
    assert.equal(seen.at(-1), 'ROLLBACK');
    assert.ok(seen.slice(1, -1).every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
    assert.equal(d.read_only, true);
    assert.equal(d.source_ok, true);
    assert.equal(d.pin_execute, false);
    assert.equal(d.pre_state_recorded, false);
    assert.equal(d.apply_preconditions_met, false);
    assert.deepEqual(d.precondition_failures, [], JSON.stringify(d.precondition_failures));
    assert.equal(d.current_user, PROD_OWNER);
    assert.deepEqual(d.owner_roles, [PROD_OWNER]);
    assert.equal(d.authenticated_member_of_owner, false);
    assert.equal(d.functions.resolve_check_case.state, 'case_original');
    assert.match(d.functions.resolve_check_case.definition, /^CREATE OR REPLACE FUNCTION public\.resolve_check_case/);
    assert.equal(d.functions.tg_check_intake_assign_case.definition, undefined, 'only the helper definition is printed');
    assert.equal(d.case_owner.case_owner_safe, true);
    assert.deepEqual(d.case_owners.tg_loss_draft_assign_case, {
      exists: true, rolname: PROD_OWNER, rolsuper: false, security_definer: true, member_of_checksops: false, member_of_authenticated: false, proacl: `{${PROD_OWNER}=X/${PROD_OWNER}}`,
    });
    assert.equal(d.case_owners.resolve_check_case.proacl, `{${PROD_OWNER}=X/${PROD_OWNER},authenticated=X/${PROD_OWNER},service_role=X/${PROD_OWNER}}`);
    assert.deepEqual(d.functions.resolve_check_case.acl_entries_with_grantor, [`authenticated EXECUTE granted by ${PROD_OWNER}`, `service_role EXECUTE granted by ${PROD_OWNER}`]);
    assert.equal(d.case_triggers.assign_case_on_check_intake.calls_function, true);
    // No row data: no PII and no row ids.
    assertNoSeededPii(assert, first, 'production inspect');
    assert.doesNotMatch(JSON.stringify(first), UUID_RE);

    const pin = authorized({ expected_live_definition_sha256: d.live_definition_sha256 });
    const ready = await sql87.inspectSql87Production({ connect, pin, root: ROOT });
    assert.equal(ready.details.apply_preconditions_met, true, JSON.stringify(ready.details.precondition_failures));

    const asSuperuser = await sql87.executeSql87ProductionApply(manifest(pin), { root: ROOT, pin, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
    assert.equal(asSuperuser.code, CODES.DEPLOYMENT_COLLISION);
    assert.ok(asSuperuser.details.failed.includes('login_is_pinned_owner'));
    const apply = (overrides = {}, ctx = {}) => sql87.executeSql87ProductionApply(manifest(pin, overrides), { root: ROOT, pin, connect, consumedPath: consumedPath(), ...ctx });
    await admin.query(`GRANT ${PROD_OWNER} TO authenticated WITH INHERIT FALSE`);
    const member = await apply();
    assert.equal(member.code, CODES.DEPLOYMENT_COLLISION);
    assert.ok(member.details.failed.includes('authenticated_not_member_of_owner'));
    await admin.query(`REVOKE ${PROD_OWNER} FROM authenticated`);
    const owner = await connectAs(PROD_OWNER);
    await owner.query(`REVOKE EXECUTE ON FUNCTION ${FN} FROM service_role`);
    assert.equal((await apply()).code, CODES.DEPLOYMENT_COLLISION, 'drift');
    await owner.query(`GRANT EXECUTE ON FUNCTION ${FN} TO service_role`);
    const text = fs.readFileSync(path.join(ROOT, pin.filename), 'utf8');
    const wrap = (extra) => async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql) === text ? query(`${sql}\n${extra}`, params) : query(sql, params));
      return client;
    };
    const unrelated = await apply({}, { connect: wrap('ALTER TABLE public.check_cases DISABLE ROW LEVEL SECURITY;') });
    assert.equal(unrelated.code, CODES.UNRELATED_MUTATION, JSON.stringify(unrelated));
    assert.deepEqual(unrelated.details.unrelated_changed, ['relations', 'fine_relations_sha256']);
    const trigger = await apply({}, { connect: wrap('ALTER TABLE public.loss_draft_tracking DISABLE TRIGGER assign_case_on_loss_draft;') });
    assert.equal(trigger.code, CODES.UNRELATED_MUTATION);
    assert.ok(trigger.details.unrelated_changed.includes('fine_triggers_sha256'), JSON.stringify(trigger.details));
    assert.equal((await apply({ live_definition_sha256: 'f'.repeat(64) })).code, CODES.SQL_COLLISION);

    const consumed = consumedPath();
    const input = manifest(pin);
    const applied = await sql87.executeSql87ProductionApply(input, { root: ROOT, pin, connect, consumedPath: consumed });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, d.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, pin.intended_replacement_sha256);
    assert.equal(applied.details.receipt.object_owner, PROD_OWNER);
    assert.equal(applied.details.receipt.function_acl_after.resolve_check_case, pin.intended_post_state.function_acl.resolve_check_case);
    const after = await sql87.inspectSql87Production({ connect, pin, root: ROOT });
    assertNoSeededPii(assert, after, 'post-apply inspect');
    assert.doesNotMatch(JSON.stringify(after), UUID_RE);
    assert.equal(after.details.live_definition_sha256, pin.intended_replacement_sha256);
    assert.equal(after.details.already_applied, true);
    assert.equal(after.details.functions.resolve_check_case.matches_migration, true);
    assert.equal(after.details.functions.resolve_check_case.body_matches_migration, true);
    assert.equal((await sql87.executeSql87ProductionApply(input, { root: ROOT, pin, connect, consumedPath: consumed })).code, CODES.RECEIPT_REUSED);
    const reapply = await apply();
    assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
    assert.match(reapply.message, /already in place/);
    const privileges = (await admin.query(`SELECT r, has_function_privilege(r, $1, 'EXECUTE') AS can FROM unnest(ARRAY['authenticated', 'anon', 'service_role', 'checksops']) r`, [FN])).rows;
    assert.ok(privileges.every((row) => row.can === false), JSON.stringify(privileges));
    // The triggers still link, as checksops with no auth.uid().
    const api = await connectAs('checksops');
    const own = (await api.query('INSERT INTO public.check_intake_items (tenant_id, claim_id) VALUES ($1, $2) RETURNING case_id', [TENANT_A, CLAIM_A])).rows[0];
    const foreign = (await api.query('INSERT INTO public.check_intake_items (tenant_id, claim_id) VALUES ($1, $2) RETURNING case_id', [TENANT_A, CLAIM_B])).rows[0];
    assert.match(String(own.case_id), UUID_RE);
    assert.equal(foreign.case_id, null);
    await api.end();
    await owner.end();
  } finally {
    await admin.end();
    server.stop();
  }
});
