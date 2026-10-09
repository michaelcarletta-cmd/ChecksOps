import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { evaluateDeployment } from '../../scripts/deployment-guard/lib/guard.mjs';
import { validateReceiptShape } from '../../scripts/deployment-guard/lib/receipt.mjs';
import {
  AUTHORIZED_SQL44,
  AUTHORIZED_SQL53,
  evaluateSqlExecutorAuthorization,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { evaluateSql53StagingApply } from '../../scripts/deployment-guard/lib/sql53-staging-apply.mjs';
import {
  evaluateSql53FailClosedSurfaces,
  evaluateSql53StagingExecutionPreflight,
  hashFileSha256,
  loadSql53ExecutionPreflight,
} from '../../scripts/deployment-guard/lib/sql53-staging-execution-preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = loadSql53ExecutionPreflight(ROOT);
const NOW = '2026-10-09T16:00:00.000Z';

const authorizeInput = (overrides = {}) => ({
  workstream_id: 'staging-sql53-3bc9',
  branch: 'cursor/staging-sql53-execution-preflight-3bc9',
  commit: PIN.invoke_auth_commit,
  operator: 'test-agent',
  target_environment: 'staging',
  target_component: 'staging-sql',
  deployment_type: 'sql-executor-invoke',
  owned_components: [PIN.filename],
  filename: PIN.filename,
  migration_id: PIN.migration_id,
  source_sha256: PIN.source_sha256,
  intended_replacement_sha256: PIN.intended_replacement_sha256,
  expected_live_definition_sha256: PIN.absent_live_definition_sha256,
  action: 'authorize',
  apply: false,
  execute: false,
  ensure: false,
  invoke: false,
  issue_receipt: false,
  build_timestamp: NOW,
  ...overrides,
});

test('execution preflight pin is source-only, GO-false, and matches approved SQL 53 hashes', () => {
  assert.equal(PIN.go, false);
  assert.equal(PIN.apply_authorized, false);
  assert.equal(PIN.execute, false);
  assert.equal(PIN.ensure_authorized, false);
  assert.equal(PIN.invoke_authorized, false);
  assert.equal(PIN.phase2_authorized, false);
  assert.equal(PIN.receipt_issued, false);
  assert.equal(PIN.one_use_id, null);
  assert.equal(PIN.authorization, 'source-only');
  assert.equal(PIN.target_environment, 'staging');
  assert.equal(PIN.deployment_type, 'sql-executor-invoke');
  assert.equal(PIN.function_name, 'checksops-staging-guarded-sql-executor');
  assert.equal(PIN.merged_source_commit, 'b35680ea044f2b1e857deafd8314e4639591daf3');
  assert.equal(PIN.ensure_source_commit, 'b35680ea044f2b1e857deafd8314e4639591daf3');
  assert.equal(PIN.invoke_auth_commit, AUTHORIZED_SQL53.commit);
  assert.equal(PIN.commit, AUTHORIZED_SQL53.commit);
  assert.equal(PIN.source_sha256, AUTHORIZED_SQL53.source_sha256);
  assert.equal(PIN.intended_replacement_sha256, AUTHORIZED_SQL53.intended_replacement_sha256);
  assert.equal(PIN.absent_live_definition_sha256, AUTHORIZED_SQL53.absent_live_definition_sha256);
  assert.equal(hashFileSha256(ROOT, PIN.filename), PIN.source_sha256);
  assert.equal(PIN.historical_absent_inspect.workflow_run, 37947042060);
  assert.equal(PIN.historical_absent_inspect.exists, false);
  assert.equal(PIN.historical_absent_inspect.fresh, false);
  assert.equal(PIN.live_executor_inspect.completed, false);
  assert.equal(PIN.release_locks.staging_sql53_locked, false);
  assert.ok(PIN.forbidden_owned_components.includes(AUTHORIZED_SQL44.filename));
  assert.ok(PIN.forbidden_owned_components.includes('supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql'));
  assert.ok(PIN.forbidden_owned_components.includes('supabase/migrations/20260918170040_one_check_received_writer.sql'));
  assert.ok(PIN.live_executor_inspect.expected_pack_members.includes('sql/53_claim_settlement_breakdown.sql'));
  assert.ok(PIN.live_executor_inspect.expected_pack_members.includes('lib/function-def-lookup.mjs'));
});

test('preflight JSON is not a live receipt', () => {
  const shape = validateReceiptShape(PIN, { requireMac: true });
  assert.equal(shape.ok, false);
  assert.ok([CODES.DEPLOYMENT_GUARD_REQUIRED, CODES.RECEIPT_FORGED].includes(shape.code), shape.code);
});

test('evaluate-only preflight stays GO-false even when historical inspect matches absent', () => {
  const result = evaluateSql53StagingExecutionPreflight(authorizeInput({
    inspect_workflow_run: 37947042060,
    inspect: {
      functions: [
        { identity: PIN.function_identity, exists: false, definitionSha256: null },
        { identity: 'public.sync_homeowner_ledger_from_check()', exists: true, definitionSha256: PIN.historical_absent_inspect.preserved_hashes['public.sync_homeowner_ledger_from_check()'] },
        { identity: 'public.aws_can_write_claim(uuid)', exists: true, definitionSha256: PIN.historical_absent_inspect.preserved_hashes['public.aws_can_write_claim(uuid)'] },
        { identity: 'public.hle_on_check_intake_insert()', exists: true, definitionSha256: PIN.historical_absent_inspect.preserved_hashes['public.hle_on_check_intake_insert()'] },
      ],
    },
  }), { root: ROOT });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.go, false);
  assert.equal(result.details.sql53_execution_preflight_ready, true);
  assert.equal(result.details.apply_authorized, false);
  assert.equal(result.details.ensure_authorized, false);
  assert.equal(result.details.invoke_authorized, false);
  assert.equal(result.details.receipt_issued, false);
  assert.equal(result.details.independent_execution_authorization_required, true);
  assert.equal(result.details.historical_inspect_is_not_immediately_before, true);
  assert.equal(result.details.live_executor_inspected, false);
  assert.equal(result.details.live_state, 'absent');
  assert.equal(result.details.immediately_before_inspect, false);
});

