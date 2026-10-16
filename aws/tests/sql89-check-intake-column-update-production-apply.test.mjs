/**
 * Production apply path for SQL 89 (REVOKE UPDATE ON TABLE public.check_intake_items
 * FROM checksops, FROM authenticated and FROM PUBLIC; GRANT UPDATE (<43 columns>) ON
 * TABLE public.check_intake_items TO checksops).
 *
 * The column set is checked against the API source: every SET target of every UPDATE
 * the API issues on the table is granted, and nothing else. The committed pin records
 * the pre-state read by the production --inspect of 2026-10-16 (production_inspect and
 * expected_live_definition_sha256), the guarded staging executor apply run 95 in
 * staging_acceptance and the production apply of 2026-10-16 in applied; it is retired
 * (execute false, authorization "Applied to production …"), so evaluate and apply refuse
 * before any connection. The execute-authorized state it had before the apply (PR #1011)
 * stays tested with an explicit copy (unlocked()); the refusals of the earlier locked state
 * (authorization "pending", execute false, no staging acceptance) with another
 * (pending()); the no-pre-state refusals use an explicit copy with nothing recorded
 * (unrecorded()).
 * The apply tests use an execute-authorized copy
 * with a placeholder staging acceptance and a recorded production_inspect. The
 * PostgreSQL 16 tests build the table owned by a non-superuser checksops_admin: a
 * production-like one (table-level arwd) where the apply lands exactly once, and a
 * staging-like one (column grants) where it converges, and one where checksops is a
 * member of authenticated and inherits UPDATE from authenticated and PUBLIC (staging
 * apply run 85: the old file, revoking only checksops' own UPDATE, fails the
 * postconditions there); afterwards every API UPDATE
 * statement still runs as checksops and a write to a column SQL 89 does not grant
 * fails with 42501.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { refuseUnguardedDeploy } from '../../scripts/deployment-guard/require-guard.mjs';
import {
  AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE as STAGING_PIN,
  SQL89_CANONICAL_STATEMENTS,
  columnUpdateStateText,
  readSql89State,
  sql89StatementText,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  SQL89_COLUMNS,
  SQL89_PRODUCTION_PIN_REL,
  evaluateSql89ProductionApply,
  executeSql89ProductionApply,
  inspectSql89Production,
  loadSql89ProductionPin,
  readPinnedSql89,
  sql89AdminLogin,
  sql89ProductionPostconditionFailures,
  sql89ProductionPreconditionFailures,
} from '../../scripts/deployment-guard/lib/sql89-check-intake-column-update-production-apply.mjs';
import { homeownerAuthorizationApproved } from '../../scripts/deployment-guard/lib/homeowner-sql-production-apply.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { main as cliMain } from '../../scripts/deployment-guard/sql89-check-intake-column-update-production-apply.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import {
  ALL_FIXTURE_COLUMNS,
  NOT_GRANTED_COLUMNS,
  apiUpdateStatements,
  checkIntakeTableSql,
  repoUpdateFunctions,
  updateStatementsInText,
} from './helpers/check-intake-column-update.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/deployment-guard/sql89-check-intake-column-update-production-apply.mjs');
const COMMITTED = loadSql89ProductionPin(ROOT);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const SQL89_TEXT = fs.readFileSync(path.join(ROOT, COMMITTED.filename), 'utf8');
const SQL72_PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/sql72-production-apply.json'), 'utf8'));
const SQL71_PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/sql71-review-amount-production-apply.json'), 'utf8'));
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const ALL_COLUMNS = ALL_FIXTURE_COLUMNS(SQL89_COLUMNS);
const PROD_ACL = '{checksops_admin=arwdDxt/checksops_admin,checksops=arwd/checksops_admin}';
const PROD_ACL_AFTER = '{checksops_admin=arwdDxt/checksops_admin,checksops=ard/checksops_admin}';
const stateHash = (tableLevel, columns) => sha(columnUpdateStateText({ table_level_update: tableLevel, updatable_columns: columns }));
const PROD_PRE = stateHash(true, ALL_COLUMNS);
const INTENDED = STAGING_PIN.intended_replacement_sha256;
const COMMIT = 'a'.repeat(40);

/** An execute-authorized copy with a recorded pre-state and inspect. */
const authorizedPin = ({ live = PROD_PRE, acl = PROD_ACL, columns = ALL_COLUMNS, ...inspect } = {}) => Object.freeze({
  ...COMMITTED,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
  production_inspect: {
    ...COMMITTED.production_inspect,
    status: 'recorded',
    live_definition_sha256: live,
    table_owner: 'checksops_admin',
    table_acl: acl,
    updatable_columns: columns,
    updatable_columns_sha256: sha(columns.join(',')),
    ...inspect,
  },
});
const PIN = authorizedPin();
/** The locked state before the execute change (authorization "pending", execute false, no staging acceptance). */
const PENDING_ACCEPTANCE = Object.freeze({ ok: false, reference: null, basis: 'Pending (test copy of the pre-authorization pin)' });
const pending = (extra = {}) => Object.freeze({
  ...COMMITTED,
  authorization: 'pending',
  execute: false,
  staging_acceptance: { ...COMMITTED.staging_acceptance, ...PENDING_ACCEPTANCE },
  ...extra,
});
/** The execute-authorized state before the apply (PR #1011), as an explicit copy of the retired pin. */
const UNLOCKED_AUTHORIZATION = 'Owner approved 2026-10-16 ("approve the SQL 89 production unlock after the pin PR"; "approve the SQL 89 production apply after unlock"): test copy of the execute-authorized pin before its record-and-retire change';
const unlocked = (extra = {}) => Object.freeze({ ...COMMITTED, authorization: UNLOCKED_AUTHORIZATION, execute: true, ...extra });
// The production apply of 2026-10-16 recorded in applied (its one_use_id is spent).
const APPLIED = Object.freeze({
  apply_ssm_command_id: 'c6c05ba9-dc58-4ab3-bdca-1b9996a7dc77',
  one_use_id: 'sql89-prod-0173e55c-b155-44c8-b9c4-5c221c5f1053',
  workstream_id: 'prod-sql89-check-intake-column-update-20261016',
  source_commit: '72cc069fa1fef0195056bfe4e2f6d7d85a6283b8',
  tarball_sha256: '4d8a553ea8989a7be30671334f143d074b1622eecb7d176c98e166e5a2fc29df',
  steps: ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect'],
});
/** The committed pin (or another) with no recorded pre-state or inspect, for the no-pre-state refusals. */
const unrecorded = (pin = COMMITTED) => Object.freeze({
  ...pin,
  expected_live_definition_sha256: null,
  production_inspect: {
    ...pin.production_inspect,
    status: 'pending',
    live_definition_sha256: null,
    table_owner: null,
    table_acl: null,
    updatable_columns: null,
    updatable_columns_sha256: null,
  },
});
// The read-only production --inspect of 2026-10-16 (SSM command 0435c387-8f9b-405d-9463-f1cc81124d36,
// source main 4701eb23, connected as checksops_admin).
const PRODUCTION_PRE = 'c22a75fa2535712f1ef9b2210a8c3f6bd8576b5b255a9a01c6e352e7369cc8c4';
const PRODUCTION_ACL = '{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin}';
const PRODUCTION_COLUMNS_SHA256 = '9d033c1773679cd362810d44baeb1acec65ec2c1bc85c1fb072fefeaf4c5d5f8';
// The guarded staging SQL executor apply and read-live runs recorded in staging_acceptance
// (main 4701eb23a, executor package deploy run 93, 38929385245).
const STAGING_ACCEPTANCE = Object.freeze({
  reference: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38929944170',
  apply_run: '38929944170',
  read_live_run: '38930128476',
  rolled_back_run: '38921067055',
  executor_code_sha256: 'R+dlQhnD4ZtTyPUfUWGFAn4efOJ8AxdBK2BYozdBbG8=',
  migration: 'sql89-check-intake-column-update',
});

function manifest(overrides = {}, live = PROD_PRE) {
  const fingerprint = { sql: live };
  const workstream = 'prod-sql89-check-intake-column-update-test';
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: COMMIT,
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [PIN.filename],
    filename: PIN.filename,
    migration_id: PIN.migration_id,
    source_sha256: PIN.source_sha256,
    expected_live_definition_sha256: live,
    intended_replacement_sha256: PIN.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: PIN.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: PIN.authorization_phrase,
    one_use_id: `sql89-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-16T20:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql89-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };
/** A manifest bound to the committed pin (its recorded production pre-state and staging acceptance). */
const committedManifest = (overrides = {}) => manifest({ staging_acceptance: COMMITTED.staging_acceptance, ...overrides }, PRODUCTION_PRE);

async function runCli(argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql89-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
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

// --- the column set against the API source -----------------------------------------

test('the 43 columns are exactly the SET targets of the UPDATEs the API issues as checksops', () => {
  assert.equal(SQL89_COLUMNS.length, 43);
  assert.deepEqual([...SQL89_COLUMNS], [...new Set(SQL89_COLUMNS)].sort(), 'sorted and unique');
  const { statements, quoted } = apiUpdateStatements();
  assert.deepEqual(quoted, [], 'no UPDATE of the table outside a template literal');
  const dynamic = statements.filter((s) => s.dynamic).map((s) => s.file);
  // The one statement built at runtime: the generic /data/write path. (The ingest fallback
  // left with the retired Freedom Claims bridge; ingest-shared-check.mjs is deleted.)
  assert.deepEqual(dynamic, ['aws/functions/api/write-check-workflow.mjs']);
  const staticTargets = new Set();
  for (const s of statements.filter((x) => !x.dynamic)) {
    assert.ok(!s.targets.includes(null), `${s.file}:${s.line} has a SET target that is not a column`);
    for (const column of s.targets) {
      assert.ok(SQL89_COLUMNS.includes(column), `${s.file}:${s.line} writes ${column}, which SQL 89 does not grant`);
      staticTargets.add(column);
    }
  }
  assert.ok(statements.length >= 27, String(statements.length));
  // The generic path (write-check-workflow.mjs executeIntakeUpdate) writes only allowlisted
  // columns, plus updated_at = now() (buildSet).
  const generic = [...WRITE_ALLOWLIST.check_intake_items.columns, 'updated_at'];
  for (const column of generic) assert.ok(SQL89_COLUMNS.includes(column), `generic write column ${column}`);
  // Nothing is granted that no path writes.
  assert.deepEqual([...new Set([...staticTargets, ...generic])].sort(), [...SQL89_COLUMNS]);
  // Identity, ownership and system columns are never written and never granted.
  for (const column of ['id', 'tenant_id', 'created_at', 'uploaded_by', 'deposited_by_tenant_id', 'deposited_at', 'claim_id', 'detected_claim_number']) {
    assert.ok(!SQL89_COLUMNS.includes(column), column);
    assert.ok(!staticTargets.has(column), column);
    assert.ok(!WRITE_ALLOWLIST.check_intake_items.columns.has(column), column);
  }
  // SQL 70's ingest was a prerequisite of the (applied) SQL 89 run; the API no longer calls it.
  assert.equal(fs.existsSync(path.join(ROOT, 'aws/functions/api/ingest-shared-check.mjs')), false);
  assert.equal(STAGING_PIN.ingest_function, 'public.aws_ingest_shared_check(jsonb)');
});

const LIVE_SNAPSHOT = 'f78e16d99';
/**
 * The live production API sources: every .mjs of the 2026-10-11 snapshot, plus each
 * overlay member's expected_live and accepted bytes, located in history by sha256.
 * null when the snapshot commit is not in this checkout.
 */
function liveProductionSources() {
  const SNAP = LIVE_SNAPSHOT;
  const git = (...args) => spawnSync('git', ['-C', ROOT, ...args], { maxBuffer: 256 * 1024 * 1024 });
  if (git('cat-file', '-e', `${SNAP}^{commit}`).status !== 0) return null;
  const prefix = 'aws/functions/api/';
  const sources = git('ls-tree', '-r', '--name-only', SNAP, '--', prefix).stdout.toString().split('\n')
    .filter((p) => p.endsWith('.mjs') && !p.includes('node_modules'))
    .map((rel) => ({ label: SNAP, rel, text: git('show', `${SNAP}:${rel}`).stdout.toString() }));
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/production-api-overlay-plan.json'), 'utf8'));
  const missing = [];
  for (const [member, spec] of Object.entries(plan.members)) {
    const rel = prefix + member;
    const want = new Set([spec.expected_live_sha256, spec.accepted_sha256].filter(Boolean));
    const found = new Set();
    const blobs = new Set();
    // The snapshot's own bytes and this checkout's bytes first: a shallow CI checkout can hold
    // the snapshot commit without the history `git log --all` walks. Each is matched by hash.
    for (const [label, bytes] of [
      [SNAP, git('show', `${SNAP}:${rel}`).status === 0 ? git('show', `${SNAP}:${rel}`).stdout : null],
      ['HEAD', fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel)) : null],
    ]) {
      if (!bytes) continue;
      const digest = sha(bytes);
      if (want.has(digest) && !found.has(digest)) {
        found.add(digest);
        sources.push({ label: `${label.slice(0, 8)}:${digest.slice(0, 8)}`, rel, text: bytes.toString() });
      }
    }
    for (const commit of git('log', '--all', '--format=%H', '--', rel).stdout.toString().split('\n').filter(Boolean)) {
      const blob = git('rev-parse', '--verify', '-q', `${commit}:${rel}`).stdout.toString().trim();
      if (!blob || blobs.has(blob)) continue;
      blobs.add(blob);
      const bytes = git('cat-file', 'blob', blob).stdout;
      const digest = sha(bytes);
      if (want.has(digest) && !found.has(digest)) {
        found.add(digest);
        sources.push({ label: digest.slice(0, 8), rel, text: bytes.toString() });
      }
    }
    for (const digest of want) if (!found.has(digest)) missing.push(`${member} ${digest.slice(0, 12)}`);
  }
  return { sources, missing };
}

test('live production API bytes (2026-10-11 snapshot f78e16d99 and every overlay member\'s expected_live and accepted bytes) write only SQL 89 columns', async (t) => {
  const live = liveProductionSources();
  if (!live) {
    t.skip(`commit ${LIVE_SNAPSHOT} is not in this checkout's history`);
    return;
  }
  const { sources, missing } = live;
  const prefix = 'aws/functions/api/';
  assert.deepEqual(missing, [], 'every overlay member hash is in history');
  const dynamic = new Set();
  for (const src of sources) {
    const { statements } = updateStatementsInText(src.text, src.rel);
    for (const s of statements) {
      if (s.dynamic) { dynamic.add(s.file); continue; }
      for (const column of s.targets) assert.ok(SQL89_COLUMNS.includes(column), `${src.label} ${s.file}:${s.line} writes ${column}`);
    }
  }
  assert.deepEqual([...dynamic].sort(), ['aws/functions/api/ingest-shared-check.mjs', 'aws/functions/api/write-check-workflow.mjs']);
  // The generic path in every live write-allowlist.mjs: its check_intake_items columns are SQL 89 columns.
  const flags = path.join(ROOT, prefix, 'workflow-flags.mjs');
  for (const src of sources.filter((s) => s.rel.endsWith('/write-allowlist.mjs'))) {
    const file = path.join(os.tmpdir(), `sql89-live-allowlist-${process.pid}-${src.label}.mjs`);
    fs.writeFileSync(file, src.text.replace(/from '\.\/workflow-flags\.mjs'/g, `from ${JSON.stringify(flags)}`));
    try {
      const mod = await import(file);
      for (const column of mod.WRITE_ALLOWLIST.check_intake_items.columns) assert.ok(SQL89_COLUMNS.includes(column), `${src.label} allowlist ${column}`);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  // Every live ingest still calls SQL 70 first and falls back only when it is missing.
  for (const src of sources.filter((s) => s.rel.endsWith('/ingest-shared-check.mjs'))) {
    assert.match(src.text, /SELECT public\.aws_ingest_shared_check\(\$1::jsonb\)/, src.label);
    assert.match(src.text, /if \(error\?\.code !== '42883'\) throw error;/, src.label);
  }
});

