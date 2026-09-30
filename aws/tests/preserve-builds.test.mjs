import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { evaluateDeployment } from '../../scripts/deployment-guard/lib/guard.mjs';
import {
  evaluateAcceptedContracts,
  loadContractRegistry,
  passingContractResults,
} from '../../scripts/deployment-guard/lib/contracts.mjs';
import { evaluatePackageProvenance, evaluateDistFreshness } from '../../scripts/deployment-guard/lib/packages.mjs';
import { evaluateSpaPromote } from '../../scripts/deployment-guard/lib/spa-promote.mjs';
import {
  evaluateAcceptedSourceComposition,
  loadCompositionRegistry,
  passingCompositionResults,
  requiredPreservedPaths,
} from '../../scripts/deployment-guard/lib/source-composition.mjs';
import {
  evaluateExclusiveDeployLock,
  evaluateFreshLiveFingerprint,
  evaluateNoAutomaticRollback,
  evaluatePreserveBuilds,
  evaluateRequiredRegressionChecks,
} from '../../scripts/deployment-guard/lib/preserve-builds.mjs';
import { evaluateWorktreeIsolation } from '../../scripts/deployment-guard/lib/worktree.mjs';
import { scanRepository } from '../../scripts/deployment-guard/scan-bypass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MAIN = 'cccccccccccccccccccccccccccccccccccccccc';
const STALE_MAIN = 'dddddddddddddddddddddddddddddddddddddddd';
const NOW = '2026-09-30T16:00:00.000Z';

function spaFiles() {
  return requiredPreservedPaths(loadCompositionRegistry(ROOT), { deployment_type: 'spa-promote' });
}

function mutatingBase(overrides = {}) {
  return {
    workstream_id: 'cursor/preserve-a',
    branch: 'cursor/preserve-a',
    commit: SHA,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-frontend',
    deployment_type: 'spa-promote',
    owned_components: ['index.html'],
    owned_members: ['index.html'],
    worktree: '/tmp/worktree-a',
    current_main_sha: MAIN,
    merge_base_sha: MAIN,
    reconciled_with_main: true,
    build_timestamp: NOW,
    preflight: { index_html_sha256: 'idx-1', entry_bundle: '/assets/index-aaa.js' },
    preflight_live_fingerprint: { index_html_sha256: 'idx-1', entry_bundle: '/assets/index-aaa.js' },
    immediately_before: { index_html_sha256: 'idx-1', entry_bundle: '/assets/index-aaa.js' },
    dist: { clean_build: true },
    clean_build: true,
    frontend_workstreams: ['cursor/preserve-a'],
    source_composition_manifest: { files: spaFiles() },
    ...overrides,
  };
}

test('independent chats cannot share a branch or worktree', () => {
  const sharedBranch = evaluateWorktreeIsolation({
    workstream_id: 'cursor/a',
    branch: 'cursor/shared',
    worktree: '/tmp/wt-a',
    deployment_type: 'spa-promote',
    peer_workstreams: [{ workstream_id: 'cursor/b', branch: 'cursor/shared', worktree: '/tmp/wt-b' }],
  });
  assert.equal(sharedBranch.ok, false);
  assert.equal(sharedBranch.code, CODES.WORKTREE_ISOLATION_REQUIRED);

  const sharedTree = evaluateWorktreeIsolation({
    workstream_id: 'cursor/a',
    branch: 'cursor/a',
    worktree: '/tmp/shared',
    deployment_type: 'lambda-overlay',
    peer_workstreams: [{ workstream_id: 'cursor/b', branch: 'cursor/b', worktree: '/tmp/shared' }],
  });
  assert.equal(sharedTree.ok, false);
  assert.equal(sharedTree.code, CODES.WORKTREE_ISOLATION_REQUIRED);
});

test('cursor chats cannot deploy from main or a mixed dirty worktree', () => {
  const fromMain = evaluateWorktreeIsolation({
    workstream_id: 'cursor/hotfix',
    branch: 'main',
    cursor_chat: true,
    deployment_type: 'lambda-overlay',
  });
  assert.equal(fromMain.ok, false);
  assert.equal(fromMain.code, CODES.WORKTREE_ISOLATION_REQUIRED);

  const dirty = evaluateWorktreeIsolation({
    workstream_id: 'cursor/a',
    branch: 'cursor/a',
    worktree: '/tmp/wt-a',
    dirty_unrelated_paths: ['src/components/payments/ClaimLedgerCard.tsx'],
    deployment_type: 'spa-promote',
  });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.code, CODES.UNRELATED_MUTATION);
});