test('apply, ensure, invoke, and receipt issuance remain forbidden', () => {
  for (const override of [
    { apply: true },
    { execute: true },
    { ensure: true },
    { invoke: true },
    { issue_receipt: true },
    { acquire_lease: true },
    { action: 'apply' },
    { action: 'ensure' },
    { action: 'invoke' },
  ]) {
    const result = evaluateSql53StagingExecutionPreflight(authorizeInput(override), { root: ROOT });
    assert.equal(result.code, CODES.GUARD_APPLY_FORBIDDEN, JSON.stringify(override));
    assert.equal(result.details.go, false);
  }
});

test('production, unrelated migrations, and wrong hashes fail closed', () => {
  assert.equal(evaluateSql53StagingExecutionPreflight(authorizeInput({
    target_environment: 'production',
    target_component: 'production-sql',
  }), { root: ROOT }).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal(evaluateSql53StagingExecutionPreflight(authorizeInput({
    owned_components: [PIN.filename, 'supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql'],
  }), { root: ROOT }).code, CODES.UNRELATED_MUTATION);
  assert.equal(evaluateSql53StagingExecutionPreflight(authorizeInput({
    owned_components: [AUTHORIZED_SQL44.filename],
    filename: PIN.filename,
  }), { root: ROOT }).code, CODES.UNRELATED_MUTATION);
  assert.equal(evaluateSql53StagingExecutionPreflight(authorizeInput({
    source_sha256: '1'.repeat(64),
  }), { root: ROOT }).code, CODES.SQL_COLLISION);
  assert.equal(evaluateSql53StagingExecutionPreflight(authorizeInput({
    commit: PIN.ensure_source_commit,
  }), { root: ROOT }).code, CODES.SQL_COLLISION);
  assert.equal(evaluateSql53StagingExecutionPreflight(authorizeInput({
    deployment_type: 'sql-apply',
  }), { root: ROOT }).code, CODES.RECEIPT_MISMATCH);
  assert.equal(evaluateSql53StagingExecutionPreflight(authorizeInput({
    sql_text: 'CREATE FUNCTION public.other() RETURNS void AS $$ SELECT 1 $$',
  }), { root: ROOT }).code, CODES.UNRELATED_MUTATION);
});

test('existing or already-intended settlement function blocks create', () => {
  const exists = evaluateSql53StagingExecutionPreflight(authorizeInput({
    inspect: {
      exists: true,
      live_definition_sha256: '9'.repeat(64),
      functions: [{
        identity: PIN.function_identity,
        exists: true,
        definitionSha256: '9'.repeat(64),
      }],
    },
  }), { root: ROOT });
  assert.equal(exists.code, CODES.SQL_COLLISION);

  const intended = evaluateSql53StagingExecutionPreflight(authorizeInput({
    inspect: {
      exists: true,
      live_definition_sha256: PIN.intended_replacement_sha256,
      functions: [{
        identity: PIN.function_identity,
        exists: true,
        definitionSha256: PIN.intended_replacement_sha256,
      }],
    },
  }), { root: ROOT });
  assert.equal(intended.code, CODES.UNRELATED_MUTATION);
});

test('official fail-closed surfaces refuse drift, expiry, forged receipts, and unrelated SQL', () => {
  const surfaces = evaluateSql53FailClosedSurfaces({}, { root: ROOT });
  assert.equal(surfaces.ok, true, surfaces.message);
  assert.equal(surfaces.details.fail_closed, true);
  assert.equal(surfaces.details.sql_apply_apply_forbidden, true);
  assert.equal(surfaces.details.expired_authorization, true);
  assert.equal(surfaces.details.unrelated_migration, true);
  assert.equal(surfaces.details.existing_function_collision, true);
  assert.equal(surfaces.details.intended_already_present, true);
  assert.equal(surfaces.details.handwritten_receipt_forged, true);

  const applyPin = evaluateSql53StagingApply({
    workstream_id: 'staging-sql53-3bc9',
    branch: 'cursor/staging-sql53-auth-3bc9',
    commit: PIN.invoke_auth_commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-apply',
    owned_components: [PIN.filename],
    filename: PIN.filename,
    migration_id: PIN.migration_id,
    source_sha256: PIN.source_sha256,
    expected_live_definition_sha256: PIN.absent_live_definition_sha256,
    live_definition_sha256: PIN.absent_live_definition_sha256,
    exists: false,
    apply: true,
    action: 'apply',
    build_timestamp: NOW,
  }, { root: ROOT });
  assert.equal(applyPin.code, CODES.GUARD_APPLY_FORBIDDEN);

  const expired = evaluateSqlExecutorAuthorization({
    ...authorizeInput({
      one_use_id: 'sql53-preflight-expired',
      expiry: '2020-01-01T00:00:00.000Z',
    }),
  }, { now: Date.parse(NOW) });
  assert.equal(expired.code, CODES.RECEIPT_EXPIRED);

  const drift = evaluateSqlExecutorAuthorization({
    ...authorizeInput({
      one_use_id: 'sql53-preflight-drift',
      expiry: '2026-10-09T17:00:00.000Z',
      preflight_live_fingerprint: { sql: 'a'.repeat(64), one_use_id: 'sql53-preflight-drift' },
    }),
  }, { now: Date.parse(NOW) });
  assert.equal(drift.code, CODES.DEPLOYMENT_COLLISION);
});

test('evaluateDeployment does not treat this package as apply authority', () => {
  const result = evaluateDeployment(authorizeInput({
    one_use_id: 'sql53-preflight-eval',
    expiry: '2026-10-09T17:00:00.000Z',
    intended_replacement_sha256: PIN.intended_replacement_sha256,
    expected_live_definition_sha256: PIN.absent_live_definition_sha256,
    function_name: PIN.function_name,
    preflight_live_fingerprint: {
      sql: PIN.absent_live_definition_sha256,
      filename: PIN.filename,
      source_sha256: PIN.source_sha256,
      intended_replacement_sha256: PIN.intended_replacement_sha256,
      one_use_id: 'sql53-preflight-eval',
      commit: PIN.invoke_auth_commit,
    },
  }), { root: ROOT, skip_contracts: true });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.evaluation.sql_executor_allowed, true);
  assert.notEqual(PIN.invoke_authorized, true);
  assert.equal(PIN.go, false);
});

