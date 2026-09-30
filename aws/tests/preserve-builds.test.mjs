import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
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
  CANDIDATE_EVIDENCE_PATH,
  evaluateObservationBinding,
  hashArtifactDigest,
  hashArtifactMember,
  hashBytes,
  hashFileBytes,
  hashLambdaCodeSha256,
  hashSpaLiveFiles,
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
  assert.match(cli.stderr, /WORKTREE_ISOLATION_REQUIRED|MAIN_RECONCILIATION_REQUIRED|SOURCE_COMPOSITION_REQUIRED/);
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

function gitAt(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeMemberTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (~crc) >>> 0;
}

function writeStoredZip(zipPath, files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localEntry = Buffer.concat([local, nameBuf, data]);
    chunks.push(localEntry);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += localEntry.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...chunks, cdBuf, eocd]));
}

function makeObservedGitWorktree({ artifactBody, asZip = false } = {}) {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-obs-origin-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-obs-work-'));
  const rel = 'src/components/payments/ClaimLedgerCard.tsx';
  const body = artifactBody || 'accepted-artifact-bytes\n';
  const indexHtml = '<!doctype html><script type="module" src="/assets/index-aaa.js"></script>\n';
  const bundle = 'console.log("candidate-bundle")\n';
  const liveIndex = '<!doctype html><script type="module" src="/assets/index-aaa.js"></script>\n';
  const liveBundle = 'console.log("live-bundle")\n';
  const artifact = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-obs-artifact-'));
  let artifactPath = artifact;
  if (asZip) {
    artifactPath = path.join(artifact, 'package.zip');
    writeStoredZip(artifactPath, { [rel]: body });
  } else {
    writeMemberTree(artifact, {
      [rel]: body,
      'index.html': indexHtml,
      'assets/index-aaa.js': bundle,
    });
  }
  const digest = hashArtifactDigest(artifactPath, {
    files: [rel],
    entryBundle: '/assets/index-aaa.js',
  });
  gitAt(origin, ['init', '-b', 'main']);
  gitAt(origin, ['config', 'user.email', 'ci@example.com']);
  gitAt(origin, ['config', 'user.name', 'ci']);
  fs.mkdirSync(path.join(origin, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(origin, rel), 'accepted-worktree-bytes\n');
  const registry = {
    manifests: [{
      id: 'fixture-spa',
      accepted: true,
      kind: 'spa',
      preserved_paths: [rel],
    }],
  };
  fs.mkdirSync(path.join(origin, 'ops/deployment-guard'), { recursive: true });
  fs.writeFileSync(
    path.join(origin, 'ops/deployment-guard/accepted-source-composition.json'),
    `${JSON.stringify(registry)}\n`,
  );
  fs.writeFileSync(
    path.join(origin, CANDIDATE_EVIDENCE_PATH),
    `${JSON.stringify({ artifact_sha256: digest })}\n`,
  );
  gitAt(origin, ['add', rel, 'ops/deployment-guard']);
  gitAt(origin, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
  execFileSync('git', ['clone', origin, work], { encoding: 'utf8' });
  gitAt(work, ['config', 'user.email', 'ci@example.com']);
  gitAt(work, ['config', 'user.name', 'ci']);
  const commit = gitAt(work, ['rev-parse', 'HEAD']);
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-obs-live-'));
  writeMemberTree(baseline, {
    [rel]: body,
    'index.html': liveIndex,
    'assets/index-aaa.js': liveBundle,
  });
  const spaHashes = hashSpaLiveFiles(baseline, '/assets/index-aaa.js');
  const fingerprint = {
    ...spaHashes,
    captured_at: NOW,
  };
  return {
    origin,
    work,
    rel,
    registry,
    commit,
    fingerprint,
    artifact_digest: digest,
    deployment_artifact: {
      path: artifactPath,
      commit,
      kind: asZip ? 'lambda-zip' : 'spa-dist',
    },
    live_baseline: {
      path: baseline,
      origin: 'fresh-live-download',
      kind: 'spa-dist',
      fingerprint,
    },
  };
}

test('trusted collector hashes deployment-artifact bytes and reads ancestry from git commands', () => {
  const rel = 'src/components/payments/ClaimLedgerCard.tsx';
  const bytes = fs.readFileSync(path.join(ROOT, rel));
  assert.equal(hashFileBytes(ROOT, rel), createHash('sha256').update(bytes).digest('hex'));

  const observed = observeCandidateMembers(ROOT, [rel]);
  assert.equal(observed.ok, true);
  assert.equal(observed.details.source, 'artifact-bytes');
  assert.equal(observed.details.candidate_members[rel], hashFileBytes(ROOT, rel));

  const fixture = makeObservedGitWorktree();
  const ancestry = observeGitAncestry(fixture.work);
  assert.equal(ancestry.ok, true, ancestry.message);
  assert.equal(ancestry.details.source, 'git-merge-base');
  assert.equal(ancestry.details.git_ancestry.method, 'git-merge-base');
  assert.equal(ancestry.details.git_ancestry.observed, true);
  assert.match(ancestry.details.current_main_sha, /^[0-9a-f]{40}$/);
  assert.equal(ancestry.details.merge_base_sha, ancestry.details.current_main_sha);

  const evidence = observePreserveEvidence({
    root: fixture.work,
    registry: fixture.registry,
    deployment_type: 'spa-promote',
    commit: fixture.commit,
    deployment_artifact: fixture.deployment_artifact,
    live_baseline: fixture.live_baseline,
    fingerprint: fixture.fingerprint,
  });
  assert.equal(evidence.ok, true, evidence.message);
  assert.equal(evidence.details.candidate_source, 'deployment-artifact');
  assert.equal(evidence.details.live_source, 'fresh-live-baseline');
  assert.equal(evidence.details.ancestry_source, 'git-merge-base');
  assert.equal(evidence.details.build_evidence_source, 'git-attestation');
  assert.equal(evidence.details.collector, 'scripts/deployment-guard/lib/observe.mjs');
  assert.equal(evidence.details.fingerprint_verified, true);
  assert.equal(evidence.details.fingerprint_bytes_verified, true);
  assert.equal(evidence.details.artifact_digest, fixture.artifact_digest);
  assert.equal(
    evidence.details.candidate_members[fixture.rel],
    hashArtifactMember(fixture.deployment_artifact.path, fixture.rel),
  );
  assert.notEqual(
    evidence.details.candidate_members[fixture.rel],
    hashFileBytes(fixture.work, fixture.rel),
  );
  assert.equal(
    evidence.details.live_members[fixture.rel],
    hashArtifactMember(fixture.live_baseline.path, fixture.rel),
  );
});

test('missing live baseline evidence fails closed and does not copy candidate hashes', () => {
  const fixture = makeObservedGitWorktree();
  const missing = observePreserveEvidence({
    root: fixture.work,
    registry: fixture.registry,
    deployment_type: 'spa-promote',
    commit: fixture.commit,
    deployment_artifact: fixture.deployment_artifact,
    fingerprint: fixture.fingerprint,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.SOURCE_COMPOSITION_REQUIRED);
  assert.match(missing.message, /live|baseline|fails closed/i);
  assert.equal(missing.details.live_members, undefined);

  const official = evaluatePreserveBuilds(mutatingBase({
    commit: fixture.commit,
    deployment_artifact: fixture.deployment_artifact,
    live_members: undefined,
    candidate_members: undefined,
    preflight: fixture.fingerprint,
    immediately_before: fixture.fingerprint,
  }), {
    official: true,
    root: fixture.work,
    skip_contracts: true,
    compositionRegistry: fixture.registry,
  });
  assert.equal(official.ok, false);
  assert.equal(official.code, CODES.SOURCE_COMPOSITION_REQUIRED);
});

test('artifact or declared-commit mismatch fails closed', () => {
  const fixture = makeObservedGitWorktree();
  const otherCommit = 'ffffffffffffffffffffffffffffffffffffffff';
  const mismatched = observePreserveEvidence({
    root: fixture.work,
    registry: fixture.registry,
    deployment_type: 'spa-promote',
    commit: otherCommit,
    deployment_artifact: fixture.deployment_artifact,
    live_baseline: fixture.live_baseline,
    fingerprint: fixture.fingerprint,
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, CODES.SOURCE_COMPOSITION_REQUIRED);
  assert.match(mismatched.message, /declared commit|deployment artifact/i);
  assert.equal(mismatched.details.declared_commit, otherCommit);
  assert.equal(mismatched.details.artifact_commit, fixture.commit);
  assert.notEqual(mismatched.details.artifact_commit, mismatched.details.declared_commit);

  const zipped = makeObservedGitWorktree({ artifactBody: 'zip-member-bytes\n', asZip: true });
  const zipEvidence = observePreserveEvidence({
    root: zipped.work,
    registry: zipped.registry,
    deployment_type: 'spa-promote',
    commit: zipped.commit,
    deployment_artifact: zipped.deployment_artifact,
    live_baseline: zipped.live_baseline,
    fingerprint: zipped.fingerprint,
  });
  assert.equal(zipEvidence.ok, true, zipEvidence.message);
  assert.equal(zipEvidence.details.candidate_members[zipped.rel], hashBytes('zip-member-bytes\n'));
  assert.notEqual(zipEvidence.details.candidate_members[zipped.rel], hashFileBytes(zipped.work, zipped.rel));
  assert.equal(zipEvidence.details.build_evidence_source, 'git-attestation');

  const driftedFingerprint = observePreserveEvidence({
    root: fixture.work,
    registry: fixture.registry,
    deployment_type: 'spa-promote',
    commit: fixture.commit,
    deployment_artifact: fixture.deployment_artifact,
    live_baseline: {
      ...fixture.live_baseline,
      fingerprint: { ...fixture.fingerprint, index_html_sha256: 'idx-stale' },
    },
    fingerprint: fixture.fingerprint,
  });
  assert.equal(driftedFingerprint.ok, false);
  assert.equal(driftedFingerprint.code, CODES.DEPLOYMENT_COLLISION);
  assert.ok(driftedFingerprint.details.mismatched_fingerprint_fields.includes('index_html_sha256'));
});

test('official path rejects fabricated candidate hashes and git ancestry', () => {
  const fixture = makeObservedGitWorktree();
  const fakeMembers = { [fixture.rel]: '0'.repeat(64) };
  const fabricated = mutatingBase({
    commit: fixture.commit,
    candidate_members: fakeMembers,
    live_members: fakeMembers,
    source_composition_manifest: { files: [fixture.rel], members: fakeMembers },
    current_main_sha: MAIN,
    merge_base_sha: MAIN,
    git_ancestry: gitAncestry(),
    deployment_artifact: fixture.deployment_artifact,
    live_baseline: fixture.live_baseline,
    preflight: fixture.fingerprint,
    immediately_before: fixture.fingerprint,
  });

  const binding = evaluateObservationBinding(fabricated, observePreserveEvidence({
    root: fixture.work,
    registry: fixture.registry,
    deployment_type: 'spa-promote',
    commit: fixture.commit,
    deployment_artifact: fixture.deployment_artifact,
    live_baseline: fixture.live_baseline,
    fingerprint: fixture.fingerprint,
  }));
  assert.equal(binding.ok, false);
  assert.equal(binding.code, CODES.SOURCE_COMPOSITION_REQUIRED);
  assert.ok(binding.details.fabricated_member_hashes.includes(fixture.rel));

  const result = evaluatePreserveBuilds(fabricated, {
    official: true,
    root: fixture.work,
    skip_contracts: true,
    compositionRegistry: fixture.registry,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.code === CODES.SOURCE_COMPOSITION_REQUIRED
    || result.code === CODES.MAIN_RECONCILIATION_REQUIRED,
    result.message,
  );

  const cli = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/preserve-builds.mjs'),
    '--root',
    fixture.work,
    '--json',
    JSON.stringify(fabricated),
    '--skip-contracts',
  ], { encoding: 'utf8', cwd: fixture.work });
  assert.notEqual(cli.status, 0);
  assert.match(`${cli.stderr}${cli.stdout}`, /deployment artifact|declared commit|live evidence|cannot substitute|git-merge-base observation|build evidence/);
});

test('substituted live baseline bytes fail even when fingerprint metadata matches', () => {
  const fixture = makeObservedGitWorktree();
  fs.writeFileSync(path.join(fixture.live_baseline.path, 'index.html'), 'substituted-index\n');
  const spa = observePreserveEvidence({
    root: fixture.work,
    registry: fixture.registry,
    deployment_type: 'spa-promote',
    commit: fixture.commit,
    deployment_artifact: fixture.deployment_artifact,
    live_baseline: fixture.live_baseline,
    fingerprint: fixture.fingerprint,
  });
  assert.equal(spa.ok, false);
  assert.equal(spa.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(spa.message, /index.html|bundle bytes|substituted baseline/i);
  assert.ok(spa.details.mismatched_baseline_bytes.includes('index.html'));

  const zipPath = path.join(os.tmpdir(), `checksops-live-${process.pid}.zip`);
  writeStoredZip(zipPath, { 'owned.mjs': 'live-zip\n' });
  const codeSha256 = hashLambdaCodeSha256(zipPath);
  writeStoredZip(zipPath, { 'owned.mjs': 'substituted-zip\n' });
  const lambda = observePreserveEvidence({
    root: fixture.work,
    registry: {
      manifests: [{
        id: 'fixture-lambda',
        accepted: true,
        kind: 'lambda',
        preserved_paths: [fixture.rel],
      }],
    },
    deployment_type: 'lambda-overlay',
    commit: fixture.commit,
    deployment_artifact: fixture.deployment_artifact,
    live_baseline: {
      path: zipPath,
      origin: 'fresh-live-download',
      kind: 'lambda-zip',
      fingerprint: {
        codeSha256,
        revisionId: 'rev-1',
        captured_at: NOW,
      },
    },
    fingerprint: {
      codeSha256,
      revisionId: 'rev-1',
      captured_at: NOW,
    },
  });
  assert.equal(lambda.ok, false);
  assert.equal(lambda.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(lambda.message, /CodeSha256|substituted baseline/i);
  assert.notEqual(lambda.details.observed_codeSha256, codeSha256);
});

test('falsely labeled candidate artifacts fail despite matching commit labels', () => {
  const fixture = makeObservedGitWorktree();
  fs.writeFileSync(
    path.join(fixture.deployment_artifact.path, 'assets/index-aaa.js'),
    'falsely-labeled-bundle\n',
  );
  const labeled = {
    ...fixture.deployment_artifact,
    commit: fixture.commit,
    source_commit: fixture.commit,
  };
  const result = observePreserveEvidence({
    root: fixture.work,
    registry: fixture.registry,
    deployment_type: 'spa-promote',
    commit: fixture.commit,
    deployment_artifact: labeled,
    live_baseline: fixture.live_baseline,
    fingerprint: fixture.fingerprint,
    build_evidence: {
      commit: fixture.commit,
      artifact_sha256: fixture.artifact_digest,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_COMPOSITION_REQUIRED);
  assert.match(result.message, /build evidence|commit label|falsely labeled/i);
  assert.notEqual(result.details.artifact_digest, fixture.artifact_digest);
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