test('mutating deploy must reconcile against current main', () => {
  const missing = evaluatePreserveBuilds(mutatingBase({
    current_main_sha: null,
    merge_base_sha: null,
  }), { skip_contracts: true, compositionRegistry: loadCompositionRegistry(ROOT) });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.MAIN_RECONCILIATION_REQUIRED);

  const stale = evaluatePreserveBuilds(mutatingBase({
    current_main_sha: MAIN,
    merge_base_sha: STALE_MAIN,
    reconciled_with_main: false,
  }), { skip_contracts: true, compositionRegistry: loadCompositionRegistry(ROOT) });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, CODES.MAIN_RECONCILIATION_REQUIRED);
});

test('unowned accepted paths that diverged from main require reconciliation', () => {
  const result = evaluatePreserveBuilds(mutatingBase({
    accepted_paths_vs_main: [{
      path: 'src/components/payments/ClaimLedgerCard.tsx',
      main: 'main-hash',
      candidate: 'other-chat-hash',
    }],
  }), { skip_contracts: true, compositionRegistry: loadCompositionRegistry(ROOT) });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_RECONCILIATION_REQUIRED);
});

test('accepted_composition boolean is not enough without preserved paths', () => {
  const result = evaluateAcceptedSourceComposition({
    registry: loadCompositionRegistry(ROOT),
    deployment_type: 'spa-promote',
    accepted_composition: true,
    frontend_workstreams: ['cursor/a', 'cursor/b'],
    composition_manifest: { files: ['src/App.tsx'] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_COMPOSITION_REQUIRED);
  assert.ok(result.details.missing_preserved_paths.includes('src/components/payments/ClaimLedgerCard.tsx'));
});

test('SPA promote with registry requires the accepted composition manifest', () => {
  const result = evaluateSpaPromote(mutatingBase({
    composition_registry: loadCompositionRegistry(ROOT),
    source_composition_manifest: { files: ['src/main.tsx'] },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_COMPOSITION_REQUIRED);
});

test('stale full Lambda packages and stale SPA builds are rejected', () => {
  assert.equal(evaluatePackageProvenance({ origin: 'full-lambda-from-branch' }).code, CODES.STALE_PACKAGE);
  assert.equal(evaluatePackageProvenance({ origin: 'fresh-live-download', kind: 'full-lambda' }).code, CODES.STALE_PACKAGE);
  assert.equal(evaluatePackageProvenance({
    origin: 'fresh-live-download',
    expected_live_code_sha256: 'live-now',
    live_code_sha256: 'old-zip',
  }).code, CODES.STALE_PACKAGE);
  assert.equal(evaluateDistFreshness({
    clean_build: true,
    built_from_stale_main: true,
  }).code, CODES.STALE_PACKAGE);
  assert.equal(evaluateDistFreshness({
    clean_build: true,
    source_commit: SHA,
    current_commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  }).code, CODES.STALE_PACKAGE);
});

test('fresh live fingerprint is required and must post-date the exclusive lease', () => {
  const missing = evaluateFreshLiveFingerprint({
    preflight: { codeSha256: 'a' },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.DEPLOYMENT_COLLISION);

  const drifted = evaluateFreshLiveFingerprint({
    preflight: { codeSha256: 'a', revisionId: '1' },
    immediately_before: { codeSha256: 'b', revisionId: '1' },
  });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, CODES.DEPLOYMENT_COLLISION);

  const beforeLease = evaluateFreshLiveFingerprint({
    preflight: { codeSha256: 'a' },
    immediately_before: { codeSha256: 'a', captured_at: '2026-09-30T15:00:00.000Z' },
    lease: { acquired_at: '2026-09-30T16:00:00.000Z' },
  });
  assert.equal(beforeLease.ok, false);
  assert.equal(beforeLease.code, CODES.DEPLOYMENT_COLLISION);
});

test('automatic rollback or lock steal is forbidden', () => {
  const rollback = evaluateNoAutomaticRollback({ auto_rollback: true, mutated: true });
  assert.equal(rollback.ok, false);
  assert.equal(rollback.code, CODES.STALE_PACKAGE);

  const steal = evaluateExclusiveDeployLock({
    workstream_id: 'cursor/a',
    lease: { workstream_id: 'cursor/b' },
    steal_lease: true,
  });
  assert.equal(steal.ok, false);
  assert.equal(steal.code, CODES.LEASE_HELD);
});

test('accepted composition and endorsement contracts are required regression gates', () => {
  const registry = loadContractRegistry(ROOT);
  const composition = loadCompositionRegistry(ROOT);
  const ids = registry.contracts.map((row) => row.id);
  assert.ok(ids.includes('endorsement'));
  assert.ok(ids.includes('signature-requests'));
  assert.ok(ids.includes('claim-ledger'));
  assert.ok(ids.includes('ocr'));
  assert.ok(composition.manifests.some((row) => row.id === 'moov-claim-ledger-signature-spa'));
  assert.ok(composition.manifests.some((row) => row.id === 'endorsement-verified-lock'));
  assert.ok(composition.manifests.some((row) => row.id === 'ocr-azure-textract'));

  const missing = evaluateRequiredRegressionChecks({
    registry,
    compositionRegistry: composition,
    environment: 'staging',
    deployment_type: 'spa-promote',
    results: passingContractResults(registry),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.REGRESSION_DETECTED);

  const pass = evaluateRequiredRegressionChecks({
    registry,
    compositionRegistry: composition,
    environment: 'staging',
    deployment_type: 'spa-promote',
    results: {
      ...passingContractResults(registry),
      ...passingCompositionResults(composition),
    },
  });
  assert.equal(pass.ok, true);
  assert.equal(evaluateAcceptedContracts({
    registry,
    environment: 'staging',
    deployment_type: 'lambda-overlay',
    results: passingContractResults(registry),
  }).ok, true);
});

test('happy-path preserve-builds allows a reconciled composed SPA evaluate', () => {
  const registry = loadContractRegistry(ROOT);
  const composition = loadCompositionRegistry(ROOT);
  const result = evaluatePreserveBuilds(mutatingBase(), {
    skip_contracts: true,
    compositionRegistry: composition,
    registry,
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.preserve_builds, true);
  assert.equal(result.details.reclaim_forbidden, true);
});

test('evaluateDeployment fails closed on mixed worktree or stale main', () => {
  const shared = evaluateDeployment(mutatingBase({
    shared_worktree: true,
    contract_results: {
      ...passingContractResults(loadContractRegistry(ROOT)),
      ...passingCompositionResults(loadCompositionRegistry(ROOT)),
    },
  }), { root: ROOT, skip_contracts: true });
  assert.equal(shared.ok, false);
  assert.equal(shared.code, CODES.WORKTREE_ISOLATION_REQUIRED);

  const stale = evaluateDeployment(mutatingBase({
    merge_base_sha: STALE_MAIN,
    reconciled_with_main: false,
  }), { root: ROOT, skip_contracts: true });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, CODES.MAIN_RECONCILIATION_REQUIRED);
});

test('scanner detects SDK UpdateFunctionCode writers and preserve-builds rule exists', () => {
  const live = scanRepository(ROOT);
  assert.equal(live.ok, true, live.errors.join('\n'));
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-preserve-scan-'));
  fs.mkdirSync(path.join(probe, 'ops/deployment-guard'), { recursive: true });
  fs.writeFileSync(path.join(probe, 'ops/deployment-guard/bypass-inventory.json'), JSON.stringify({ scripts: [] }));
  fs.writeFileSync(path.join(probe, 'rogue-sdk.mjs'), "import { UpdateFunctionCodeCommand } from '@aws-sdk/client-lambda';\n");
  const scanned = scanRepository(probe);
  assert.equal(scanned.ok, false);
  assert.ok(scanned.errors.some((row) => /rogue-sdk/.test(row)));

  const rule = fs.readFileSync(path.join(ROOT, '.cursor/rules/preserve-builds.mdc'), 'utf8');
  assert.match(rule, /alwaysApply: true/);
});

test('preserve-builds CLI fails closed and never mentions AWS writes', () => {
  const cli = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/preserve-builds.mjs'),
    '--json',
    JSON.stringify({
      workstream_id: 'cursor/a',
      branch: 'main',
      cursor_chat: true,
      deployment_type: 'spa-promote',
    }),
    '--skip-contracts',
  ], { encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /WORKTREE_ISOLATION_REQUIRED|MAIN_RECONCILIATION_REQUIRED/);
});

test('accepted composition and contract test files still exist', () => {
  const composition = loadCompositionRegistry(ROOT);
  const registry = loadContractRegistry(ROOT);
  for (const row of composition.manifests) {
    for (const file of row.preserved_paths || []) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), file);
    }
    if (row.test) assert.ok(fs.existsSync(path.join(ROOT, row.test)), row.test);
    for (const testPath of row.tests || []) {
      assert.ok(fs.existsSync(path.join(ROOT, testPath)), testPath);
    }
    if (row.evidence) assert.ok(fs.existsSync(path.join(ROOT, row.evidence)), row.evidence);
  }
  const endorsement = registry.contracts.find((row) => row.id === 'endorsement');
  assert.ok(endorsement);
  assert.ok(fs.existsSync(path.join(ROOT, endorsement.test)));
});

test('enforcement-gaps registry records remaining out-of-repo holes', () => {
  const gaps = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/enforcement-gaps.json'), 'utf8'));
  const ids = gaps.gaps.map((row) => row.id);
  for (const id of [
    'out-of-repo-aws-cli',
    'local-lease-not-distributed',
    'local-issuer-key',
    'cursor-runtime-aws-credentials',
    'iam-not-applied',
  ]) {
    assert.ok(ids.includes(id), id);
  }
});
