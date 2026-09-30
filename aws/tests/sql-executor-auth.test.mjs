import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { evaluateSqlApply, hashSqlDefinition } from '../../scripts/deployment-guard/lib/sql-apply.mjs';
import { evaluateDeployment } from '../../scripts/deployment-guard/lib/guard.mjs';
import {
  AUTHORIZED_SQL44,
  SQL_EXECUTOR_DEPLOYMENT_TYPE,
  authorizationFingerprint,
  evaluateSqlExecutorAuthorization,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { refuseUnguardedDeploy } from '../../scripts/deployment-guard/require-guard.mjs';
import { evidenceForPreservedPaths, loadCompositionRegistry, passingCompositionResults, requiredPreservedPaths } from '../../scripts/deployment-guard/lib/source-composition.mjs';
import { loadContractRegistry, passingContractResults } from '../../scripts/deployment-guard/lib/contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-09-29T18:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const EXPECTED_LIVE = 'af784b78408b77ed928d1c815309e8da3459e9ebd3f4f6068321b9f33dd2a078';

function executorInput(overrides = {}) {
  const preflight = {
    ...authorizationFingerprint({
      ...AUTHORIZED_SQL44,
      expected_live_definition_sha256: EXPECTED_LIVE,
      one_use_id: 'sql44-apply-0001',
    }),
    captured_at: NOW,
  };
  const evidence = evidenceForPreservedPaths(loadCompositionRegistry(ROOT), SQL_EXECUTOR_DEPLOYMENT_TYPE);
  const commit = overrides.commit || AUTHORIZED_SQL44.commit;
  const currentMain = overrides.current_main_sha || 'cccccccccccccccccccccccccccccccccccccccc';
  const mergeBase = overrides.merge_base_sha || 'cccccccccccccccccccccccccccccccccccccccc';
  return {
    workstream_id: 'claim-ledger',
    branch: 'cursor/ledger-guarded-main-a2a4',
    commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: SQL_EXECUTOR_DEPLOYMENT_TYPE,
    owned_components: [AUTHORIZED_SQL44.filename],
    filename: AUTHORIZED_SQL44.filename,
    migration_id: AUTHORIZED_SQL44.migration_id,
    source_sha256: AUTHORIZED_SQL44.source_sha256,
    intended_replacement_sha256: AUTHORIZED_SQL44.intended_replacement_sha256,
    expected_live_definition_sha256: EXPECTED_LIVE,
    one_use_id: 'sql44-apply-0001',
    expiry: new Date(Math.max(Date.now(), NOW_MS) + 15 * 60 * 1000).toISOString(),
    action: 'authorize',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    require_exclusive_lock: true,
    lease: {
      workstream_id: 'claim-ledger',
      component: 'staging-sql',
      environment: 'staging',
      commit,
      acquired_at: NOW,
      expiry: new Date(Math.max(Date.now(), NOW_MS) + 15 * 60 * 1000).toISOString(),
    },
    preflight_live_fingerprint: preflight,
    preflight,
    immediately_before: preflight,
    current_main_sha: currentMain,
    merge_base_sha: mergeBase,
    reconciled_with_main: true,
    git_ancestry: {
      method: 'git-merge-base',
      is_ancestor: true,
      current_main_sha: currentMain,
      merge_base_sha: mergeBase,
      commit,
    },
    live_members: evidence.live_members,
    candidate_members: evidence.candidate_members,
    accepted_paths_vs_main: evidence.accepted_paths_vs_main,
    worktree: '/tmp/worktree-ledger',
    ...overrides,
  };
}

test('source SQL 44 SHA matches the authorized binding', () => {
  const bytes = fs.readFileSync(path.join(ROOT, AUTHORIZED_SQL44.filename));
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha, AUTHORIZED_SQL44.source_sha256);
  assert.equal(hashSqlDefinition(bytes.toString('utf8')), AUTHORIZED_SQL44.intended_replacement_sha256);
});

