/**
 * Production apply path for SQL 77, 78 and 79 (check stakeholder writes).
 *
 * The pins are the staging executor's pins, except SQL 77's pre/post hashes:
 * production's checksops already held INSERT, UPDATE and DELETE (inspect
 * 2026-10-15, SSM ca4ad39d), so SQL 77 and SQL 79 use production variants of
 * the staging rules. The catalog fingerprints and statement checks are the
 * staging executor's own exports. The PostgreSQL 16 test builds the real RLS
 * helper schema as it stood in production before SQL 77, then runs
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
  PRODUCTION_PREEXISTING_UPDATE_ENTRIES,
  SQL77_SINGLE_STATEMENT_RE,
  evaluateMemberStakeholderProductionApply,
  executeMemberStakeholderProductionApply,
  inspectMemberStakeholderProduction,
  loadAllMemberStakeholderProductionPins,
  readPinnedMemberStakeholderSql,
  readUnrelatedCatalogSnapshot,
} from '../../scripts/deployment-guard/lib/sql-member-stakeholder-production-apply.mjs';
import { stakeholderGrantStateText } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
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

test('production pins are the staging-applied pins (SQL 77 hashes aside), pending, with distinct phrases and the production RDS', () => {
  const phrases = new Set();
  for (const key of MEMBER_STAKEHOLDER_MIGRATION_ORDER) {
    const pin = COMMITTED[key];
    const spec = MEMBER_STAKEHOLDER_MIGRATIONS[key];
    // SQL 77's production pre/post hashes differ from staging's (production_inspect in the pin).
    const hashFields = key === 'sql77' ? [] : ['expected_live_definition_sha256', 'intended_replacement_sha256'];
    for (const field of ['filename', 'migration_id', 'source_sha256', ...hashFields]) {
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

const sha = (text) => createHash('sha256').update(text).digest('hex');
const privileges = (granted) => Object.fromEntries(['SELECT', 'INSERT', 'UPDATE', 'DELETE'].map((p) => [p, granted.includes(p) ? 'granted' : 'absent']));
const ALL4 = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const SID = ['SELECT', 'INSERT', 'DELETE'];

test('SQL 77 production pin: production inspect pre-state, code-derived post-state, staging pin untouched', () => {
  const pin = COMMITTED.sql77;
  const staging = MEMBER_STAKEHOLDER_MIGRATIONS.sql77.staging_pin;
  // The production inspect (SSM ca4ad39d): checksops all four, authenticated nothing.
  assert.equal(pin.expected_live_definition_sha256, '8f2417b5a97dd330185de62de29658c9a04a8b6d70672c0df7494834597ad57e');
  assert.equal(pin.expected_live_definition_sha256, sha(stakeholderGrantStateText({ checksops: privileges(ALL4), authenticated: privileges([]) })));
  // After the unchanged file: checksops keeps all four, authenticated gains S/I/D only.
  assert.equal(pin.intended_replacement_sha256, '0cd3ab3fd41245ad9f35e882dc32bcb36cd9720132f63ad88728df655290ddac');
  assert.equal(pin.intended_replacement_sha256, sha(stakeholderGrantStateText({ checksops: privileges(ALL4), authenticated: privileges(SID) })));
  assert.equal(pin.production_inspect.ssm_command_id, 'ca4ad39d');
  assert.equal(pin.production_inspect.date, '2026-10-15');
  assert.equal(pin.production_inspect.live_definition_sha256, pin.expected_live_definition_sha256);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(staging.expected_live_definition_sha256, '714659325ea58a54fdc2ad39b35224308f8f9df92629c3c53b8e3c6fe3faa4e7');
  assert.equal(staging.intended_replacement_sha256, 'e4d49fface305abc732bb225824e4f113e4a0a6ef4f5f2a145bdf3b0324043d1');
  assert.notEqual(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.notEqual(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.deepEqual(PRODUCTION_PREEXISTING_UPDATE_ENTRIES, ['public.check_stakeholders checksops UPDATE']);
});

test('SQL 77 and SQL 79 production rules accept only the production pre-state', () => {
  const s77 = MEMBER_STAKEHOLDER_MIGRATIONS.sql77;
  const s79 = MEMBER_STAKEHOLDER_MIGRATIONS.sql79;
  const pin = COMMITTED.sql77;
  const production = (overrides = {}) => ({
    checksops_check_stakeholders_entries: ALL4.map((p) => `public.check_stakeholders checksops ${p} granted by prod_admin`).sort(),
    update_entries: ['public.check_stakeholders checksops UPDATE'],
    ...overrides,
  });
  const pre77 = (overrides = {}) => ({
    table_present: true, rls_enabled: true, write_policy_present: true, write_policy_as_expected: true,
    other_write_policy_count: 0, grantee_bypasses_rls: false, tenant_guard_ok: true, update_granted: true,
    privilege_state: { checksops: privileges(ALL4), authenticated: privileges([]) },
    preserved_acl_sha256: 'c40af23bab9eabcb08ec6c43f00b5e45cf66e7d09892ac8f7d0227136625e43f',
    live_definition_sha256: pin.expected_live_definition_sha256,
    production: production(),
    ...overrides,
  });
  assert.deepEqual(s77.preconditionFailures(pre77()), []);
  const refused77 = [
    [{ privilege_state: { checksops: privileges(ALL4), authenticated: privileges(['SELECT']) } }, 'authenticated_holds_none'],
    [{ privilege_state: { checksops: privileges(['SELECT']), authenticated: privileges([]) } }, 'checksops_holds_select_insert_update_delete'],
    [{ privilege_state: { checksops: privileges(SID), authenticated: privileges([]) } }, 'checksops_holds_select_insert_update_delete'],
    [{ other_write_policy_count: 1, tenant_guard_ok: false }, 'no_other_write_policy'],
    [{ rls_enabled: false, tenant_guard_ok: false }, 'rls_enabled'],
    [{ write_policy_as_expected: false, tenant_guard_ok: false }, 'write_policy_as_expected'],
    [{ grantee_bypasses_rls: true, tenant_guard_ok: false }, 'grantee_does_not_bypass_rls'],
    [{ production: production({ update_entries: ['public.check_stakeholders checksops UPDATE with grant option'] }) }, 'update_only_checksops_without_grant_option'],
    [{ production: production({ update_entries: ['public.check_stakeholders PUBLIC UPDATE', 'public.check_stakeholders checksops UPDATE'] }) }, 'update_only_checksops_without_grant_option'],
    [{ production: undefined }, 'update_only_checksops_without_grant_option'],
  ];
  for (const [overrides, name] of refused77) {
    assert.ok(s77.preconditionFailures(pre77(overrides)).includes(name), `${name}: ${JSON.stringify(overrides)}`);
  }
  const post77 = (overrides = {}) => pre77({
    privilege_state: { checksops: privileges(ALL4), authenticated: privileges(SID) },
    live_definition_sha256: pin.intended_replacement_sha256,
    ...overrides,
  });
  assert.deepEqual(s77.postconditionFailures(pre77(), post77(), pin), []);
  const refusedPost77 = [
    [{ privilege_state: { checksops: privileges(ALL4), authenticated: privileges(ALL4) } }, 'authenticated_select_insert_delete_only'],
    [{ privilege_state: { checksops: privileges(SID), authenticated: privileges(SID) } }, 'checksops_unchanged'],
    // Same privileges, but a second grantor's entries appeared for checksops.
    [{ production: production({ checksops_check_stakeholders_entries: [...production().checksops_check_stakeholders_entries, 'public.check_stakeholders checksops SELECT granted by other_admin'].sort() }) }, 'checksops_unchanged'],
    [{ production: production({ update_entries: ['public.check_stakeholders authenticated UPDATE', 'public.check_stakeholders checksops UPDATE'] }) }, 'update_only_checksops_without_grant_option'],
    [{ preserved_acl_sha256: 'd'.repeat(64) }, 'other_acl_entries_unchanged'],
    [{ live_definition_sha256: 'e'.repeat(64) }, 'intended_state'],
  ];
  for (const [overrides, name] of refusedPost77) {
    assert.ok(s77.postconditionFailures(pre77(), post77(overrides), pin).includes(name), `${name}: ${JSON.stringify(overrides)}`);
  }

  const pin79 = COMMITTED.sql79;
  const pre79 = (overrides = {}) => ({
    tables_present: true, rls_enabled: true, required_roles_present: true, reviewed_policies_as_expected: true,
    member_policy_states: {}, other_policy_count: 0, functions_as_expected: true, required_functions_present: true,
    functions_executable: true, grantee_bypasses_rls: false,
    // The staging reader's own view of production: checksops' UPDATE trips both.
    update_granted: true, tenant_guard_ok: false,
    acl_sha256: 'a'.repeat(64), live_definition_sha256: pin79.expected_live_definition_sha256,
    production: production(),
    ...overrides,
  });
  assert.deepEqual(s79.preconditionFailures(pre79()), []);
  for (const [overrides, name] of [
    [{ production: production({ update_entries: ['public.check_partner_stakeholder_removals authenticated UPDATE', 'public.check_stakeholders checksops UPDATE'] }) }, 'update_only_checksops_without_grant_option'],
    [{ production: production({ update_entries: [] }) }, 'update_only_checksops_without_grant_option'],
    [{ other_policy_count: 1 }, 'no_other_policies'],
    [{ rls_enabled: false }, 'rls_enabled'],
    [{ reviewed_policies_as_expected: false }, 'reviewed_policies_as_expected'],
    [{ functions_as_expected: false }, 'functions_as_expected'],
    [{ grantee_bypasses_rls: true }, 'grantee_does_not_bypass_rls'],
  ]) {
    assert.ok(s79.preconditionFailures(pre79(overrides)).includes(name), `${name}: ${JSON.stringify(overrides)}`);
  }
  const post79 = pre79({ member_policies_present: true, live_definition_sha256: pin79.intended_replacement_sha256 });
  assert.deepEqual(s79.postconditionFailures(pre79(), post79, pin79), []);
  assert.ok(s79.postconditionFailures(pre79(), { ...post79, acl_sha256: 'b'.repeat(64) }, pin79).includes('acl_unchanged'));
  assert.ok(s79.postconditionFailures(pre79(), { ...post79, production: production({ update_entries: [] }) }, pin79)
    .includes('update_only_checksops_without_grant_option'));
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

    // The staging pre-state (checksops SELECT only) is not production's: the production pin refuses it.
    const stagingState = await inspect('sql77');
    assert.equal(stagingState.details.live_definition_sha256, MEMBER_STAKEHOLDER_MIGRATIONS.sql77.staging_pin.expected_live_definition_sha256);
    assert.equal(stagingState.details.live_matches_expected, false);
    assert.ok(stagingState.details.precondition_failures.includes('checksops_holds_select_insert_update_delete'), JSON.stringify(stagingState.details));
    assert.equal(stagingState.details.apply_preconditions_met, false);
    assert.equal((await apply('sql77')).code, CODES.DEPLOYMENT_COLLISION);

    // The production pre-state (inspect 2026-10-15, SSM ca4ad39d): checksops already holds
    // SELECT, INSERT, UPDATE and DELETE, granted by the table owner; authenticated nothing.
    await admin.query('SET ROLE prod_admin; GRANT INSERT, UPDATE, DELETE ON public.check_stakeholders TO checksops; RESET ROLE');
    const aclOf = async (table) => (await admin.query(`SELECT relacl::text AS acl FROM pg_class WHERE oid = '${table}'::regclass`)).rows[0].acl;
    const preAcl = await aclOf('public.check_stakeholders');
    assert.equal(preAcl, '{prod_admin=arwdDxt/prod_admin,checksops=arwd/prod_admin}');

    // Before anything: 77 is ready; 78 waits for 77; 79 waits for both and reports the missing table.
    const before = await snapshot();
    const i77 = await inspect('sql77');
    assert.equal(i77.ok, true, JSON.stringify(i77));
    assert.equal(i77.details.live_definition_sha256, PINS.sql77.expected_live_definition_sha256, JSON.stringify(i77.details));
    assert.equal(i77.details.apply_preconditions_met, true, JSON.stringify(i77.details));
    assert.deepEqual(i77.details.precondition_failures, []);
    // The staging rule alone would refuse it, exactly as the production inspect did.
    assert.equal(i77.details.state.update_granted, true);
    assert.equal(i77.details.state.tenant_guard_ok, true);
    assert.deepEqual(i77.details.state.production.update_entries, ['public.check_stakeholders checksops UPDATE']);
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

    // Production drift, each refused by inspect and apply, then undone.
    const drifts = [
      // authenticated already has SELECT: the live hash differs from the pin.
      ['GRANT SELECT ON public.check_stakeholders TO authenticated', 'REVOKE SELECT ON public.check_stakeholders FROM authenticated', 'authenticated_holds_none', false],
      // checksops lacks UPDATE (the staging-like state): the live hash differs too.
      ['REVOKE UPDATE ON public.check_stakeholders FROM checksops', 'GRANT UPDATE ON public.check_stakeholders TO checksops', 'checksops_holds_select_insert_update_delete', false],
      // Same hash, but checksops could hand UPDATE on.
      ['GRANT UPDATE ON public.check_stakeholders TO checksops WITH GRANT OPTION', 'REVOKE GRANT OPTION FOR UPDATE ON public.check_stakeholders FROM checksops', 'update_only_checksops_without_grant_option', true],
      // Same hash, but another permissive write policy.
      ['CREATE POLICY sql77_extra ON public.check_stakeholders FOR INSERT TO authenticated WITH CHECK (true)', 'DROP POLICY sql77_extra ON public.check_stakeholders', 'no_other_write_policy', true],
      // Same hash, but row-level security is off.
      ['ALTER TABLE public.check_stakeholders DISABLE ROW LEVEL SECURITY', 'ALTER TABLE public.check_stakeholders ENABLE ROW LEVEL SECURITY', 'rls_enabled', true],
    ];
    for (const [drift, undo, failure, sameHash] of drifts) {
      await admin.query(`SET ROLE prod_admin; ${drift}; RESET ROLE`);
      const drifted = await inspect('sql77');
      assert.equal(drifted.details.live_matches_expected, sameHash, drift);
      assert.ok(drifted.details.precondition_failures.includes(failure), `${drift}: ${JSON.stringify(drifted.details.precondition_failures)}`);
      assert.equal(drifted.details.apply_preconditions_met, false, drift);
      const refused = await apply('sql77');
      assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, `${drift}: ${JSON.stringify(refused)}`);
      await admin.query(`SET ROLE prod_admin; ${undo}; RESET ROLE`);
      assert.equal(await aclOf('public.check_stakeholders'), preAcl, undo);
      assert.equal((await inspect('sql77')).details.apply_preconditions_met, true, undo);
    }

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
    // Only authenticated gained S/I/D; checksops' entry (UPDATE included) is byte-identical.
    assert.equal(await aclOf('public.check_stakeholders'), '{prod_admin=arwdDxt/prod_admin,checksops=arwd/prod_admin,authenticated=ard/prod_admin}');
    const privs = await admin.query(`SELECT r, p, has_table_privilege(r, 'public.check_stakeholders', p) AS has
      FROM unnest(ARRAY['checksops', 'authenticated']) r CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p ORDER BY 1, 2`);
    assert.deepEqual(Object.fromEntries(privs.rows.map((row) => [`${row.r} ${row.p}`, row.has])), {
      'authenticated DELETE': true, 'authenticated INSERT': true, 'authenticated SELECT': true, 'authenticated UPDATE': false,
      'checksops DELETE': true, 'checksops INSERT': true, 'checksops SELECT': true, 'checksops UPDATE': true,
    });
    const done77 = await inspect('sql77');
    assert.equal(done77.details.already_applied, true);
    assert.equal(done77.details.state.preserved_acl_sha256, i77.details.state.preserved_acl_sha256);
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
    // SQL 79's fingerprint holds no ACL, so its pins are staging's; the staging rule alone
    // would refuse production (checksops' UPDATE), the production rule accepts only that UPDATE.
    assert.equal(ready79.details.state.update_granted, true);
    assert.equal(ready79.details.state.tenant_guard_ok, false);
    assert.deepEqual(ready79.details.precondition_failures, []);
    // An extra UPDATE on the SQL 78 table is refused (it also moves SQL 78 off its pin).
    await admin.query('SET ROLE prod_admin; GRANT UPDATE ON public.check_partner_stakeholder_removals TO authenticated; RESET ROLE');
    const extraUpdate = await inspect('sql79');
    assert.ok(extraUpdate.details.precondition_failures.includes('update_only_checksops_without_grant_option'), JSON.stringify(extraUpdate.details.precondition_failures));
    assert.equal(extraUpdate.details.apply_preconditions_met, false);
    assert.equal((await apply('sql79')).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query('SET ROLE prod_admin; REVOKE UPDATE ON public.check_partner_stakeholder_removals FROM authenticated; RESET ROLE');
    assert.equal((await inspect('sql79')).details.apply_preconditions_met, true);
    const a79 = await apply('sql79');
    assert.equal(a79.ok, true, JSON.stringify(a79));
    assert.equal(a79.details.receipt.before_hash, PINS.sql79.expected_live_definition_sha256);
    assert.equal(a79.details.receipt.after_hash, PINS.sql79.intended_replacement_sha256);
    const done79 = await inspect('sql79');
    assert.equal(done79.details.already_applied, true);
    assert.equal(done79.details.apply_preconditions_met, false);
    assert.equal((await apply('sql79')).code, CODES.UNRELATED_MUTATION);
    // checksops still holds UPDATE after the whole chain; nothing else gained it.
    assert.equal(await aclOf('public.check_stakeholders'), '{prod_admin=arwdDxt/prod_admin,checksops=arwd/prod_admin,authenticated=ard/prod_admin}');
    assert.deepEqual(done79.details.state.production.update_entries, ['public.check_stakeholders checksops UPDATE']);

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
