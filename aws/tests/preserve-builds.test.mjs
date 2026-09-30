import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  evaluateGitAncestry,
  evaluateMainReconciliation,
  evaluatePreservedMemberIntegrity,
  evidenceForPreservedPaths,
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
import {
  evaluateObservationBinding,
  hashFileBytes,
  observeCandidateMembers,
  observeGitAncestry,
  observePreserveEvidence,
} from '../../scripts/deployment-guard/lib/observe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MAIN = 'cccccccccccccccccccccccccccccccccccccccc';
const STALE_MAIN = 'dddddddddddddddddddddddddddddddddddddddd';
const NOW = '2026-09-30T16:00:00.000Z';

function spaFiles() {
  return requiredPreservedPaths(loadCompositionRegistry(ROOT), { deployment_type: 'spa-promote' });
}

function gitAncestry({ commit = SHA, current_main_sha = MAIN, merge_base_sha = MAIN } = {}) {
  return {
    method: 'git-merge-base',
    is_ancestor: true,
    current_main_sha,
    merge_base_sha,
    commit,
  };
}

function mutatingBase(overrides = {}) {
  const deploymentType = overrides.deployment_type || 'spa-promote';
  const evidence = evidenceForPreservedPaths(loadCompositionRegistry(ROOT), deploymentType);
  const workstreamId = overrides.workstream_id || 'cursor/preserve-a';
  const commit = overrides.commit || SHA;
  const currentMain = Object.hasOwn(overrides, 'current_main_sha') ? overrides.current_main_sha : MAIN;
  const mergeBase = Object.hasOwn(overrides, 'merge_base_sha') ? overrides.merge_base_sha : MAIN;
  const spaFingerprint = {
    index_html_sha256: 'idx-1',
    entry_bundle: '/assets/index-aaa.js',
    captured_at: NOW,
  };
  return {
    workstream_id: workstreamId,
    branch: 'cursor/preserve-a',
    commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-frontend',
    deployment_type: 'spa-promote',
    owned_components: ['index.html'],
    owned_members: ['index.html'],
    worktree: '/tmp/worktree-a',
    current_main_sha: currentMain,
    merge_base_sha: mergeBase,
    reconciled_with_main: true,
    git_ancestry: gitAncestry({
      commit,
      current_main_sha: currentMain || MAIN,
      merge_base_sha: mergeBase || MAIN,
    }),
    require_exclusive_lock: true,
    lease: {
      workstream_id: workstreamId,
      component: 'staging-frontend',
      environment: 'staging',
      commit,
      acquired_at: NOW,
      expiry: '2026-09-30T16:15:00.000Z',
    },
    build_timestamp: NOW,
    preflight: spaFingerprint,
    preflight_live_fingerprint: spaFingerprint,
    immediately_before: spaFingerprint,
    dist: { clean_build: true },
    clean_build: true,
    frontend_workstreams: ['cursor/preserve-a'],
    source_composition_manifest: { files: evidence.files, members: evidence.members },
    live_members: evidence.live_members,
    candidate_members: evidence.candidate_members,
    accepted_paths_vs_main: evidence.accepted_paths_vs_main,
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
    deployment_type: 'lambda-overlay',
    preflight: { codeSha256: 'a', revisionId: '1', captured_at: NOW },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.DEPLOYMENT_COLLISION);

  const drifted = evaluateFreshLiveFingerprint({
    deployment_type: 'lambda-overlay',
    preflight: { codeSha256: 'a', revisionId: '1', captured_at: NOW },
    immediately_before: { codeSha256: 'b', revisionId: '1', captured_at: NOW },
  });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, CODES.DEPLOYMENT_COLLISION);

  const beforeLease = evaluateFreshLiveFingerprint({
    deployment_type: 'lambda-overlay',
    preflight: { codeSha256: 'a', revisionId: '1', captured_at: '2026-09-30T15:00:00.000Z' },
    immediately_before: { codeSha256: 'a', revisionId: '1', captured_at: '2026-09-30T15:00:00.000Z' },
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
    require_exclusive_lock: true,
    lease: { workstream_id: 'cursor/b', acquired_at: NOW },
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

test('accepted composition rejects file-name-only manifests without content hashes', () => {
  const result = evaluateAcceptedSourceComposition({
    registry: loadCompositionRegistry(ROOT),
    deployment_type: 'spa-promote',
    accepted_composition: true,
    frontend_workstreams: ['cursor/a', 'cursor/b'],
    composition_manifest: { files: spaFiles() },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_COMPOSITION_REQUIRED);
  assert.ok(result.details.missing_content_hashes.includes('src/components/payments/ClaimLedgerCard.tsx'));
});

test('preserved-member integrity fails when live and candidate hashes are both missing', () => {
  const direct = evaluatePreservedMemberIntegrity({
    liveMembers: {},
    candidateMembers: {},
    ownedMembers: [],
    preservedPaths: ['src/components/payments/ClaimLedgerCard.tsx'],
  });
  assert.equal(direct.ok, false);
  assert.equal(direct.code, CODES.SOURCE_COMPOSITION_REQUIRED);
  assert.deepEqual(direct.details.missing_member_evidence, ['src/components/payments/ClaimLedgerCard.tsx']);

  const omitted = evaluatePreserveBuilds(mutatingBase({
    live_members: undefined,
    candidate_members: undefined,
  }), { skip_contracts: true, compositionRegistry: loadCompositionRegistry(ROOT) });
  assert.equal(omitted.ok, false);
  assert.equal(omitted.code, CODES.SOURCE_COMPOSITION_REQUIRED);
  assert.ok(omitted.details.missing_member_evidence.includes('src/components/payments/ClaimLedgerCard.tsx'));
});

test('exclusive lock fails when the lease or requirement flag is omitted', () => {
  const omittedFlag = evaluateExclusiveDeployLock({
    workstream_id: 'cursor/a',
    lease: { workstream_id: 'cursor/a', acquired_at: NOW },
  });
  assert.equal(omittedFlag.ok, false);
  assert.equal(omittedFlag.code, CODES.LEASE_EXPIRED);

  const disabled = evaluateExclusiveDeployLock({
    workstream_id: 'cursor/a',
    require_exclusive_lock: false,
    lease: { workstream_id: 'cursor/a', acquired_at: NOW },
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, CODES.LEASE_EXPIRED);

  const omittedLease = evaluatePreserveBuilds(mutatingBase({
    lease: undefined,
  }), { skip_contracts: true, compositionRegistry: loadCompositionRegistry(ROOT) });
  assert.equal(omittedLease.ok, false);
  assert.equal(omittedLease.code, CODES.LEASE_EXPIRED);
});

test('incomplete fingerprints and missing captured_at fail closed', () => {
  const incomplete = evaluateFreshLiveFingerprint({
    deployment_type: 'lambda-overlay',
    preflight: { captured_at: NOW },
    immediately_before: { captured_at: NOW },
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, CODES.DEPLOYMENT_COLLISION);
  assert.ok(incomplete.details.missing_fingerprint_fields.includes('codeSha256'));

  const missingCaptured = evaluateFreshLiveFingerprint({
    deployment_type: 'spa-promote',
    preflight: { index_html_sha256: 'idx-1', entry_bundle: '/assets/index-aaa.js' },
    immediately_before: { index_html_sha256: 'idx-1', entry_bundle: '/assets/index-aaa.js' },
  });
  assert.equal(missingCaptured.ok, false);
  assert.equal(missingCaptured.code, CODES.DEPLOYMENT_COLLISION);
  assert.ok(missingCaptured.details.missing_fingerprint_fields.includes('captured_at'));
});

test('reconciled_with_main=true is not a substitute for git ancestry evidence', () => {
  const shaMismatch = evaluateMainReconciliation({
    current_main_sha: MAIN,
    merge_base_sha: STALE_MAIN,
    reconciled_with_main: true,
    git_ancestry: gitAncestry({ current_main_sha: MAIN, merge_base_sha: STALE_MAIN }),
  });
  assert.equal(shaMismatch.ok, false);
  assert.equal(shaMismatch.code, CODES.MAIN_RECONCILIATION_REQUIRED);

  const missingAncestry = evaluateGitAncestry({
    current_main_sha: MAIN,
    merge_base_sha: MAIN,
    commit: SHA,
    reconciled_with_main: true,
  });
  assert.equal(missingAncestry.ok, false);
  assert.equal(missingAncestry.code, CODES.MAIN_RECONCILIATION_REQUIRED);

  const omitted = evaluatePreserveBuilds(mutatingBase({
    reconciled_with_main: true,
    git_ancestry: undefined,
  }), { skip_contracts: true, compositionRegistry: loadCompositionRegistry(ROOT) });
  assert.equal(omitted.ok, false);
  assert.equal(omitted.code, CODES.MAIN_RECONCILIATION_REQUIRED);
});

test('trusted collector hashes artifact bytes and reads ancestry from git commands', () => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-observe-'));
  const rel = 'src/components/payments/ClaimLedgerCard.tsx';
  const bytes = fs.readFileSync(path.join(ROOT, rel));
  assert.equal(hashFileBytes(ROOT, rel), createHash('sha256').update(bytes).digest('hex'));

  const observed = observeCandidateMembers(ROOT, [rel]);
  assert.equal(observed.ok, true);
  assert.equal(observed.details.source, 'artifact-bytes');
  assert.equal(observed.details.candidate_members[rel], hashFileBytes(ROOT, rel));

  const ancestry = observeGitAncestry(ROOT);
  assert.equal(ancestry.ok, true, ancestry.message);
  assert.equal(ancestry.details.source, 'git-merge-base');
  assert.equal(ancestry.details.git_ancestry.method, 'git-merge-base');
  assert.equal(ancestry.details.git_ancestry.observed, true);
  assert.match(ancestry.details.current_main_sha, /^[0-9a-f]{40}$/);
  assert.equal(ancestry.details.merge_base_sha, ancestry.details.current_main_sha);

  const evidence = observePreserveEvidence({
    root: ROOT,
    registry: loadCompositionRegistry(ROOT),
    deployment_type: 'spa-promote',
  });
  assert.equal(evidence.ok, true, evidence.message);
  assert.equal(evidence.details.candidate_source, 'artifact-bytes');
  assert.equal(evidence.details.ancestry_source, 'git-merge-base');
  assert.equal(evidence.details.collector, 'scripts/deployment-guard/lib/observe.mjs');
  fs.rmSync(probe, { recursive: true, force: true });
});

test('official path rejects fabricated candidate hashes and git ancestry', () => {
  const composition = loadCompositionRegistry(ROOT);
  const files = spaFiles();
  const fakeMembers = Object.fromEntries(files.map((file) => [file, '0'.repeat(64)]));
  const fabricated = mutatingBase({
    candidate_members: fakeMembers,
    live_members: fakeMembers,
    source_composition_manifest: { files, members: fakeMembers },
    current_main_sha: MAIN,
    merge_base_sha: MAIN,
    git_ancestry: gitAncestry(),
  });

  const binding = evaluateObservationBinding(fabricated, observePreserveEvidence({
    root: ROOT,
    registry: composition,
    deployment_type: 'spa-promote',
  }));
  assert.equal(binding.ok, false);
  assert.equal(binding.code, CODES.SOURCE_COMPOSITION_REQUIRED);
  assert.ok(binding.details.fabricated_member_hashes.includes('src/components/payments/ClaimLedgerCard.tsx'));

  const result = evaluatePreserveBuilds(fabricated, {
    official: true,
    root: ROOT,
    skip_contracts: true,
    compositionRegistry: composition,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.code === CODES.SOURCE_COMPOSITION_REQUIRED
    || result.code === CODES.MAIN_RECONCILIATION_REQUIRED,
    result.message,
  );

  const cli = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/preserve-builds.mjs'),
    '--json',
    JSON.stringify(fabricated),
    '--skip-contracts',
  ], { encoding: 'utf8', cwd: ROOT });
  assert.notEqual(cli.status, 0);
  assert.match(`${cli.stderr}${cli.stdout}`, /artifact bytes|git-merge-base observation|cannot substitute/);
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