test('sql-apply is not weakened by vpc_executor=true or missing live hash', () => {
  const missingLive = evaluateSqlApply({
    workstream_id: 'claim-ledger',
    branch: 'cursor/ledger-guarded-main-a2a4',
    commit: AUTHORIZED_SQL44.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    deployment_type: 'sql-apply',
    owned_components: [AUTHORIZED_SQL44.filename],
    filename: AUTHORIZED_SQL44.filename,
    migration_id: AUTHORIZED_SQL44.migration_id,
    source_sha256: AUTHORIZED_SQL44.source_sha256,
    expected_live_definition_sha256: EXPECTED_LIVE,
    vpc_executor: true,
    preflight_live_fingerprint: { sql: EXPECTED_LIVE },
    build_timestamp: NOW,
  });
  assert.equal(missingLive.ok, false);
  assert.equal(missingLive.code, CODES.SQL_COLLISION);

  const drifted = evaluateSqlApply({
    workstream_id: 'claim-ledger',
    branch: 'cursor/ledger-guarded-main-a2a4',
    commit: AUTHORIZED_SQL44.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    deployment_type: 'sql-apply',
    owned_components: [AUTHORIZED_SQL44.filename],
    filename: AUTHORIZED_SQL44.filename,
    migration_id: AUTHORIZED_SQL44.migration_id,
    source_sha256: AUTHORIZED_SQL44.source_sha256,
    expected_live_definition_sha256: EXPECTED_LIVE,
    live_definition_sha256: '1'.repeat(64),
    vpc_executor: true,
    preflight_live_fingerprint: { sql: EXPECTED_LIVE },
    build_timestamp: NOW,
  });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, CODES.SQL_COLLISION);
});

test('executor authorization binds workstream, staging sql, commit, file, and hashes', () => {
  const okAuth = evaluateSqlExecutorAuthorization(executorInput());
  assert.equal(okAuth.ok, true, okAuth.message);
  assert.equal(okAuth.details.live_hash_deferred_to_executor, true);
  assert.equal(okAuth.details.sql_apply_live_hash_not_skipped, true);
});

test('executor refuses production, arbitrary SQL, and forbidden actions', () => {
  assert.equal(evaluateSqlExecutorAuthorization(executorInput({
    target_environment: 'production',
    target_component: 'production-sql',
  })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal(evaluateSqlExecutorAuthorization(executorInput({
    sql_text: 'DROP TABLE public.claims',
  })).code, CODES.UNRELATED_MUTATION);
  assert.equal(evaluateSqlExecutorAuthorization(executorInput({
    action: 'create_new',
  })).code, CODES.UNRELATED_MUTATION);
  assert.equal(evaluateSqlExecutorAuthorization(executorInput({
    function_name: 'checksops-staging-api',
  })).code, CODES.UNRELATED_MUTATION);
  assert.equal(evaluateSqlExecutorAuthorization(executorInput({
    function_name: 'checksops-staging-sql44-2d41',
  })).code, CODES.UNRELATED_MUTATION);
});

test('executor refuses a different commit, file, or replacement hash', () => {
  assert.equal(evaluateSqlExecutorAuthorization(executorInput({
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    build_timestamp: NOW,
  })).code, CODES.SQL_COLLISION);
  assert.equal(evaluateSqlExecutorAuthorization(executorInput({
    filename: 'aws/write-path/sql/43_review_save_detected_claim_number.sql',
    migration_id: '43_review_save_detected_claim_number',
  })).code, CODES.SQL_COLLISION);
  assert.equal(evaluateSqlExecutorAuthorization(executorInput({
    intended_replacement_sha256: '2'.repeat(64),
  })).code, CODES.SQL_COLLISION);
});

test('executor refuses expired one-use packages', () => {
  const expired = evaluateSqlExecutorAuthorization(executorInput({
    expiry: '2026-09-29T17:59:00.000Z',
  }), { now: NOW_MS });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, CODES.RECEIPT_EXPIRED);
});

test('evaluateDeployment routes sql-executor-invoke without skipping sql-apply collision', () => {
  const allowed = evaluateDeployment(executorInput(), { root: ROOT, skip_contracts: true });
  assert.equal(allowed.ok, true, allowed.message);
  assert.equal(allowed.details.evaluation.sql_executor_allowed, true);

  const sqlApply = evaluateDeployment({
    ...executorInput(),
    deployment_type: 'sql-apply',
    vpc_executor: true,
  }, { root: ROOT, skip_contracts: true });
  assert.equal(sqlApply.ok, false);
  assert.equal(sqlApply.code, CODES.SQL_COLLISION);
});

test('sql-apply receipt cannot authorize executor invoke', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql-exec-'));
  const lease = acquireLease(root, {
    workstream_id: 'claim-ledger',
    component: 'staging-sql',
    environment: 'staging',
    commit: AUTHORIZED_SQL44.commit,
  }, NOW_MS);
  assert.equal(lease.ok, true, lease.message);
  const issued = issueReceipt(root, {
    workstream_id: 'claim-ledger',
    branch: 'cursor/ledger-guarded-main-a2a4',
    commit: AUTHORIZED_SQL44.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-apply',
    owned_components: [AUTHORIZED_SQL44.filename],
    preflight_live_fingerprint: { sql: EXPECTED_LIVE },
    lease: lease.details.lease,
  }, { now: NOW_MS });
  assert.equal(issued.ok, true, issued.message);
  const refused = refuseUnguardedDeploy({
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: SQL_EXECUTOR_DEPLOYMENT_TYPE,
    workstream_id: 'claim-ledger',
    commit: AUTHORIZED_SQL44.commit,
    receipt: issued.details.receipt,
  }, { root, now: NOW_MS + 1000, env: {} });
  // Intact sql-apply receipt used for a different deployment_type.
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CODES.RECEIPT_MISMATCH);
});