test('every SQL function in the repo that UPDATEs the table is SECURITY DEFINER (runs as its owner, needs no checksops grant)', () => {
  const functions = repoUpdateFunctions();
  assert.ok(functions.length >= 16, String(functions.length));
  assert.deepEqual(functions.filter((f) => !f.security_definer), []);
  const names = new Set(functions.map((f) => f.name));
  for (const name of ['aws_ingest_shared_check', 'review_save_detected_claim_number', 'claim_ledger_link_or_create', 'ocr_commit_results', 'record_check_return', 'admin_override_check_status']) {
    assert.ok(names.has(name), name);
  }
});

// --- pin ------------------------------------------------------------------------

test('production pin: applied and retired (execute false, the 2026-10-16 apply in applied), staging accepted, the recorded production pre-state; bound to the staging pin and the production RDS', () => {
  assert.equal(SQL89_PRODUCTION_PIN_REL, 'ops/deployment-guard/sql89-check-intake-column-update-production-apply.json');
  assert.equal(COMMITTED.migration, 'sql89');
  assert.equal(COMMITTED.execute, false);
  // Retired: the authorization is no longer an owner approval the tool accepts.
  assert.match(COMMITTED.authorization, /^Applied to production on 2026-10-16; execute is false again/);
  assert.equal(homeownerAuthorizationApproved(COMMITTED), false);
  assert.match(COMMITTED.authorization, /That approval covered that run only$/);
  assert.ok(COMMITTED.authorization.includes(`workstream ${APPLIED.workstream_id}`));
  assert.ok(COMMITTED.authorization.includes('"approve the SQL 89 production apply after unlock"'));
  // The production apply of 2026-10-16 (guarded production SQL one-shot).
  const applied = COMMITTED.applied;
  assert.equal(applied.date, '2026-10-16');
  assert.equal(applied.started_at, '2026-10-16T16:59:30Z');
  assert.equal(applied.finished_at, '2026-10-16T16:59:42Z');
  assert.equal(applied.result, 'applied');
  assert.equal(applied.runner, 'i-0c35557c4e5385406');
  assert.equal(applied.apply_ssm_command_id, APPLIED.apply_ssm_command_id);
  assert.equal(applied.source_commit, APPLIED.source_commit);
  assert.deepEqual(applied.source_tarball, { file: `source-${APPLIED.source_commit}.tar.gz`, sha256: APPLIED.tarball_sha256 });
  assert.equal(applied.workstream_id, APPLIED.workstream_id);
  assert.equal(applied.operator, 'michaelcarletta-cmd');
  assert.equal(applied.owner_approval, 'approve the SQL 89 production apply after unlock');
  assert.equal(applied.one_use_id, APPLIED.one_use_id);
  assert.equal(applied.one_use_id_consumed, true);
  assert.deepEqual(applied.steps, APPLIED.steps.map((step) => ({ step, ok: true })));
  assert.deepEqual(applied.receipt, { result: 'applied', before_hash: PRODUCTION_PRE, after_hash: COMMITTED.intended_replacement_sha256 });
  assert.equal(applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(applied.pre_apply_inspect.live_matches_expected, true);
  assert.equal(applied.pre_apply_inspect.apply_preconditions_met, true);
  assert.deepEqual(applied.pre_apply_inspect.precondition_failures, []);
  assert.equal(applied.pre_apply_inspect.table_level_update, true);
  assert.equal(applied.pre_apply_inspect.updatable_column_count, 73);
  assert.equal(applied.post_apply_inspect.live_definition_sha256, COMMITTED.intended_replacement_sha256);
  assert.equal(applied.post_apply_inspect.already_applied, true);
  assert.equal(applied.post_apply_inspect.table_level_update, false);
  assert.equal(applied.post_apply_inspect.updatable_column_count, SQL89_COLUMNS.length);
  assert.equal(applied.post_apply_inspect.columns_losing_update_count, 0);
  // Those two compare live state with the recorded pre-apply inspect, which the apply replaced.
  assert.deepEqual(applied.post_apply_inspect.precondition_failures, ['table_acl_as_inspected', 'updatable_columns_as_inspected']);
  assert.match(COMMITTED.production_evidence['2026-10-16 apply'], /execute is false/);
  // The guarded staging SQL executor apply run (staging pre-state -> the intended post-state).
  assert.equal(COMMITTED.staging_acceptance.ok, true);
  assert.equal(COMMITTED.staging_acceptance.reference, STAGING_ACCEPTANCE.reference);
  assert.match(COMMITTED.staging_acceptance.reference, /^https:\/\/github\.com\/michaelcarletta-cmd\/ChecksOps\/actions\/runs\/\d+$/);
  const { basis, production_differs: differs } = COMMITTED.staging_acceptance;
  assert.ok(basis.startsWith(`Guarded staging SQL executor apply of ${STAGING_ACCEPTANCE.migration}, `));
  assert.ok(basis.includes(`(${STAGING_ACCEPTANCE.apply_run})`));
  assert.ok(basis.includes('read-live run #') && basis.includes(`(${STAGING_ACCEPTANCE.read_live_run})`));
  assert.ok(basis.includes(`${STAGING_PIN.expected_live_definition_sha256} -> ${COMMITTED.intended_replacement_sha256}`));
  assert.ok(basis.includes(STAGING_ACCEPTANCE.executor_code_sha256));
  assert.ok(basis.includes(`(${STAGING_ACCEPTANCE.rolled_back_run})`) && /rolled back \(UNRELATED_MUTATION\)/.test(basis));
  assert.match(basis, /result applied/);
  assert.match(basis, /already_applied true/);
  assert.match(basis, /precondition_failures \[\]/);
  assert.match(basis, /43 updatable columns/);
  assert.match(differs, /pre-states differ/);
  assert.ok(differs.includes(STAGING_PIN.expected_live_definition_sha256));
  assert.ok(differs.includes(PRODUCTION_PRE));
  assert.ok(differs.includes(COMMITTED.intended_replacement_sha256));
  // The note keeps the recorded pre-state and names the change that set execute true.
  assert.match(COMMITTED.production_inspect.note, /SQL 87\/89 production pins: execute-authorized after staging acceptance/);
  // The pre-state recorded from the read-only production inspect, not code-derived.
  const inspect = COMMITTED.production_inspect;
  assert.equal(COMMITTED.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(inspect.live_definition_sha256, COMMITTED.expected_live_definition_sha256);
  assert.notEqual(COMMITTED.expected_live_definition_sha256, COMMITTED.intended_replacement_sha256);
  assert.notEqual(COMMITTED.expected_live_definition_sha256, STAGING_PIN.expected_live_definition_sha256, 'staging records its own pre-state');
  assert.equal(inspect.status, 'recorded');
  assert.equal(inspect.date, '2026-10-16');
  assert.equal(inspect.ssm_command_id, '0435c387-8f9b-405d-9463-f1cc81124d36');
  assert.equal(inspect.source_commit, '4701eb23a52de84b367993b31d7d7c7501b4873a');
  assert.equal(inspect.source_tarball_sha256, 'aefd2eb1db2d6692a2e51eb97a51504988eb60d44dea63f157c4272176cec77f');
  assert.equal(inspect.read_only, true);
  assert.equal(inspect.connected_as, 'checksops_admin');
  assert.equal(inspect.table_owner, 'checksops_admin');
  assert.equal(inspect.table_acl, PRODUCTION_ACL);
  assert.equal(inspect.table_level_update, true);
  // All 73 columns, sorted as the tool sorts them, hashed as the tool hashes them.
  assert.equal(inspect.updatable_columns.length, 73);
  assert.deepEqual(inspect.updatable_columns, [...inspect.updatable_columns].sort());
  assert.equal(inspect.updatable_columns_sha256, PRODUCTION_COLUMNS_SHA256);
  assert.equal(sha(inspect.updatable_columns.join(',')), inspect.updatable_columns_sha256);
  for (const column of SQL89_COLUMNS) assert.ok(inspect.updatable_columns.includes(column), column);
  // The fingerprint of table-level UPDATE plus those 73 columns is the recorded live hash.
  assert.equal(stateHash(true, inspect.updatable_columns), PRODUCTION_PRE);
  assert.deepEqual(inspect.column_update_entries, []);
  assert.deepEqual(inspect.grantee_update_grantors, ['checksops_admin']);
  assert.deepEqual(inspect.grantee_member_of, ['authenticated']);
  assert.deepEqual(inspect.authenticated_members, [{ role: 'checksops', can_login: true }]);
  assert.deepEqual(inspect.other_login_authenticated_members, []);
  assert.deepEqual(inspect.update_grant_sources, [{ grantee: 'checksops', table_level: true, columns: [] }]);
  assert.deepEqual(inspect.other_inherited_update_roles, []);
  assert.deepEqual(inspect.revoked_role_update_entries, []);
  assert.deepEqual(inspect.unsafe_update_functions, []);
  assert.equal(inspect.ingest_function_present, true);
  assert.equal(inspect.ingest_function_security_definer, true);
  assert.equal(inspect.authenticated_role_present, true);
  // The values at inspect time, before anything was recorded here.
  assert.deepEqual(inspect.precondition_failures, ['table_owner_as_inspected', 'table_acl_as_inspected', 'updatable_columns_as_inspected']);
  assert.equal(inspect.apply_preconditions_met, false);
  for (const field of ['filename', 'migration_id', 'source_sha256', 'intended_replacement_sha256', 'table', 'grantee']) {
    assert.equal(COMMITTED[field], STAGING_PIN[field], field);
  }
  assert.deepEqual(COMMITTED.columns, [...SQL89_COLUMNS]);
  assert.equal(COMMITTED.staging_pin_commit, STAGING_PIN.commit);
  // The staging pre-state (read-live run 82) is staging's own; production records its own from --inspect.
  assert.equal(STAGING_PIN.expected_live_definition_sha256, '6810985b26778774a633ad17f02b634ec7c19b956d0f5302251fd1d2d05b0c7f');
  assert.equal(sha(SQL89_TEXT), COMMITTED.source_sha256);
  assert.equal(COMMITTED.source_sha256, 'd91ab6576a2bda45f2a9b0d21fc98241dd8ee20adc24bd34ecb68fc09f92c28a');
  assert.equal(COMMITTED.staging_pin_commit, '70518bbd7e459ae82d461941281465ce58d7a887');
  assert.equal(sql89StatementText(SQL89_TEXT), SQL89_CANONICAL_STATEMENTS);
  // The post-state: no table-level UPDATE, exactly the 43 columns.
  assert.equal(INTENDED, stateHash(false, SQL89_COLUMNS));
  assert.equal(INTENDED, '2a1d45f9250083a605e9784aba628f6f87f52840010487974b29a94097a7e2f8');
  assert.equal(COMMITTED.intended_post_state.live_definition_sha256, INTENDED);
  assert.equal(COMMITTED.intended_post_state.table_level_update, false);
  for (const field of ['rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(COMMITTED[field], SQL72_PIN[field], field);
  assert.equal(sql89AdminLogin(COMMITTED), 'checksops_admin');
  assert.match(COMMITTED.authorization_phrase, /^[A-Z_]{12,}$/);
  for (const other of [SQL72_PIN, SQL71_PIN]) assert.notEqual(COMMITTED.authorization_phrase, other.authorization_phrase);
  assert.equal(ONE_SHOT_TOOLS.sql89.pin_rel, SQL89_PRODUCTION_PIN_REL);
  assert.equal(ONE_SHOT_TOOLS.sql89.script, 'scripts/deployment-guard/sql89-check-intake-column-update-production-apply.mjs');
  assert.equal(ONE_SHOT_TOOLS.sql89.allowed_key, 'sql89_production_apply_allowed');
  // The production inspect of 2026-10-16 is recorded as context only.
  assert.match(COMMITTED.production_inspect.note, /f3715bb0-5fd9-43a8-83e9-86350ef5bab7/);
  // SQL 71's pin points at SQL 89 for its production state, without changing its own binding.
  assert.ok(SQL71_PIN.notes.join('\n').includes('SQL 89'));
  assert.equal(SQL71_PIN.execute, false);
  assert.equal(SQL71_PIN.expected_live_definition_sha256, null);
});

test('the pinned file is exactly the reviewed REVOKEs and column GRANT; a tampered pin or file is refused', () => {
  assert.equal(readPinnedSql89(ROOT, COMMITTED).ok, true);
  for (const field of ['migration', 'filename', 'migration_id', 'source_sha256', 'staging_pin_commit', 'intended_replacement_sha256', 'table', 'grantee', 'target_environment', 'target_component', 'deployment_type']) {
    assert.equal(readPinnedSql89(ROOT, { ...COMMITTED, [field]: 'other' }).code, CODES.SQL_COLLISION, field);
  }
  assert.equal(readPinnedSql89(ROOT, { ...COMMITTED, columns: [...SQL89_COLUMNS, 'tenant_id'] }).code, CODES.SQL_COLLISION);
  assert.equal(readPinnedSql89(ROOT, { ...COMMITTED, columns: SQL89_COLUMNS.slice(1) }).code, CODES.SQL_COLLISION);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql89-prod-tamper-'));
  try {
    for (const [label, text] of [
      ['table-level grant', SQL89_TEXT.replace(/GRANT UPDATE \([\s\S]*?\) ON TABLE/, 'GRANT UPDATE ON TABLE')],
      ['extra column', SQL89_TEXT.replace('  updated_at\n', '  updated_at,\n  tenant_id\n')],
      ['missing column', SQL89_TEXT.replace('  amount,\n', '')],
      ['no revoke', SQL89_TEXT.replace('REVOKE UPDATE ON TABLE public.check_intake_items FROM checksops;\n', '')],
      ['no revoke from authenticated', SQL89_TEXT.replace('REVOKE UPDATE ON TABLE public.check_intake_items FROM authenticated;\n', '')],
      ['no revoke from PUBLIC', SQL89_TEXT.replace('REVOKE UPDATE ON TABLE public.check_intake_items FROM PUBLIC;\n', '')],
      ['revoke from another role', SQL89_TEXT.replace('FROM PUBLIC;\n', 'FROM PUBLIC;\nREVOKE UPDATE ON TABLE public.check_intake_items FROM anon;\n')],
      ['revoke SELECT from authenticated', SQL89_TEXT.replace('REVOKE UPDATE ON TABLE public.check_intake_items FROM authenticated;', 'REVOKE UPDATE, SELECT ON TABLE public.check_intake_items FROM authenticated;')],
      ['revoke cascade', SQL89_TEXT.replace('FROM PUBLIC;', 'FROM PUBLIC CASCADE;')],
      ['revoke all', SQL89_TEXT.replace('REVOKE UPDATE ON TABLE', 'REVOKE ALL ON TABLE')],
      ['other grantee', SQL89_TEXT.replace(') ON TABLE public.check_intake_items TO checksops;', ') ON TABLE public.check_intake_items TO checksops, authenticated;')],
      ['extra statement', `${SQL89_TEXT}GRANT SELECT ON TABLE public.claims TO checksops;\n`],
      ['with grant option', SQL89_TEXT.replace('TO checksops;\n', 'TO checksops WITH GRANT OPTION;\n')],
    ]) {
      assert.notEqual(text, SQL89_TEXT, label);
      const file = path.join(dir, COMMITTED.filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      assert.equal(readPinnedSql89(dir, COMMITTED).code, CODES.SOURCE_RECONCILIATION_REQUIRED, label);
      assert.notEqual(sql89StatementText(text), SQL89_CANONICAL_STATEMENTS, label);
      // A pin carrying the tampered hash no longer names the reviewed file.
      assert.equal(readPinnedSql89(dir, { ...COMMITTED, source_sha256: sha(text) }).code, CODES.SQL_COLLISION, label);
    }
    // Comments and whitespace alone do not change the statements.
    const reflowed = `-- another comment\n${SQL89_TEXT.replace(/\n {2}/g, ' ')}`;
    assert.equal(sql89StatementText(reflowed), SQL89_CANONICAL_STATEMENTS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- rules --------------------------------------------------------------------------

const PRIVS = (update) => ({ SELECT: true, INSERT: true, UPDATE: update, DELETE: true, TRUNCATE: false, REFERENCES: false, TRIGGER: false });
const state = (overrides = {}) => ({
  current_user: 'checksops_admin',
  session_user: 'checksops_admin',
  grantee_role_present: true,
  table_present: true,
  table_owner: 'checksops_admin',
  table_acl: PROD_ACL,
  login_can_grant: true,
  table_acl_entries: ['checksops DELETE granted by checksops_admin', 'checksops INSERT granted by checksops_admin', 'checksops SELECT granted by checksops_admin', 'checksops UPDATE granted by checksops_admin'],
  table_privileges: PRIVS(true),
  table_level_update: true,
  table_level_update_entry: true,
  columns: ALL_COLUMNS,
  updatable_columns: ALL_COLUMNS,
  updatable_columns_sha256: sha(ALL_COLUMNS.join(',')),
  column_update_entries: [],
  column_acl_entries: [],
  grantee_grant_option: false,
  grantee_update_grantors: ['checksops_admin'],
  sql89_columns: [...SQL89_COLUMNS],
  sql89_columns_missing: [],
  columns_to_grant: [],
  columns_losing_update: Object.keys(NOT_GRANTED_COLUMNS).sort(),
  update_functions: [{ signature: 'public.aws_ingest_shared_check(jsonb)', security_definer: true, owner_has_grantee_privileges: false }],
  unsafe_update_functions: [],
  ingest_function_present: true,
  ingest_function_security_definer: true,
  authenticated_role_present: true,
  grantee_member_of: [],
  authenticated_members: [],
  other_login_authenticated_members: [],
  update_grant_sources: [{ grantee: 'checksops', table_level: true, columns: [] }],
  other_inherited_update_roles: [],
  revoked_role_update_entries: [],
  revoked_role_update_grantors: [],
  live_definition_sha256: PROD_PRE,
  already_applied: false,
  ...overrides,
});
const POST_ENTRIES = SQL89_COLUMNS.map((c) => `${c} checksops UPDATE granted by checksops_admin`);
const postState = (overrides = {}) => state({
  table_acl: PROD_ACL_AFTER,
  table_acl_entries: ['checksops DELETE granted by checksops_admin', 'checksops INSERT granted by checksops_admin', 'checksops SELECT granted by checksops_admin'],
  table_privileges: PRIVS(false),
  table_level_update: false,
  table_level_update_entry: false,
  updatable_columns: [...SQL89_COLUMNS],
  updatable_columns_sha256: sha(SQL89_COLUMNS.join(',')),
  column_update_entries: POST_ENTRIES,
  column_acl_entries: POST_ENTRIES,
  columns_losing_update: [],
  update_grant_sources: [{ grantee: 'checksops', table_level: false, columns: [...SQL89_COLUMNS] }],
  live_definition_sha256: INTENDED,
  already_applied: true,
  ...overrides,
});

test('production preconditions and postconditions', () => {
  assert.deepEqual(sql89ProductionPreconditionFailures(state(), PIN), []);
  const refusedPre = [
    [{ current_user: 'ubuntu' }, 'login_is_pinned_admin'],
    [{ session_user: 'ubuntu' }, 'login_is_pinned_admin'],
    [{ grantee_role_present: false }, 'grantee_role_present'],
    [{ sql89_columns_missing: ['returned_at'] }, 'sql89_columns_present'],
    [{ grantee_grant_option: true }, 'no_grantee_grant_option'],
    [{ grantee_update_grantors: ['checksops_admin', 'rds_superuser'] }, 'grantee_update_granted_by_login'],
    [{ login_can_grant: false }, 'login_can_grant'],
    [{ unsafe_update_functions: ['public.f()'] }, 'update_functions_safe'],
    [{ ingest_function_present: false, ingest_function_security_definer: false }, 'sql70_ingest_function_security_definer'],
    [{ ingest_function_security_definer: false }, 'sql70_ingest_function_security_definer'],
    [{ table_owner: 'other' }, 'table_owner_as_inspected'],
    [{ table_acl: '{x}' }, 'table_acl_as_inspected'],
    [{ updatable_columns: SQL89_COLUMNS }, 'updatable_columns_as_inspected'],
    [{ updatable_columns_sha256: 'f'.repeat(64) }, 'updatable_columns_as_inspected'],
    [{ authenticated_role_present: false }, 'authenticated_role_present'],
    [{ other_login_authenticated_members: ['web_login'] }, 'authenticated_has_no_other_login_members'],
    [{ other_login_authenticated_members: undefined }, 'authenticated_has_no_other_login_members'],
    [{ other_inherited_update_roles: ['writer'] }, 'no_other_inherited_update'],
    [{ other_inherited_update_roles: undefined }, 'no_other_inherited_update'],
    [{ revoked_role_update_grantors: ['checksops_admin', 'rds_superuser'] }, 'inherited_update_granted_by_login'],
  ];
  for (const [overrides, name] of refusedPre) {
    assert.ok(sql89ProductionPreconditionFailures(state(overrides), PIN).includes(name), `${name}: ${JSON.stringify(overrides)}`);
  }
  // A pin with no recorded inspect: those three fail.
  assert.deepEqual(sql89ProductionPreconditionFailures(state(), unrecorded()), ['table_owner_as_inspected', 'table_acl_as_inspected', 'updatable_columns_as_inspected']);
  // The fixture state is not production's recorded one (ACL, column set): the committed pin refuses it.
  assert.deepEqual(sql89ProductionPreconditionFailures(state(), COMMITTED), ['table_acl_as_inspected', 'updatable_columns_as_inspected']);
  assert.ok(sql89ProductionPreconditionFailures(state(), { ...PIN, admin_login: undefined }).includes('login_is_pinned_admin'));

  assert.deepEqual(sql89ProductionPostconditionFailures(state(), postState(), PIN), []);
  const refusedPost = [
    [{ live_definition_sha256: PROD_PRE }, 'intended_state'],
    [{ table_level_update: true }, 'no_table_level_update'],
    [{ table_level_update_entry: true }, 'no_table_level_update'],
    [{ updatable_columns: [...SQL89_COLUMNS, 'tenant_id'].sort() }, 'updatable_columns_exact'],
    [{ updatable_columns: SQL89_COLUMNS.slice(1) }, 'updatable_columns_exact'],
    [{ column_update_entries: POST_ENTRIES.slice(1) }, 'column_update_entries_exact'],
    [{ column_update_entries: POST_ENTRIES.map((l) => l.replace('granted by checksops_admin', 'granted by ubuntu')) }, 'column_update_entries_exact'],
    [{ table_privileges: { ...PRIVS(false), INSERT: false } }, 'other_table_privileges_unchanged'],
    [{ table_privileges: { ...PRIVS(false), DELETE: false } }, 'other_table_privileges_unchanged'],
    [{ table_privileges: { ...PRIVS(false), SELECT: false } }, 'other_table_privileges_unchanged'],
    [{ table_privileges: { ...PRIVS(false), TRUNCATE: true } }, 'other_table_privileges_unchanged'],
    [{ table_acl_entries: ['checksops DELETE granted by checksops_admin', 'checksops SELECT granted by checksops_admin'] }, 'other_table_acl_unchanged'],
    [{ table_acl_entries: [...postState().table_acl_entries, 'authenticated SELECT granted by checksops_admin'].sort() }, 'other_table_acl_unchanged'],
    [{ table_acl_entries: [...postState().table_acl_entries, 'checksops UPDATE granted by checksops_admin'].sort() }, 'other_table_acl_unchanged'],
    [{ column_acl_entries: [...POST_ENTRIES, 'tenant_id authenticated SELECT granted by checksops_admin'].sort() }, 'other_column_acl_unchanged'],
    [{ column_acl_entries: [...POST_ENTRIES, 'status authenticated UPDATE granted by checksops_admin'].sort() }, 'authenticated_and_public_hold_no_update'],
    [{ table_acl_entries: [...postState().table_acl_entries, 'PUBLIC UPDATE granted by checksops_admin'].sort() }, 'authenticated_and_public_hold_no_update'],
    [{ revoked_role_update_entries: ['status authenticated UPDATE granted by checksops_admin'] }, 'authenticated_and_public_hold_no_update'],
    [{ update_grant_sources: [...postState().update_grant_sources, { grantee: 'writer', table_level: false, columns: ['status'] }] }, 'update_only_from_grantee'],
    [{ grantee_grant_option: true }, 'no_grantee_grant_option'],
    [{ table_owner: 'other' }, 'table_owner_unchanged'],
    [{ current_user: 'ubuntu' }, 'login_is_pinned_admin'],
  ];
  for (const [overrides, name] of refusedPost) {
    assert.ok(sql89ProductionPostconditionFailures(state(), postState(overrides), PIN).includes(name), `${name}: ${JSON.stringify(overrides)}`);
  }
});

// --- evaluation and CLI -----------------------------------------------------------------

test('the state the production inspect of 2026-10-16 read meets every precondition of the committed pin; the pending copy refuses only for authorization, execute and staging acceptance', async () => {
  const inspect = COMMITTED.production_inspect;
  const production = state({
    table_owner: 'checksops_admin',
    table_acl: PRODUCTION_ACL,
    table_level_update: true,
    columns: [...inspect.updatable_columns],
    updatable_columns: [...inspect.updatable_columns],
    updatable_columns_sha256: PRODUCTION_COLUMNS_SHA256,
    column_update_entries: [],
    grantee_update_grantors: ['checksops_admin'],
    grantee_member_of: ['authenticated'],
    authenticated_members: [{ role: 'checksops', can_login: true }],
    other_login_authenticated_members: [],
    update_grant_sources: [{ grantee: 'checksops', table_level: true, columns: [] }],
    other_inherited_update_roles: [],
    revoked_role_update_entries: [],
    revoked_role_update_grantors: [],
    unsafe_update_functions: [],
    ingest_function_present: true,
    ingest_function_security_definer: true,
    authenticated_role_present: true,
    live_definition_sha256: PRODUCTION_PRE,
  });
  assert.equal(production.updatable_columns_sha256, sha(production.updatable_columns.join(',')));
  assert.deepEqual(sql89ProductionPreconditionFailures(production, COMMITTED), []);
  // Before this change (nothing recorded) the same state failed exactly the three recorded checks.
  assert.deepEqual(sql89ProductionPreconditionFailures(production, unrecorded()), inspect.precondition_failures);
  // Drift since the inspect still refuses.
  assert.ok(sql89ProductionPreconditionFailures({ ...production, table_acl: PROD_ACL }, COMMITTED).includes('table_acl_as_inspected'));
  assert.ok(sql89ProductionPreconditionFailures({ ...production, updatable_columns: [...SQL89_COLUMNS] }, COMMITTED).includes('updatable_columns_as_inspected'));
  // The manifest bound to the recorded pre-state, on the pending copy: refused for authorization
  // (pending), then for execute false and the missing staging acceptance; with only those three
  // changed it is allowed.
  const locked = pending();
  const exact = manifest({}, PRODUCTION_PRE);
  const pendingPin = await evaluateSql89ProductionApply({ ...exact, staging_acceptance: PIN.staging_acceptance }, { root: ROOT, pin: locked });
  assert.equal(pendingPin.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.match(pendingPin.message, /authorization is not an owner approval/);
  const approvedOnly = { ...locked, authorization: 'Owner approved test fixture' };
  assert.equal((await evaluateSql89ProductionApply(exact, { root: ROOT, pin: approvedOnly })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const accepted = { ...approvedOnly, staging_acceptance: PIN.staging_acceptance };
  assert.equal((await executeSql89ProductionApply(exact, { root: ROOT, pin: accepted, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.GUARD_APPLY_FORBIDDEN);
  const unlocked = { ...accepted, execute: true };
  const allowed = await evaluateSql89ProductionApply(exact, { root: ROOT, pin: unlocked });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.expected_live_definition_sha256, PRODUCTION_PRE);
});

test('the committed (retired) pin refuses before any connection, also with the spent one_use_id; flipping execute alone does not revive it', async () => {
  for (const opts of [{ root: ROOT }, { root: ROOT, pin: COMMITTED }]) {
    const refused = await evaluateSql89ProductionApply(committedManifest(), opts);
    assert.equal(refused.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.match(refused.message, /authorization is not an owner approval/);
    assert.equal((await executeSql89ProductionApply(committedManifest(), { ...opts, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  }
  const flipped = { ...COMMITTED, execute: true };
  assert.equal((await evaluateSql89ProductionApply(committedManifest(), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeSql89ProductionApply(committedManifest(), { root: ROOT, pin: flipped, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // The spent one_use_id is refused as a replay, even on an execute-authorized copy.
  const spentFile = consumedPath();
  fs.writeFileSync(spentFile, JSON.stringify({ consumed: [APPLIED.one_use_id] }));
  try {
    const replay = await executeSql89ProductionApply(committedManifest({ one_use_id: APPLIED.one_use_id }), { root: ROOT, pin: unlocked(), connect: neverConnect, consumedPath: spentFile });
    assert.equal(replay.code, CODES.RECEIPT_REUSED);
  } finally {
    fs.rmSync(spentFile, { force: true });
  }
});

test('the execute-authorized copy (the pin before its record-and-retire change) evaluates with a matching manifest and reaches the connection only after every pre-connect check', async () => {
  for (const opts of [{ root: ROOT, pin: unlocked() }]) {
    const allowed = await evaluateSql89ProductionApply(committedManifest(), opts);
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.details.sql89_production_apply_allowed, true);
    assert.equal(allowed.details.migration, 'sql89');
    assert.equal(allowed.details.expected_live_definition_sha256, PRODUCTION_PRE);
    assert.equal(allowed.details.intended_replacement_sha256, COMMITTED.intended_replacement_sha256);
    assert.equal(allowed.details.staging_acceptance, STAGING_ACCEPTANCE.reference);
  }
  // The copy still binds the manifest: another staging reference, the fixture
  // pre-state, the post-state as live hash or another workstream's approval refuse.
  const pin = unlocked();
  assert.equal((await evaluateSql89ProductionApply(committedManifest({ staging_acceptance: { ok: true, reference: STAGING_REF } }), { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await evaluateSql89ProductionApply(manifest({ staging_acceptance: COMMITTED.staging_acceptance }), { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  assert.equal((await evaluateSql89ProductionApply(committedManifest({ live_definition_sha256: INTENDED }), { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  assert.equal((await evaluateSql89ProductionApply(committedManifest({ approval: { approved: true, workstream_id: 'another' } }), { root: ROOT, pin })).ok, false);
  // With execute false (as after the record-and-retire change) the apply is refused.
  assert.equal((await executeSql89ProductionApply(committedManifest(), { root: ROOT, pin: { ...pin, execute: false }, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.GUARD_APPLY_FORBIDDEN);
  // The apply passes its pre-connect checks on the copy and stops only at the (test) connection.
  const passes = await executeSql89ProductionApply(committedManifest(), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() }).catch((error) => error);
  assert.match(String(passes?.message || ''), /should-not-connect/);
});

test('evaluation: a pending pin refuses; it is bound to a recorded pre-state, an owner approval, the staging acceptance and the production gate', async () => {
  const pendingPin = await evaluateSql89ProductionApply(committedManifest(), { root: ROOT, pin: pending() });
  assert.equal(pendingPin.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.match(pendingPin.message, /authorization is not an owner approval/);
  // No pre-state recorded (null), whatever the manifest says.
  const noPre = await evaluateSql89ProductionApply(manifest(), { root: ROOT, pin: unrecorded(PIN) });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  assert.match(noPre.message, /no recorded pre-apply live definition hash/);
  const nullManifest = await evaluateSql89ProductionApply(manifest({}, null), { root: ROOT, pin: unrecorded(PIN) });
  assert.equal(nullManifest.code, CODES.SQL_COLLISION, 'null == null is never a match');
  const pendingAuthorization = await evaluateSql89ProductionApply(manifest(), { root: ROOT, pin: { ...PIN, authorization: 'pending' } });
  assert.equal(pendingAuthorization.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  for (const authorization of ['', null, 'approved', 'pending ']) {
    const result = await evaluateSql89ProductionApply(manifest(), { root: ROOT, pin: { ...PIN, authorization } });
    assert.equal(result.code, CODES.PRODUCTION_APPROVAL_REQUIRED, String(authorization));
  }
  const noStaging = await evaluateSql89ProductionApply(manifest(), { root: ROOT, pin: { ...PIN, staging_acceptance: PENDING_ACCEPTANCE } });
  assert.equal(noStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const allowed = await evaluateSql89ProductionApply(manifest(), { root: ROOT, pin: PIN });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.migration, 'sql89');
  assert.equal(allowed.details.sql89_production_apply_allowed, true);
  for (const field of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256', 'live_definition_sha256']) {
    const result = await evaluateSql89ProductionApply(manifest({ [field]: 'f'.repeat(64) }), { root: ROOT, pin: PIN });
    assert.equal(result.code, CODES.SQL_COLLISION, field);
  }
  const appliedHash = await evaluateSql89ProductionApply(manifest({ live_definition_sha256: INTENDED }), { root: ROOT, pin: PIN });
  assert.equal(appliedHash.code, CODES.SQL_COLLISION);
  const otherRef = await evaluateSql89ProductionApply(manifest({ staging_acceptance: { ok: true, reference: `${STAGING_REF}0` } }), { root: ROOT, pin: PIN });
  assert.equal(otherRef.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const otherApproval = await evaluateSql89ProductionApply(manifest({ approval: { approved: true, workstream_id: 'another' } }), { root: ROOT, pin: PIN });
  assert.equal(otherApproval.ok, false);
});

test('CLI with the committed (retired) pin refuses at evaluation and an execute-authorized copy with no receipt at the guard; a pending pin refuses before the guard; credential flags are refused; nothing connects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql89-prod-noreceipt-'));
  try {
    const input = path.join(dir, 'sql89.json');
    fs.writeFileSync(input, JSON.stringify(committedManifest()));
    for (const extra of [{ CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {}]) {
      const result = spawnSync(process.execPath, [CLI, '--apply', '--input', input], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: dir, ...extra },
      });
      // The committed pin is retired: evaluation refuses before the guard, the secret or any
      // connection. The env flag does not bypass it.
      const out = `${result.stdout}${result.stderr}`;
      assert.notEqual(result.status, 0, out);
      assert.match(out, /PRODUCTION_APPROVAL_REQUIRED/);
      assert.match(out, /authorization is not an owner approval/);
      assert.doesNotMatch(out, /secretsmanager|ECONNREFUSED|rolled back/i);
    }
    for (const flag of ['--password=x', '--database-url=postgresql://u:p@h/d', '--host=h', '--user=u', '--secret-arn=x']) {
      const result = spawnSync(process.execPath, [CLI, '--inspect', flag], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
      assert.notEqual(result.status, 0, flag);
      assert.match(`${result.stdout}${result.stderr}`, /credential flags are refused/, flag);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secretsmanager|ECONNREFUSED/i, flag);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The retired pin read from disk stops before the guard is asked.
  const retired = await runCli(['--apply'], { input: committedManifest(), deps: { enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(retired.spent, 0);
  assert.match(retired.out, /PRODUCTION_APPROVAL_REQUIRED/);
  assert.doesNotMatch(retired.out, /guard-called|should-not-connect/);
  // The execute-authorized copy with no receipt stops at the guard (DEPLOYMENT_GUARD_REQUIRED).
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql89-prod-unlocked-noreceipt-'));
  try {
    const unlockedNoReceipt = await runCli(['--apply'], {
      input: committedManifest(),
      deps: { pin: unlocked(), enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: emptyRoot, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' } }) },
    });
    assert.equal(unlockedNoReceipt.spent, 0);
    assert.match(unlockedNoReceipt.out, /DEPLOYMENT_GUARD_REQUIRED/);
    assert.doesNotMatch(unlockedNoReceipt.out, /should-not-connect/);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
  // A pending pin (authorization "pending", execute false) stops before the guard is asked.
  const locked = await runCli(['--apply'], { input: committedManifest(), deps: { pin: pending(), enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(locked.spent, 0);
  assert.match(locked.out, /PRODUCTION_APPROVAL_REQUIRED/);
  assert.match(locked.out, /authorization is not an owner approval/);
  assert.doesNotMatch(locked.out, /guard-called|should-not-connect/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sql89-prod-noreceipt-root-'));
  try {
    const noReceipt = await runCli(['--apply'], {
      input: manifest(),
      deps: { pin: PIN, enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: empty, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' } }) },
    });
    assert.equal(noReceipt.spent, 0);
    assert.match(noReceipt.out, /DEPLOYMENT_GUARD_REQUIRED/);
    assert.doesNotMatch(noReceipt.out, /should-not-connect/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('CLI does not spend the receipt on a wrong phrase, execute false, a pending pin, a wrong owner, a reused id, a missing guard flag or arbitrary SQL', async () => {
  const owned = (filename = PIN.filename) => ({ ok: true, details: { receipt: { owned_components: [filename] } } });
  const argv = ['--apply'];
  const phrase = await runCli(argv, { input: manifest({ authorization_phrase: 'yes' }), deps: { pin: PIN, enforceScriptGuard: () => owned() } });
  assert.equal(phrase.spent, 0);
  assert.match(phrase.out, /PRODUCTION_APPROVAL_REQUIRED/);
  const notExecutable = await runCli(argv, { input: manifest(), deps: { pin: { ...PIN, execute: false }, enforceScriptGuard: () => owned() } });
  assert.equal(notExecutable.spent, 0);
  assert.match(notExecutable.out, /execute is not authorized/);
  const pendingAuthorization = await runCli(argv, { input: manifest(), deps: { pin: { ...PIN, authorization: 'pending' }, enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(pendingAuthorization.spent, 0);
  assert.match(pendingAuthorization.out, /PRODUCTION_APPROVAL_REQUIRED/);
  assert.doesNotMatch(pendingAuthorization.out, /guard-called/);
  // A pending pin (pre-authorization state) stops before the guard is even asked.
  const committed = await runCli(argv, { input: manifest(), deps: { pin: pending(), enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(committed.spent, 0);
  assert.match(committed.out, /PRODUCTION_APPROVAL_REQUIRED/);
  assert.doesNotMatch(committed.out, /guard-called/);
  const noPreState = await runCli(argv, { input: manifest(), deps: { pin: unrecorded(PIN), enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(noPreState.spent, 0);
  assert.match(noPreState.out, /SQL_COLLISION/);
  assert.doesNotMatch(noPreState.out, /guard-called/);
  const wrongOwner = await runCli(argv, { input: manifest(), deps: { pin: PIN, enforceScriptGuard: () => owned('aws/workflows/sql/71_review_amount_column_grant.sql') } });
  assert.equal(wrongOwner.spent, 0);
  assert.match(wrongOwner.out, /RECEIPT_MISMATCH/);
  const reusedFile = consumedPath();
  fs.writeFileSync(reusedFile, JSON.stringify({ consumed: ['sql89-prod-reused-id'] }));
  const reused = await runCli(argv, { input: manifest({ one_use_id: 'sql89-prod-reused-id' }), deps: { pin: PIN, enforceScriptGuard: () => owned(), consumedPath: reusedFile } });
  assert.equal(reused.spent, 0);
  assert.match(reused.out, /RECEIPT_REUSED/);
  const noFlag = await runCli(argv, { env: {}, input: manifest(), deps: { pin: PIN, enforceScriptGuard: () => owned() } });
  assert.equal(noFlag.spent, 0);
  assert.match(noFlag.out, /blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1/);
  const arbitrary = await runCli(argv, { input: { ...manifest(), sql_text: 'GRANT UPDATE (tenant_id) ON public.check_intake_items TO checksops' }, deps: { pin: PIN, enforceScriptGuard: () => owned() } });
  assert.equal(arbitrary.spent, 0);
  assert.match(arbitrary.out, /arbitrary SQL text is forbidden/);
  for (const r of [phrase, notExecutable, pendingAuthorization, committed, noPreState, wrongOwner, reused, noFlag, arbitrary]) assert.doesNotMatch(r.out, /should-not-connect/);
});

test('the real guard: a staging receipt cannot authorize production; a production receipt is spent once and a refusing DB rolls back', async () => {
  const NOW = Date.parse('2026-10-16T20:00:00.000Z');
  const issue = (root, overrides) => {
    const input = manifest();
    const spec = {
      workstream_id: input.workstream_id,
      branch: 'main',
      commit: COMMIT,
      operator: 'owner',
      target_environment: 'production',
      target_component: 'production-sql',
      deployment_type: 'sql-apply',
      owned_components: [PIN.filename],
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
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql89-prod-staging-receipt-'));
  const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql89-prod-receipt-'));
  try {
    const staging = issue(stagingRoot, { target_environment: 'staging', target_component: 'staging-sql' });
    const refused = await runCli(['--apply'], { input: staging.input, deps: { pin: PIN, enforceScriptGuard: guardWith(stagingRoot, staging.receipt) } });
    assert.equal(refused.spent, 0);
    assert.match(refused.out, /RECEIPT_MISMATCH/);
    const prod = issue(prodRoot, {});
    const refusingDb = async () => ({ query: async () => { throw new Error('db-unavailable'); }, end: async () => {} });
    const valid = await runCli(['--apply'], { input: prod.input, deps: { pin: PIN, enforceScriptGuard: guardWith(prodRoot, prod.receipt), connect: refusingDb } });
    assert.equal(valid.spent, 1);
    assert.match(valid.out, /rolled back/);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(prodRoot, { recursive: true, force: true });
  }
});

test('apply refuses before connecting: a pending pin, no pre-state, a pending authorization, execute false, no phrase, no single-use id', async () => {
  const run = (overrides, pin = PIN) => executeSql89ProductionApply(manifest(overrides), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal((await run({}, pending({ expected_live_definition_sha256: PROD_PRE }))).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({}, pending({ expected_live_definition_sha256: PROD_PRE, staging_acceptance: PIN.staging_acceptance }))).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const pendingExact = await executeSql89ProductionApply(committedManifest(), { root: ROOT, pin: pending(), connect: neverConnect, consumedPath: consumedPath() });
  assert.equal(pendingExact.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // The execute-authorized copy is bound to the recorded production pre-state, not the fixture's.
  const unlockedCopy = await executeSql89ProductionApply(manifest(), { root: ROOT, pin: unlocked(), connect: neverConnect, consumedPath: consumedPath() });
  assert.equal(unlockedCopy.code, CODES.SQL_COLLISION);
  // The committed (retired) pin refuses whatever the manifest says.
  const committed = await executeSql89ProductionApply(manifest(), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal(committed.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({}, unrecorded(PIN))).code, CODES.SQL_COLLISION);
  assert.equal((await run({}, { ...PIN, authorization: 'pending' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({}, { ...PIN, execute: false })).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await run({}, { ...PIN, staging_acceptance: PENDING_ACCEPTANCE })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({ authorization_phrase: 'yes' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({}, { ...PIN, authorization_phrase: '' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({ one_use_id: 'x' })).code, CODES.INVALID_MANIFEST);
  const authorized = await run({}).catch((error) => error);
  assert.match(String(authorized?.message || ''), /should-not-connect/);
});

// --- PostgreSQL -------------------------------------------------------------------

const ROW = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

/**
 * The table owned by checksops_admin with RLS and permissive checksops policies, a
 * SECURITY DEFINER SQL 70-style ingest function and a SECURITY DEFINER claim-number
 * writer (both owned by checksops_admin), and `grants` run as checksops_admin.
 */
async function fixture(pg, prefix, port, grants) {
  const server = startPg(prefix, port);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  await admin.query(`
    CREATE ROLE checksops NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE checksops_admin LOGIN NOSUPERUSER;
    GRANT CREATE ON SCHEMA public TO checksops_admin;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE TABLE public.claims (id uuid PRIMARY KEY, org_id uuid);
    ALTER TABLE public.claims OWNER TO checksops_admin;`);
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(checkIntakeTableSql(SQL89_COLUMNS));
    await owner.query(`
      ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
      CREATE POLICY aws_select_check_intake_items ON public.check_intake_items FOR SELECT TO checksops USING (true);
      CREATE POLICY aws_insert_check_intake_items ON public.check_intake_items FOR INSERT TO checksops WITH CHECK (true);
      CREATE POLICY aws_update_check_intake_items ON public.check_intake_items FOR UPDATE TO checksops USING (true) WITH CHECK (true);
      CREATE POLICY aws_delete_check_intake_items ON public.check_intake_items FOR DELETE TO checksops USING (true);
      CREATE FUNCTION public.aws_ingest_shared_check(p_payload jsonb) RETURNS jsonb
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        UPDATE public.check_intake_items
           SET detected_claim_number = p_payload->>'detected_claim_number',
               partner_status = p_payload->>'partner_status',
               freedom_claim_id = p_payload->>'freedom_claim_id',
               updated_at = now()
         WHERE id = (p_payload->>'id')::uuid;
        RETURN jsonb_build_object('ok', true);
      END $$;
      REVOKE ALL ON FUNCTION public.aws_ingest_shared_check(jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.aws_ingest_shared_check(jsonb) TO checksops;
      CREATE FUNCTION public.review_save_detected_claim_number(p_check uuid, p_tenant uuid, p_claim text) RETURNS jsonb
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        UPDATE public.check_intake_items SET detected_claim_number = p_claim WHERE id = p_check AND tenant_id = p_tenant;
        RETURN jsonb_build_object('ok', true);
      END $$;
      REVOKE ALL ON FUNCTION public.review_save_detected_claim_number(uuid, uuid, text) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.review_save_detected_claim_number(uuid, uuid, text) TO checksops;
      GRANT SELECT ON TABLE public.claims TO checksops;
      ${grants}`);
  } finally {
    await owner.end();
  }
  return { server, admin, connectAs };
}

const PRODUCTION_GRANTS = 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.check_intake_items TO checksops;';
// Staging's repo-recorded column grants (SQL 33, 35, 40, 50, 52, 71, 2026-09-16 lock), plus one
// column SQL 89 does not keep, to show the apply also takes UPDATE away.
const STAGING_REPO_COLUMNS = Object.freeze([
  'account_number', 'amount', 'back_image_original_path', 'back_image_path', 'carrier_name', 'check_number', 'check_stage',
  'deposit_recommendation', 'endorsement_render_version', 'expiration_days', 'front_image_path', 'funds_type', 'is_multi_payee',
  'issue_date', 'mortgage_monitoring_type', 'mortgage_received_at', 'mortgage_sent_at', 'mortgage_tracking_number',
  'ocr_needs_verification', 'payee_address', 'payee_line', 'property_address', 'review_notes', 'reviewed_at', 'reviewed_by',
  'routing_number', 'status', 'updated_at',
]);
const STAGING_GRANTS = `GRANT SELECT, INSERT, DELETE ON TABLE public.check_intake_items TO checksops;
  GRANT UPDATE (${STAGING_REPO_COLUMNS.join(', ')}) ON TABLE public.check_intake_items TO checksops;
  GRANT UPDATE (detected_claim_number) ON TABLE public.check_intake_items TO checksops;`;

const catalog = async (admin) => (await admin.query(`
  SELECT has_table_privilege('checksops', 'public.check_intake_items', 'UPDATE') AS table_level,
    has_table_privilege('checksops', 'public.check_intake_items', 'SELECT') AS sel,
    has_table_privilege('checksops', 'public.check_intake_items', 'INSERT') AS ins,
    has_table_privilege('checksops', 'public.check_intake_items', 'DELETE') AS del,
    (SELECT relacl::text FROM pg_class WHERE oid = 'public.check_intake_items'::regclass) AS table_acl,
    ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid = 'public.check_intake_items'::regclass AND attnum > 0 AND NOT attisdropped
      AND has_column_privilege('checksops', attrelid, attnum, 'UPDATE') ORDER BY attname::text COLLATE "C") AS updatable,
    (SELECT md5(string_agg(c.oid::text || COALESCE(c.relacl::text, ''), ',' ORDER BY c.oid)) FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.oid <> 'public.check_intake_items'::regclass) AS other_acls`)).rows[0];

/** Every static API UPDATE statement, run as checksops with NULL parameters (privileges are checked at executor start). */
async function runApiUpdatesAsChecksops(admin, { live = false } = {}) {
  const statements = [...apiUpdateStatements().statements];
  if (live) {
    const sources = liveProductionSources();
    assert.ok(sources, `commit ${LIVE_SNAPSHOT} is needed for the live statements`);
    for (const src of sources.sources) {
      statements.push(...updateStatementsInText(src.text, `${src.label}:${src.rel}`).statements);
    }
  }
  const results = [];
  const seenSql = new Set();
  for (const s of statements.filter((x) => !x.dynamic)) {
    if (seenSql.has(s.sql)) continue;
    seenSql.add(s.sql);
    const params = Math.max(0, ...[...s.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE checksops');
      await admin.query(s.sql, new Array(params).fill(null));
      results.push({ at: `${s.file}:${s.line}`, ok: true });
    } catch (error) {
      results.push({ at: `${s.file}:${s.line}`, ok: false, code: error.code, message: error.message });
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  return results;
}

/** As checksops: real rows through the generic Review write, the row lock, INSERT/DELETE, SECURITY DEFINER writers, and refused columns. */
async function behaviourAsChecksops(admin) {
  await admin.query(`INSERT INTO public.check_intake_items (id, tenant_id, status, check_stage, amount) VALUES ('${ROW}', '${TENANT}', 'needs_review', 'review', 10)`);
  await admin.query('BEGIN');
  try {
    await admin.query('SET LOCAL ROLE checksops');
    // The generic /data/write statement (write-check-workflow.mjs executeIntakeUpdate) with every allowlisted column.
    const generic = [...WRITE_ALLOWLIST.check_intake_items.columns].filter((c) => c !== 'updated_at');
    const values = {
      amount: '12.34', routing_number: '011000015', account_number: '123456789', issue_date: '2026-10-01', expiration_days: 90,
      is_multi_payee: true, mortgage_sent_at: '2026-10-02T00:00:00Z', mortgage_received_at: '2026-10-03T00:00:00Z',
      endorsement_override: { x: 1 }, endorsement_render_meta: { y: 2 }, endorsement_render_status: 'idle', mortgage_monitoring_type: 'monitored',
    };
    const casts = { expiration_days: 'int', is_multi_payee: 'boolean', issue_date: 'date', amount: 'numeric', mortgage_sent_at: 'timestamptz', mortgage_received_at: 'timestamptz', endorsement_override: 'jsonb', endorsement_render_meta: 'jsonb' };
    const sets = generic.map((c, i) => `${c} = $${i + 1}::${casts[c] || 'text'}`);
    const params = generic.map((c) => (c in values ? values[c] : `v-${c}`));
    const updated = await admin.query(
      `UPDATE public.check_intake_items SET ${sets.join(', ')}, updated_at = now() WHERE id = $${generic.length + 1}::uuid AND check_stage::text = $${generic.length + 2}::text RETURNING *`,
      [...params, ROW, 'review'],
    );
    assert.equal(updated.rowCount, 1);
    assert.equal(updated.rows[0].amount, '12.34');
    // workflow-rpc.mjs record-return and admin-override row lock.
    assert.equal((await admin.query(`SELECT id FROM public.check_intake_items WHERE id = '${ROW}' FOR UPDATE`)).rowCount, 1);
    assert.equal((await admin.query(`UPDATE public.check_intake_items SET check_stage = 'returned', status = 'returned', pre_return_stage = 'review', returned_at = now(), return_code = 'R01', return_reason = 'x', return_notes = 'y', return_recorded_by = '${TENANT}', return_source = 'manual', return_resolved_at = NULL, return_resolution = NULL, updated_at = now() WHERE id = '${ROW}'`)).rowCount, 1);
    // SECURITY DEFINER writers (SQL 43- and SQL 70-style) still write columns checksops cannot.
    await admin.query(`SELECT public.review_save_detected_claim_number('${ROW}', '${TENANT}', 'CLM-1')`);
    await admin.query(`SELECT public.aws_ingest_shared_check('{"id": "${ROW}", "detected_claim_number": "CLM-2", "partner_status": "shared", "freedom_claim_id": "F1"}'::jsonb)`);
    assert.equal((await admin.query(`SELECT detected_claim_number FROM public.check_intake_items WHERE id = '${ROW}'`)).rows[0].detected_claim_number, 'CLM-2');
    // INSERT and DELETE still work.
    await admin.query(`INSERT INTO public.check_intake_items (id, tenant_id, status) VALUES ('33333333-3333-4333-8333-333333333333', '${TENANT}', 'uploaded')`);
    assert.equal((await admin.query("DELETE FROM public.check_intake_items WHERE id = '33333333-3333-4333-8333-333333333333'")).rowCount, 1);
  } finally {
    await admin.query('ROLLBACK');
  }
  // Columns SQL 89 does not grant: 42501, each in its own transaction.
  const refused = {};
  for (const column of Object.keys(NOT_GRANTED_COLUMNS)) {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE checksops');
      const value = /(^id$|_id$|_by$)/.test(column) ? `'${TENANT}'::uuid` : (/_at$/.test(column) ? 'now()' : (column === 'raw_ocr_front' ? "'{}'::jsonb" : "'x'"));
      await admin.query(`UPDATE public.check_intake_items SET ${column} = ${value} WHERE id = '${ROW}'`);
      refused[column] = 'allowed';
    } catch (error) {
      refused[column] = error.code;
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  await admin.query(`DELETE FROM public.check_intake_items WHERE id = '${ROW}'`);
  return refused;
}

async function withPg(t, fn) {
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
  await fn(pg);
}

test('PostgreSQL 16, production-like (table-level arwd): inspect is read-only; apply lands exactly once; every API UPDATE still runs as checksops; refusals and rollback', { timeout: 300000 }, async (t) => withPg(t, async (pg) => {
  const { server, admin, connectAs } = await fixture(pg, 'pg-sql89-prod-', 56900, PRODUCTION_GRANTS);
  try {
    const start = await catalog(admin);
    assert.equal(start.table_level, true);
    assert.equal(start.table_acl, PROD_ACL);
    assert.deepEqual(start.updatable, ALL_COLUMNS);

    // Before SQL 89 checksops can write identity columns (the production finding).
    await admin.query('BEGIN');
    await admin.query('SET LOCAL ROLE checksops');
    await admin.query(`UPDATE public.check_intake_items SET tenant_id = '${TENANT}', uploaded_by = '${TENANT}', created_at = now(), deposited_by_tenant_id = '${TENANT}', id = id`);
    await admin.query('ROLLBACK');

    const seen = [];
    const connectWith = (user) => async () => {
      const client = await connectAs(user);
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const connect = connectWith('checksops_admin');
    const inspect = (c = connect, pin = PIN) => inspectSql89Production({ connect: c, pin, root: ROOT });

    // The pre-authorization pin with no recorded pre-state (as before the production inspect was recorded): the inspect reads but refuses.
    const committed = await inspect(connect, unrecorded(pending()));
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.equal(committed.details.live_definition_sha256, PROD_PRE);
    assert.equal(committed.details.live_matches_expected, false);
    assert.equal(committed.details.apply_preconditions_met, false);
    assert.deepEqual(committed.details.precondition_failures, ['table_owner_as_inspected', 'table_acl_as_inspected', 'updatable_columns_as_inspected']);
    assert.equal(committed.details.pin_execute, false);
    // The committed pin records production's state, which this fixture is not (ACL, column set): refused.
    const committedPin = await inspect(connect, COMMITTED);
    assert.equal(committedPin.details.live_matches_expected, false);
    assert.equal(committedPin.details.apply_preconditions_met, false);
    assert.deepEqual(committedPin.details.precondition_failures, ['table_acl_as_inspected', 'updatable_columns_as_inspected']);

    seen.length = 0;
    const before = await inspect();
    assert.equal(before.ok, true, JSON.stringify(before));
    const b = before.details;
    assert.equal(b.read_only, true);
    assert.equal(b.migration, 'sql89');
    assert.equal(b.source_ok, true);
    assert.equal(b.live_definition_sha256, PROD_PRE);
    assert.equal(b.live_matches_expected, true);
    assert.equal(b.already_applied, false);
    assert.deepEqual(b.precondition_failures, []);
    assert.equal(b.apply_preconditions_met, true);
    assert.equal(b.current_user, 'checksops_admin');
    assert.equal(b.table_owner, 'checksops_admin');
    assert.equal(b.table_acl, PROD_ACL);
    assert.equal(b.table_level_update, true);
    assert.deepEqual(b.table_privileges, PRIVS(true));
    assert.equal(b.column_count, ALL_COLUMNS.length);
    assert.deepEqual(b.updatable_columns, ALL_COLUMNS);
    assert.deepEqual(b.sql89_columns, [...SQL89_COLUMNS]);
    assert.deepEqual(b.sql89_columns_missing, []);
    assert.deepEqual(b.columns_to_grant, []);
    assert.deepEqual(b.columns_losing_update, Object.keys(NOT_GRANTED_COLUMNS).sort());
    assert.deepEqual(b.unsafe_update_functions, []);
    assert.deepEqual(b.update_functions.map((f) => f.signature), ['public.aws_ingest_shared_check(jsonb)', 'public.review_save_detected_claim_number(uuid,uuid,text)']);
    assert.equal(b.ingest_function_security_definer, true);
    assert.deepEqual(b.update_grant_sources, [{ grantee: 'checksops', table_level: true, columns: [] }]);
    assert.ok(Object.values(b.update_provenance).every((v) => JSON.stringify(v) === '["checksops (table)"]'));
    assert.deepEqual(b.grantee_member_of, []);
    assert.deepEqual(b.authenticated_members, []);
    assert.deepEqual(b.post_state, { live_definition_sha256: INTENDED, updatable_columns: [...SQL89_COLUMNS], table_level_update: false });
    assert.equal(seen[0], 'BEGIN READ ONLY');
    assert.equal(seen.at(-1), 'ROLLBACK');
    assert.ok(seen.slice(1, -1).every((text) => /^\s*(SELECT|WITH)\b/i.test(text)), JSON.stringify(seen));
    assert.ok(seen.every((text) => !/FROM\s+public\.check_intake_items/i.test(text)), 'no table row is read');
    assert.deepEqual(await catalog(admin), start, 'inspect changed nothing');

    // Wrong login: the superuser and a non-owner are refused.
    const asSuperuser = await inspect(connectWith('ubuntu'));
    assert.ok(asSuperuser.details.precondition_failures.includes('login_is_pinned_admin'));
    assert.equal(asSuperuser.details.apply_preconditions_met, false);
    const superApply = await executeSql89ProductionApply(manifest(), { root: ROOT, pin: PIN, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
    assert.equal(superApply.code, CODES.DEPLOYMENT_COLLISION);
    assert.ok(superApply.details.failed.includes('login_is_pinned_admin'));
    await admin.query('CREATE ROLE sql89_other LOGIN NOSUPERUSER; GRANT SELECT ON public.check_intake_items TO sql89_other');
    const otherApply = await executeSql89ProductionApply(manifest(), { root: ROOT, pin: PIN, connect: connectWith('sql89_other'), consumedPath: consumedPath() });
    assert.equal(otherApply.code, CODES.DEPLOYMENT_COLLISION);
    for (const name of ['login_is_pinned_admin', 'login_can_grant', 'grantee_update_granted_by_login']) assert.ok(otherApply.details.failed.includes(name), name);
    await admin.query('REVOKE ALL ON public.check_intake_items FROM sql89_other; DROP ROLE sql89_other');
    assert.deepEqual(await catalog(admin), start);

    const apply = (overrides = {}, ctx = {}) => executeSql89ProductionApply(manifest(overrides), { root: ROOT, pin: PIN, connect, consumedPath: consumedPath(), ...ctx });
    const refusedThenRestored = async (label, breakIt, restore, code, failures = null, { as = 'checksops_admin' } = {}) => {
      const breaker = await connectAs(as);
      try {
        await breaker.query(breakIt);
        const refused = await inspect();
        assert.equal(refused.details.apply_preconditions_met, false, label);
        if (failures) assert.deepEqual(refused.details.precondition_failures, failures, label);
        const applyRefused = await apply();
        assert.equal(applyRefused.code, code, `${label}: ${JSON.stringify(applyRefused)}`);
        await breaker.query(restore);
      } finally {
        await breaker.end();
      }
      const restored = await inspect();
      assert.equal(restored.details.apply_preconditions_met, true, `${label} restored: ${JSON.stringify(restored.details.precondition_failures)}`);
      assert.deepEqual(await catalog(admin), start, `${label} restored`);
    };
    await refusedThenRestored('grant option',
      'GRANT UPDATE (status) ON public.check_intake_items TO checksops WITH GRANT OPTION',
      'REVOKE GRANT OPTION FOR UPDATE (status) ON public.check_intake_items FROM checksops; REVOKE UPDATE (status) ON public.check_intake_items FROM checksops',
      CODES.DEPLOYMENT_COLLISION, ['no_grantee_grant_option']);
    await refusedThenRestored('table ACL drift',
      'GRANT SELECT ON public.check_intake_items TO authenticated',
      'REVOKE SELECT ON public.check_intake_items FROM authenticated',
      CODES.DEPLOYMENT_COLLISION, ['table_acl_as_inspected']);
    await refusedThenRestored('a column SQL 89 grants is missing',
      'ALTER TABLE public.check_intake_items RENAME COLUMN return_source TO return_source_x',
      'ALTER TABLE public.check_intake_items RENAME COLUMN return_source_x TO return_source',
      CODES.DEPLOYMENT_COLLISION, ['sql89_columns_present', 'updatable_columns_as_inspected']);
    await refusedThenRestored('an INVOKER function UPDATEs the table',
      "CREATE FUNCTION public.sql89_invoker() RETURNS void LANGUAGE sql AS $$ UPDATE public.check_intake_items SET tenant_id = NULL WHERE false $$",
      'DROP FUNCTION public.sql89_invoker()',
      CODES.DEPLOYMENT_COLLISION, ['update_functions_safe']);
    await refusedThenRestored('a SECURITY DEFINER function owned by checksops UPDATEs the table',
      "CREATE FUNCTION public.sql89_owned() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ UPDATE public.check_intake_items SET tenant_id = NULL WHERE false $$; ALTER FUNCTION public.sql89_owned() OWNER TO checksops",
      'DROP FUNCTION public.sql89_owned()',
      CODES.DEPLOYMENT_COLLISION, ['update_functions_safe'], { as: 'ubuntu' });
    await refusedThenRestored('SQL 70 ingest missing',
      'ALTER FUNCTION public.aws_ingest_shared_check(jsonb) RENAME TO aws_ingest_shared_check_x',
      'ALTER FUNCTION public.aws_ingest_shared_check_x(jsonb) RENAME TO aws_ingest_shared_check',
      CODES.DEPLOYMENT_COLLISION, ['sql70_ingest_function_security_definer']);
    await refusedThenRestored('SQL 70 ingest is SECURITY INVOKER',
      'ALTER FUNCTION public.aws_ingest_shared_check(jsonb) SECURITY INVOKER',
      'ALTER FUNCTION public.aws_ingest_shared_check(jsonb) SECURITY DEFINER',
      CODES.DEPLOYMENT_COLLISION, ['update_functions_safe', 'sql70_ingest_function_security_definer']);
    // A pin recorded from a different inspect is drift too.
    const stalePin = authorizedPin({ columns: SQL89_COLUMNS });
    const stale = await executeSql89ProductionApply(manifest(), { root: ROOT, pin: stalePin, connect, consumedPath: consumedPath() });
    assert.equal(stale.code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual(stale.details.failed, ['updatable_columns_as_inspected']);
    // The manifest's live hash must be the pinned one.
    assert.equal((await apply({ live_definition_sha256: 'f'.repeat(64) })).code, CODES.SQL_COLLISION);
    assert.deepEqual(await catalog(admin), start);

    // A file that also changes something else is rolled back at the postconditions.
    const withExtra = (extra) => async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql) === SQL89_TEXT ? query(`${sql}\n${extra}`, params) : query(sql, params));
      return client;
    };
    for (const [label, extra, failure] of [
      ['extra column', 'GRANT UPDATE (tenant_id) ON TABLE public.check_intake_items TO checksops;', 'updatable_columns_exact'],
      ['table-level UPDATE back', 'GRANT UPDATE ON TABLE public.check_intake_items TO checksops;', 'no_table_level_update'],
      ['table-level UPDATE via PUBLIC', 'GRANT UPDATE ON TABLE public.check_intake_items TO PUBLIC;', 'no_table_level_update'],
      ['INSERT revoked', 'REVOKE INSERT ON TABLE public.check_intake_items FROM checksops;', 'other_table_privileges_unchanged'],
      ['DELETE revoked', 'REVOKE DELETE ON TABLE public.check_intake_items FROM checksops;', 'other_table_privileges_unchanged'],
      ['other grantee', 'GRANT UPDATE (status) ON TABLE public.check_intake_items TO authenticated;', 'authenticated_and_public_hold_no_update'],
      ['PUBLIC column UPDATE', 'GRANT UPDATE (status) ON TABLE public.check_intake_items TO PUBLIC;', 'authenticated_and_public_hold_no_update'],
      ['INSERT granted to authenticated', 'GRANT INSERT ON TABLE public.check_intake_items TO authenticated;', 'other_table_acl_unchanged'],
    ]) {
      const result = await apply({}, { connect: withExtra(extra) });
      assert.equal(result.code, CODES.UNRELATED_MUTATION, `${label}: ${JSON.stringify(result)}`);
      assert.ok(result.details.failed.includes(failure), `${label}: ${JSON.stringify(result.details)}`);
      assert.deepEqual(await catalog(admin), start, label);
    }
    const unrelated = await apply({}, { connect: withExtra('GRANT INSERT ON public.claims TO checksops;') });
    assert.equal(unrelated.code, CODES.UNRELATED_MUTATION, JSON.stringify(unrelated));
    assert.deepEqual(unrelated.details.failed, []);
    assert.ok(unrelated.details.unrelated_changed.includes('relations'), JSON.stringify(unrelated.details));
    const sameTable = await apply({}, { connect: withExtra('ALTER TABLE public.check_intake_items DISABLE ROW LEVEL SECURITY;') });
    assert.equal(sameTable.code, CODES.UNRELATED_MUTATION, JSON.stringify(sameTable));
    assert.ok(sameTable.details.unrelated_changed.includes('check_intake_items_except_acl'), JSON.stringify(sameTable.details));
    const failing = await apply({}, { connect: withExtra('GRANT UPDATE (amount) ON TABLE public.check_intake_items TO sql89_missing_role;') });
    assert.equal(failing.code, CODES.SQL_COLLISION, JSON.stringify(failing));
    assert.match(failing.message, /rolled back/);
    assert.deepEqual(await catalog(admin), start);

    // The apply.
    const consumed = consumedPath();
    const input = manifest();
    const applied = await executeSql89ProductionApply(input, { root: ROOT, pin: PIN, connect, consumedPath: consumed });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const r = applied.details.receipt;
    assert.equal(r.migration, 'sql89');
    assert.equal(r.before_hash, PROD_PRE);
    assert.equal(r.after_hash, INTENDED);
    assert.equal(r.table_level_update_before, true);
    assert.equal(r.table_level_update, false);
    assert.deepEqual(r.updatable_columns_before, ALL_COLUMNS);
    assert.deepEqual(r.updatable_columns_after, [...SQL89_COLUMNS]);
    assert.deepEqual(r.columns_lost_update, Object.keys(NOT_GRANTED_COLUMNS).sort());
    assert.deepEqual(r.columns_gained_update, []);
    assert.deepEqual(r.column_update_entries_after, POST_ENTRIES);
    assert.equal(r.table_acl, PROD_ACL_AFTER);
    assert.equal(r.staging_acceptance, STAGING_REF);
    const end = await catalog(admin);
    assert.deepEqual(end, { ...start, table_level: false, table_acl: PROD_ACL_AFTER, updatable: [...SQL89_COLUMNS] });

    const after = await inspect();
    assert.equal(after.details.live_definition_sha256, INTENDED);
    assert.equal(after.details.already_applied, true);
    assert.equal(after.details.table_level_update, false);
    assert.equal(after.details.apply_preconditions_met, false);
    assert.deepEqual(after.details.updatable_columns, [...SQL89_COLUMNS]);
    assert.deepEqual(after.details.columns_losing_update, []);

    const replay = await executeSql89ProductionApply(input, { root: ROOT, pin: PIN, connect, consumedPath: consumed });
    assert.equal(replay.code, CODES.RECEIPT_REUSED);
    const reapply = await apply();
    assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
    assert.match(reapply.message, /already/);
    assert.deepEqual(await catalog(admin), end);

    // Every API UPDATE statement still runs as checksops; the columns SQL 89 does not grant are refused.
    const api = await runApiUpdatesAsChecksops(admin);
    assert.deepEqual(api.filter((x) => !x.ok), [], JSON.stringify(api.filter((x) => !x.ok)));
    assert.ok(api.length >= 26, String(api.length));
    // The live production bytes' statements too, when the snapshot is in history.
    if (liveProductionSources()) {
      const liveApi = await runApiUpdatesAsChecksops(admin, { live: true });
      assert.deepEqual(liveApi.filter((x) => !x.ok), [], JSON.stringify(liveApi.filter((x) => !x.ok)));
      assert.ok(liveApi.length > api.length, String(liveApi.length));
    }
    const refusedColumns = await behaviourAsChecksops(admin);
    assert.deepEqual(refusedColumns, Object.fromEntries(Object.keys(NOT_GRANTED_COLUMNS).map((c) => [c, '42501'])));
    assert.deepEqual(await catalog(admin), end);
  } finally {
    await admin.end();
    server.stop();
  }
}));

test('PostgreSQL 16, staging-like (column grants, SELECT/INSERT/DELETE table-level): the apply converges on exactly the 43 columns, then refuses as already applied', { timeout: 300000 }, async (t) => withPg(t, async (pg) => {
  const { server, admin, connectAs } = await fixture(pg, 'pg-sql89-stg-', 57900, STAGING_GRANTS);
  try {
    const startColumns = [...STAGING_REPO_COLUMNS, 'detected_claim_number'].sort();
    const startAcl = '{checksops_admin=arwdDxt/checksops_admin,checksops=ard/checksops_admin}';
    const start = await catalog(admin);
    assert.equal(start.table_level, false);
    assert.equal(start.table_acl, startAcl);
    assert.deepEqual(start.updatable, startColumns);
    const live = stateHash(false, startColumns);
    const pin = authorizedPin({ live, acl: startAcl, columns: startColumns });
    const connect = async () => connectAs('checksops_admin');

    // Before SQL 89 some API statements fail here (the repo-recorded staging grants lack columns the code writes).
    const apiBefore = await runApiUpdatesAsChecksops(admin);
    assert.ok(apiBefore.some((x) => !x.ok && x.code === '42501'), 'the repo-recorded staging grants miss columns the API writes');

    const before = await inspectSql89Production({ connect, pin, root: ROOT });
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(before.details.live_definition_sha256, live);
    assert.deepEqual(before.details.precondition_failures, []);
    assert.equal(before.details.apply_preconditions_met, true);
    assert.deepEqual(before.details.columns_losing_update, ['detected_claim_number']);
    const toGrant = SQL89_COLUMNS.filter((c) => !STAGING_REPO_COLUMNS.includes(c));
    assert.deepEqual(before.details.columns_to_grant, toGrant);
    assert.deepEqual(toGrant, [
      'back_image_deposit_path', 'endorsement_override', 'endorsement_packet_path', 'endorsement_render_meta', 'endorsement_render_status',
      'ocr_status', 'pre_return_stage', 'return_code', 'return_notes', 'return_reason', 'return_recorded_by', 'return_resolution',
      'return_resolved_at', 'return_source', 'returned_at',
    ]);

    const applied = await executeSql89ProductionApply(manifest({}, live), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, INTENDED);
    assert.deepEqual(applied.details.receipt.columns_lost_update, ['detected_claim_number']);
    assert.deepEqual(applied.details.receipt.columns_gained_update, toGrant);
    const end = await catalog(admin);
    assert.deepEqual(end, { ...start, updatable: [...SQL89_COLUMNS] });

    // Converged: the same post-state as production; a second run refuses as already applied.
    const after = await inspectSql89Production({ connect, pin, root: ROOT });
    assert.equal(after.details.already_applied, true);
    assert.equal(after.details.live_definition_sha256, INTENDED);
    const again = await executeSql89ProductionApply(manifest({}, live), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(again.code, CODES.UNRELATED_MUTATION);
    // Run as the owner, the file itself is idempotent: a second run leaves the same catalog.
    const owner = await connectAs('checksops_admin');
    try {
      await owner.query('BEGIN');
      await owner.query(SQL89_TEXT);
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }
    assert.deepEqual(await catalog(admin), end);

    const api = await runApiUpdatesAsChecksops(admin);
    assert.deepEqual(api.filter((x) => !x.ok), []);
    const refusedColumns = await behaviourAsChecksops(admin);
    assert.deepEqual(refusedColumns, Object.fromEntries(Object.keys(NOT_GRANTED_COLUMNS).map((c) => [c, '42501'])));
  } finally {
    await admin.end();
    server.stop();
  }
}));

// Staging as read-live run 82 found it: checksops is a member of authenticated (aws/rls/sql/01_role_shim.sql),
// authenticated holds UPDATE (detected_claim_number, deposit_recommendation) and PUBLIC UPDATE on one column.
const INHERITED_GRANTS = `GRANT SELECT, INSERT, DELETE ON TABLE public.check_intake_items TO checksops;
  GRANT UPDATE (${STAGING_REPO_COLUMNS.join(', ')}) ON TABLE public.check_intake_items TO checksops;
  GRANT SELECT ON TABLE public.check_intake_items TO authenticated;
  GRANT UPDATE (detected_claim_number, deposit_recommendation) ON TABLE public.check_intake_items TO authenticated;
  GRANT UPDATE (freedom_claim_number) ON TABLE public.check_intake_items TO PUBLIC;`;
// The file as staging apply run 85 ran it: only checksops' own UPDATE revoked.
const OLD_SQL89_TEXT = SQL89_TEXT
  .replace('REVOKE UPDATE ON TABLE public.check_intake_items FROM authenticated;\n', '')
  .replace('REVOKE UPDATE ON TABLE public.check_intake_items FROM PUBLIC;\n', '');

const roleUpdate = async (admin, role) => (await admin.query(`
  SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid = 'public.check_intake_items'::regclass AND attnum > 0 AND NOT attisdropped
      AND has_column_privilege($1, attrelid, attnum, 'UPDATE') ORDER BY attname::text COLLATE "C") AS updatable,
    has_table_privilege($1, 'public.check_intake_items', 'SELECT') AS sel,
    (SELECT count(*)::int FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x WHERE c.oid = 'public.check_intake_items'::regclass AND x.grantee = 0 AND x.privilege_type = 'UPDATE')
      + (SELECT count(*)::int FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid = 'public.check_intake_items'::regclass AND x.grantee = 0 AND x.privilege_type = 'UPDATE') AS public_update_entries`, [role])).rows[0];

test('PostgreSQL 16, staging-like with inherited UPDATE (checksops in authenticated; authenticated and PUBLIC hold UPDATE): the old file fails the postconditions; the new one lands exactly the 43; login members and third-role UPDATE refuse', { timeout: 300000 }, async (t) => withPg(t, async (pg) => {
  const { server, admin, connectAs } = await fixture(pg, 'pg-sql89-inh-', 55900, INHERITED_GRANTS);
  try {
    await admin.query('GRANT authenticated TO checksops');
    const startColumns = [...new Set([...STAGING_REPO_COLUMNS, 'detected_claim_number', 'freedom_claim_number'])].sort();
    const start = await catalog(admin);
    assert.equal(start.table_level, false);
    assert.deepEqual(start.updatable, startColumns);
    assert.deepEqual((await roleUpdate(admin, 'authenticated')).updatable, ['deposit_recommendation', 'detected_claim_number', 'freedom_claim_number']);
    const live = stateHash(false, startColumns);
    const pin = authorizedPin({ live, acl: start.table_acl, columns: startColumns });
    const connect = async () => connectAs('checksops_admin');
    const inspect = () => inspectSql89Production({ connect, pin, root: ROOT });
    const apply = (input = manifest({}, live), ctx = {}) => executeSql89ProductionApply(input, { root: ROOT, pin, connect, consumedPath: consumedPath(), ...ctx });
    // A row in the table: the inspect must not read or report it.
    await admin.query(`INSERT INTO public.check_intake_items (id, tenant_id, status, detected_claim_number) VALUES ('${ROW}', '${TENANT}', 'needs_review', 'CLM-SECRET-9')`);

    // Inspect: per-column UPDATE provenance, role names only.
    const before = await inspect();
    assert.equal(before.ok, true, JSON.stringify(before));
    const b = before.details;
    assert.equal(b.live_definition_sha256, live);
    assert.deepEqual(b.precondition_failures, []);
    assert.equal(b.apply_preconditions_met, true);
    assert.equal(b.authenticated_role_present, true);
    assert.deepEqual(b.grantee_member_of, ['authenticated']);
    assert.deepEqual(b.authenticated_members, [{ role: 'checksops', can_login: false }]);
    assert.deepEqual(b.other_login_authenticated_members, []);
    assert.deepEqual(b.other_inherited_update_roles, []);
    assert.deepEqual(b.update_grant_sources, [
      { grantee: 'checksops', table_level: false, columns: [...STAGING_REPO_COLUMNS].sort() },
      { grantee: 'PUBLIC', table_level: false, columns: ['freedom_claim_number'] },
      { grantee: 'authenticated', table_level: false, columns: ['deposit_recommendation', 'detected_claim_number'] },
    ]);
    assert.deepEqual(b.update_provenance.detected_claim_number, ['authenticated']);
    assert.deepEqual(b.update_provenance.deposit_recommendation, ['checksops', 'authenticated']);
    assert.deepEqual(b.update_provenance.freedom_claim_number, ['PUBLIC']);
    assert.deepEqual(b.update_provenance.amount, ['checksops']);
    assert.deepEqual(b.update_provenance.return_code, []);
    assert.deepEqual(Object.keys(b.update_provenance), [...new Set([...SQL89_COLUMNS, ...startColumns])].sort());
    assert.deepEqual(b.columns_losing_update, ['detected_claim_number', 'freedom_claim_number']);
    assert.equal(b.revoked_role_update_entries.length, 3);
    const text = JSON.stringify(b);
    for (const secret of [ROW, TENANT, 'CLM-SECRET-9']) assert.ok(!text.includes(secret), secret);
    assert.deepEqual(await catalog(admin), start, 'inspect changed nothing');

    // The bug: the old file (revoke checksops only) leaves inherited UPDATE; the tool rolls it back.
    const withText = (replacement) => async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql) === SQL89_TEXT ? query(replacement, params) : query(sql, params));
      return client;
    };
    const old = await apply(manifest({}, live), { connect: withText(OLD_SQL89_TEXT) });
    assert.equal(old.code, CODES.UNRELATED_MUTATION, JSON.stringify(old));
    for (const name of ['intended_state', 'updatable_columns_exact', 'authenticated_and_public_hold_no_update', 'update_only_from_grantee']) {
      assert.ok(old.details.failed.includes(name), `${name}: ${JSON.stringify(old.details.failed)}`);
    }
    assert.ok(old.details.updatable_columns_after.includes('detected_claim_number'));
    assert.ok(old.details.updatable_columns_after.includes('freedom_claim_number'));
    assert.deepEqual(await catalog(admin), start, 'rolled back');
    // The same through the shared rule directly, inside a transaction that is rolled back.
    const owner = await connectAs('checksops_admin');
    try {
      await owner.query('BEGIN');
      const s0 = (await readSql89State(owner)).details;
      await owner.query(OLD_SQL89_TEXT);
      const s1 = (await readSql89State(owner)).details;
      assert.deepEqual(s1.updatable_columns, [...SQL89_COLUMNS, 'detected_claim_number', 'freedom_claim_number'].sort());
      assert.ok(sql89ProductionPostconditionFailures(s0, s1, pin).includes('updatable_columns_exact'));
    } finally {
      await owner.query('ROLLBACK');
      await owner.end();
    }

    // Refusals, each restored: a LOGIN member of authenticated (directly or through a group) would lose UPDATE.
    const refused = async (label, breakIt, restore, failures) => {
      await admin.query(breakIt);
      try {
        const r = await inspect();
        assert.deepEqual(r.details.precondition_failures, failures, `${label}: ${JSON.stringify(r.details.precondition_failures)}`);
        assert.equal(r.details.apply_preconditions_met, false, label);
        const a = await apply();
        assert.equal(a.code, CODES.DEPLOYMENT_COLLISION, `${label}: ${JSON.stringify(a)}`);
        assert.deepEqual(a.details.failed, failures, label);
        return r.details;
      } finally {
        await admin.query(restore);
        assert.deepEqual((await inspect()).details.precondition_failures, [], `${label} restored`);
        assert.deepEqual(await catalog(admin), start, `${label} restored`);
      }
    };
    const web = await refused('LOGIN member', 'CREATE ROLE sql89_web LOGIN; GRANT authenticated TO sql89_web', 'DROP ROLE sql89_web',
      ['authenticated_has_no_other_login_members']);
    assert.deepEqual(web.other_login_authenticated_members, ['sql89_web']);
    assert.deepEqual(web.authenticated_members, [{ role: 'checksops', can_login: false }, { role: 'sql89_web', can_login: true }]);
    await refused('LOGIN member through a group',
      'CREATE ROLE sql89_group NOLOGIN; GRANT authenticated TO sql89_group; CREATE ROLE sql89_web LOGIN; GRANT sql89_group TO sql89_web',
      'DROP ROLE sql89_web; DROP ROLE sql89_group', ['authenticated_has_no_other_login_members']);
    await refused('UPDATE through a third role checksops is a member of',
      'CREATE ROLE sql89_writer NOLOGIN; GRANT UPDATE (status) ON public.check_intake_items TO sql89_writer; GRANT sql89_writer TO checksops',
      'REVOKE UPDATE ON public.check_intake_items FROM sql89_writer; DROP ROLE sql89_writer', ['no_other_inherited_update']);
    await refused('UPDATE through a role authenticated is a member of',
      'CREATE ROLE sql89_writer NOLOGIN; GRANT UPDATE (status) ON public.check_intake_items TO sql89_writer; GRANT sql89_writer TO authenticated',
      'REVOKE UPDATE ON public.check_intake_items FROM sql89_writer; DROP ROLE sql89_writer', ['no_other_inherited_update']);
    // An ADMIN-only membership confers no privileges: not refused, not listed.
    await admin.query('CREATE ROLE sql89_admin_only LOGIN; GRANT authenticated TO sql89_admin_only WITH ADMIN TRUE, INHERIT FALSE, SET FALSE');
    const adminOnly = await inspect();
    assert.deepEqual(adminOnly.details.precondition_failures, []);
    assert.deepEqual(adminOnly.details.authenticated_members, [{ role: 'checksops', can_login: false }]);
    await admin.query('DROP ROLE sql89_admin_only');

    // The apply.
    const input = manifest({}, live);
    const consumed = consumedPath();
    const applied = await executeSql89ProductionApply(input, { root: ROOT, pin, connect, consumedPath: consumed });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, live);
    assert.equal(applied.details.receipt.after_hash, INTENDED);
    assert.deepEqual(applied.details.receipt.columns_lost_update, ['detected_claim_number', 'freedom_claim_number']);
    const end = await catalog(admin);
    assert.deepEqual(end, { ...start, updatable: [...SQL89_COLUMNS], table_acl: end.table_acl });
    // SELECT, INSERT and DELETE unchanged for every role; authenticated and PUBLIC hold no UPDATE.
    assert.equal(end.table_acl, start.table_acl);
    const auth = await roleUpdate(admin, 'authenticated');
    assert.deepEqual(auth.updatable, []);
    assert.equal(auth.sel, true);
    assert.equal(auth.public_update_entries, 0);
    const after = await inspect();
    assert.equal(after.details.already_applied, true);
    assert.deepEqual(after.details.update_grant_sources, [{ grantee: 'checksops', table_level: false, columns: [...SQL89_COLUMNS] }]);
    assert.deepEqual(after.details.revoked_role_update_entries, []);
    assert.deepEqual(Object.keys(after.details.update_provenance), [...SQL89_COLUMNS]);
    assert.ok(Object.values(after.details.update_provenance).every((v) => JSON.stringify(v) === '["checksops"]'));

    // Replay and re-apply refused.
    assert.equal((await executeSql89ProductionApply(input, { root: ROOT, pin, connect, consumedPath: consumed })).code, CODES.RECEIPT_REUSED);
    const again = await apply();
    assert.equal(again.code, CODES.UNRELATED_MUTATION);
    assert.match(again.message, /already/);
    assert.deepEqual(await catalog(admin), end);

    // Every API UPDATE path still works as checksops; columns SQL 89 does not grant are refused.
    await admin.query(`DELETE FROM public.check_intake_items WHERE id = '${ROW}'`);
    const api = await runApiUpdatesAsChecksops(admin);
    assert.deepEqual(api.filter((x) => !x.ok), [], JSON.stringify(api.filter((x) => !x.ok)));
    const refusedColumns = await behaviourAsChecksops(admin);
    assert.deepEqual(refusedColumns, Object.fromEntries(Object.keys(NOT_GRANTED_COLUMNS).map((c) => [c, '42501'])));
  } finally {
    await admin.end();
    server.stop();
  }
}));