test('unguarded sql-executor-invoke and ensure retarget fail before AWS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql53-pre-'));
  const log = path.join(dir, 'aws-calls.log');
  const bin = path.join(dir, 'fake-aws');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 1\n`);
  fs.chmodSync(bin, 0o755);

  const invoke = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/sql-executor-invoke.mjs'),
    '--input', path.join(ROOT, 'ops/deployment-guard/sql53-staging-execution-preflight.json'),
  ], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      AWS_CLI: bin,
      HOME: dir,
      CHECKSOPS_DEPLOYMENT_GUARD_ROOT: dir,
    },
  });
  assert.notEqual(invoke.status, 0);
  assert.match(`${invoke.stderr}${invoke.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '');

  for (const name of ['checksops-staging-api', 'checksops-staging-sql44-2d41', 'checksops-production-prep-api']) {
    const ensure = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/deployment-guard/sql-executor-ensure.mjs'),
      '--function-name', name,
    ], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        AWS_CLI: bin,
        HOME: dir,
        CHECKSOPS_DEPLOYMENT_GUARD_ROOT: dir,
      },
    });
    assert.notEqual(ensure.status, 0, name);
    assert.match(`${ensure.stderr}${ensure.stdout}`, /UNRELATED_MUTATION|dedicated staging SQL executor|may only create/);
  }
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '');
});

test('evaluate CLI stays offline and reports GO-false plus fail-closed surfaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql53-cli-'));
  const log = path.join(dir, 'aws-calls.log');
  const bin = path.join(dir, 'fake-aws');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 1\n`);
  fs.chmodSync(bin, 0o755);
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/sql53-staging-execution-preflight.mjs'),
    '--input', path.join(ROOT, 'ops/deployment-guard/sql53-staging-execution-preflight.json'),
  ], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      AWS_CLI: bin,
      HOME: dir,
      CHECKSOPS_DEPLOYMENT_GUARD_ROOT: dir,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true, parsed.message);
  assert.equal(parsed.details.go, false);
  assert.equal(parsed.details.fail_closed.fail_closed, true);
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '');
});