function officialSqlObservation(commit, fingerprint) {
  const files = requiredPreservedPaths(loadCompositionRegistry(ROOT), {
    deployment_type: SQL_EXECUTOR_DEPLOYMENT_TYPE,
  });
  const artifact = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql-artifact-'));
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql-live-'));
  for (const rel of files) {
    const bytes = String(rel).endsWith('.sql')
      ? execFileSync('git', ['show', `${commit}:${rel}`], { cwd: ROOT })
      : fs.readFileSync(path.join(ROOT, rel));
    for (const root of [artifact, baseline]) {
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
    }
  }
  return {
    deployment_artifact: { path: artifact, commit, kind: 'sql-bundle' },
    live_baseline: {
      path: baseline,
      origin: 'fresh-live-download',
      kind: 'sql-bundle',
      fingerprint,
    },
  };
}

test('official preflight forwards executor authorization fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql-pre-'));
  const input = executorInput();
  delete input.candidate_members;
  delete input.live_members;
  delete input.git_ancestry;
  delete input.accepted_paths_vs_main;
  delete input.current_main_sha;
  delete input.merge_base_sha;
  const observation = officialSqlObservation(input.commit, input.preflight);
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, `${JSON.stringify({
    ...input,
    ...observation,
    contract_results: {
      ...passingContractResults(loadContractRegistry(ROOT)),
      ...passingCompositionResults(loadCompositionRegistry(ROOT)),
    },
  })}\n`);
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/preflight.mjs'),
    '--input', file,
    '--environment', 'staging',
    '--component', 'staging-sql',
    '--type', 'sql-executor-invoke',
    '--workstream-id', 'claim-ledger',
    '--commit', AUTHORIZED_SQL44.commit,
  ], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, CHECKSOPS_DEPLOYMENT_GUARD_ROOT: dir } });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true, parsed.message);
  assert.equal(parsed.details.evaluation.sql_executor_allowed, true);
});

test('unguarded sql-executor-invoke fails before AWS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql-inv-'));
  const log = path.join(dir, 'aws-calls.log');
  const bin = path.join(dir, 'fake-aws');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 1\n`);
  fs.chmodSync(bin, 0o755);
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/sql-executor-invoke.mjs'),
  ], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      AWS_CLI: bin,
      HOME: dir,
      CHECKSOPS_DEPLOYMENT_GUARD_ROOT: dir,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '');
});

test('sql-executor-ensure refuses shared API and billing sql44 retarget before AWS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql-ens-'));
  const log = path.join(dir, 'aws-calls.log');
  const bin = path.join(dir, 'fake-aws');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 1\n`);
  fs.chmodSync(bin, 0o755);
  for (const name of ['checksops-staging-api', 'checksops-staging-sql44-2d41']) {
    const result = spawnSync(process.execPath, [
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
    assert.notEqual(result.status, 0, name);
    assert.match(`${result.stderr}${result.stdout}`, /UNRELATED_MUTATION|dedicated staging SQL executor|may only create/);
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '', name);
  }
});
