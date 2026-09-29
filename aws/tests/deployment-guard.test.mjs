import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES, createDisabledAws, loadGuardConfig, memberHash } from '../../scripts/deployment-guard/lib.mjs';
import { createManifest, validateManifest } from '../../scripts/deployment-guard/manifest.mjs';
import { acquireLease, inspectLease, reapExpired, releaseLease } from '../../scripts/deployment-guard/lease.mjs';
import {
  assertLambdaCas,
  commitLambdaOverlay,
  detectSameFileConflict,
  planLambdaOverlay,
  verifyNonOwnedIntact,
} from '../../scripts/deployment-guard/lambda-overlay.mjs';
import { planSpaPromote } from '../../scripts/deployment-guard/spa-promote.mjs';
import { planSqlApply, sqlDefinitionHash } from '../../scripts/deployment-guard/sql-apply.mjs';
import { evaluateContracts, passingResultsFor } from '../../scripts/deployment-guard/contracts.mjs';
import { assertProductionApproval } from '../../scripts/deployment-guard/production.mjs';
import { runPreflight } from '../../scripts/deployment-guard/preflight.mjs';
import { assertGuardCleared } from '../../scripts/deployment-guard/require-guard.mjs';
import { classifyAgainstInventory, scanBypassCandidates } from '../../scripts/deployment-guard/inventory.mjs';
import { verifyLive } from '../../scripts/deployment-guard/verify-live.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMIT = 'a'.repeat(40);
const WRITE_TRACKER = createDisabledAws();

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-guard-lease-'));
}

function baseIdentity(extra = {}) {
  return {
    workstream_id: extra.workstream_id || 'cursor/guard-a',
    branch: extra.branch || 'cursor/guard-a',
    commit: extra.commit || COMMIT,
    operator: extra.operator || 'agent-test',
    target_environment: extra.target_environment || 'staging',
    deployment_type: extra.deployment_type || 'lambda-overlay',
    owned_components: extra.owned_components || ['staging-api'],
    owned_lambda_members: extra.owned_lambda_members || ['owned.mjs'],
    preflight_live_fingerprint: extra.preflight_live_fingerprint || {
      codeSha256: 'live-sha',
      revisionId: 'rev-1',
      lastModified: '2026-09-29T00:00:00.000Z',
      index_html_sha256: extra.index_html_sha256,
    },
    build_timestamp: extra.build_timestamp || '2026-09-29T00:00:00.000Z',
    provenance: extra.provenance || { source: 'live_download', codeSha256: 'live-sha' },
    frontend_workstreams: extra.frontend_workstreams,
    production_approval: extra.production_approval,
    staging_acceptance: extra.staging_acceptance,
  };
}

function liveMembers() {
  return {
    'owned.mjs': 'owned-v1',
    'other.mjs': 'other-keep',
    'financial.mjs': 'financial-keep',
  };
}

test('anonymous deployment is rejected', () => {
  const result = validateManifest({});
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.ANONYMOUS_DEPLOYMENT);
});

test('A. Lambda non-owned member changed -> STOP', () => {
  const result = planLambdaOverlay({
    liveMembers: liveMembers(),
    overlayMembers: { 'owned.mjs': 'owned-v2' },
    ownedMembers: ['owned.mjs'],
    provenance: { source: 'live_download', codeSha256: 'live-sha' },
    liveFingerprint: { codeSha256: 'live-sha', revisionId: 'rev-1' },
  });
  assert.equal(result.ok, true);

  const mutated = planLambdaOverlay({
    liveMembers: liveMembers(),
    overlayMembers: { 'owned.mjs': 'owned-v2', 'other.mjs': 'tampered' },
    ownedMembers: ['owned.mjs'],
    provenance: { source: 'live_download', codeSha256: 'live-sha' },
    liveFingerprint: { codeSha256: 'live-sha', revisionId: 'rev-1' },
  });
  assert.equal(mutated.ok, false);
  assert.equal(mutated.code, CODES.UNDECLARED_MEMBER);
});

test('A2. unexpected non-owned membership drift -> DEPLOYMENT_COLLISION', () => {
  const planned = {
    ...liveMembers(),
    'owned.mjs': 'owned-v2',
    'other.mjs': 'changed-by-accident',
  };
  const result = planLambdaOverlay({
    liveMembers: liveMembers(),
    overlayMembers: { 'owned.mjs': 'owned-v2' },
    ownedMembers: ['owned.mjs'],
    provenance: { source: 'live_download', codeSha256: 'live-sha' },
    liveFingerprint: { codeSha256: 'live-sha', revisionId: 'rev-1' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.planned['other.mjs'], memberHash('other-keep'));
  assert.notEqual(memberHash(planned['other.mjs']), result.planned['other.mjs']);
});

test('B. RevisionId changed -> STOP', () => {
  const result = assertLambdaCas({
    preflight: { CodeSha256: 'same', RevisionId: 'rev-1' },
    immediate: { CodeSha256: 'same', RevisionId: 'rev-2' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
});

test('C. CodeSha changed -> STOP', () => {
  const result = planLambdaOverlay({
    liveMembers: liveMembers(),
    overlayMembers: { 'owned.mjs': 'owned-v2' },
    ownedMembers: ['owned.mjs'],
    provenance: { source: 'live_download', codeSha256: 'old-sha' },
    liveFingerprint: { codeSha256: 'new-sha', revisionId: 'rev-1' },
    immediateFingerprint: { codeSha256: 'new-sha', revisionId: 'rev-1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.STALE_PACKAGE_REJECTED);
});

test('C2. immediate CodeSha drift -> DEPLOYMENT_COLLISION', () => {
  const result = planLambdaOverlay({
    liveMembers: liveMembers(),
    overlayMembers: { 'owned.mjs': 'owned-v2' },
    ownedMembers: ['owned.mjs'],
    provenance: { source: 'live_download', codeSha256: 'live-sha' },
    liveFingerprint: { codeSha256: 'live-sha', revisionId: 'rev-1' },
    immediateFingerprint: { codeSha256: 'other-sha', revisionId: 'rev-1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
});

test('D. same owned file concurrently changed -> reconciliation required', () => {
  const result = detectSameFileConflict({
    member: 'owned.mjs',
    liveHash: memberHash('live'),
    workstreamAHash: memberHash('workstream-a'),
    currentSourceHash: memberHash('workstream-b'),
    workstreamAId: 'cursor/a',
    workstreamBId: 'cursor/b',
    liveCommit: '1'.repeat(40),
    workstreamACommit: '2'.repeat(40),
    workstreamBCommit: '3'.repeat(40),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_RECONCILIATION_REQUIRED);
  assert.equal(result.member, 'owned.mjs');
  assert.ok(result.workstream_a.hash);
  assert.ok(result.current_source.hash);
});

test('D2. owned file changed on live after preflight -> reconciliation required', () => {
  const result = planLambdaOverlay({
    liveMembers: { 'owned.mjs': 'live-now', 'other.mjs': 'keep' },
    overlayMembers: { 'owned.mjs': 'my-version' },
    ownedMembers: ['owned.mjs'],
    expectedOwnedBaseline: { 'owned.mjs': memberHash('live-then') },
    provenance: { source: 'live_download', codeSha256: 'live-sha' },
    liveFingerprint: { codeSha256: 'live-sha', revisionId: 'rev-1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_RECONCILIATION_REQUIRED);
});

test('E. old ZIP rejected', () => {
  const result = planLambdaOverlay({
    liveMembers: liveMembers(),
    overlayMembers: { 'owned.mjs': 'owned-v2' },
    ownedMembers: ['owned.mjs'],
    provenance: { source: 'saved_live_zip' },
    liveFingerprint: { codeSha256: 'live-sha', revisionId: 'rev-1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.STALE_PACKAGE_REJECTED);
});

test('F. stale dist rejected', () => {
  const result = planSpaPromote({
    dist: { source: 'stale_dist', stale_dist: true, index_html_sha256: 'a'.repeat(64), entry_bundle: '/assets/x.js' },
    preflight: { index_html_sha256: 'a'.repeat(64) },
    live: { index_html_sha256: 'a'.repeat(64) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.STALE_PACKAGE_REJECTED);
});

test('G. index.html changed -> STOP', () => {
  const result = planSpaPromote({
    dist: {
      fresh_clean_build: true,
      source: 'fresh_clean_build',
      index_html_sha256: 'b'.repeat(64),
      entry_bundle: '/assets/new.js',
    },
    preflight: { index_html_sha256: 'a'.repeat(64) },
    live: { index_html_sha256: 'c'.repeat(64) },
    frontendWorkstreams: ['cursor/only'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
});

test('H. unrelated Lambda members preserved', () => {
  const planned = planLambdaOverlay({
    liveMembers: liveMembers(),
    overlayMembers: { 'owned.mjs': 'owned-v2' },
    ownedMembers: ['owned.mjs'],
    provenance: { source: 'live_download', codeSha256: 'live-sha' },
    liveFingerprint: { codeSha256: 'live-sha', revisionId: 'rev-1' },
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.planned['other.mjs'], memberHash('other-keep'));
  assert.equal(planned.planned['financial.mjs'], memberHash('financial-keep'));
  assert.deepEqual(planned.changed, ['owned.mjs']);
  const verify = verifyNonOwnedIntact({
    liveMembersBefore: liveMembers(),
    liveMembersAfter: { ...liveMembers(), 'owned.mjs': 'owned-v2' },
    ownedMembers: ['owned.mjs'],
  });
  assert.equal(verify.ok, true);
  assert.ok(verify.preserved.includes('other.mjs'));
});

test('I. SPA multi-workstream source composition required', () => {
  const result = planSpaPromote({
    dist: {
      fresh_clean_build: true,
      source: 'fresh_clean_build',
      index_html_sha256: 'a'.repeat(64),
      entry_bundle: '/assets/x.js',
    },
    preflight: { index_html_sha256: 'a'.repeat(64) },
    live: { index_html_sha256: 'a'.repeat(64) },
    frontendWorkstreams: ['cursor/a', 'cursor/b'],
    compositionAccepted: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_COMPOSITION_REQUIRED);
});

test('J. SQL function drift -> STOP', () => {
  const expected = sqlDefinitionHash('CREATE FUNCTION foo() RETURNS void AS $$ SELECT 1 $$');
  const result = planSqlApply({
    record: {
      filename: 'aws/rls/sql/99_example.sql',
      migration_id: '99_example',
      source_sha256: 'b'.repeat(64),
      target_environment: 'staging',
      replacing_existing: true,
      expected_live_definition_sha256: expected,
      current_live_definition: 'CREATE FUNCTION foo() RETURNS void AS $$ SELECT 2 $$',
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
});

test('K. expired lease handled safely', () => {
  const store = tmpStore();
  const past = new Date('2026-09-29T00:00:00.000Z');
  const acquired = acquireLease(store, {
    workstream_id: 'cursor/old',
    component: 'checksops-staging-api',
    environment: 'staging',
    commit: COMMIT,
  }, { clock: () => past, ttlMs: 1000, nowMs: past.getTime() });
  assert.equal(acquired.ok, true);
  const later = past.getTime() + 60_000;
  const status = inspectLease(store, {
    environment: 'staging',
    component: 'checksops-staging-api',
  }, { nowMs: later });
  assert.equal(status.held, false);
  assert.equal(status.expired, true);
  const reaped = reapExpired(store, { nowMs: later });
  assert.equal(reaped.length, 1);
  const next = acquireLease(store, {
    workstream_id: 'cursor/new',
    component: 'checksops-staging-api',
    environment: 'staging',
    commit: 'b'.repeat(40),
  }, { clock: () => new Date(later), nowMs: later });
  assert.equal(next.ok, true);
  assert.equal(next.lease.workstream_id, 'cursor/new');
});

test('L. active lease blocks competing deployment', () => {
  const store = tmpStore();
  const now = new Date('2026-09-29T01:00:00.000Z');
  const first = acquireLease(store, {
    workstream_id: 'cursor/a',
    component: 'checksops-staging-api',
    environment: 'staging',
    commit: COMMIT,
  }, { clock: () => now, nowMs: now.getTime() });
  assert.equal(first.ok, true);
  const second = acquireLease(store, {
    workstream_id: 'cursor/b',
    component: 'checksops-staging-api',
    environment: 'staging',
    commit: 'c'.repeat(40),
  }, { clock: () => now, nowMs: now.getTime() });
  assert.equal(second.ok, false);
  assert.equal(second.code, CODES.LEASE_HELD);
  const released = releaseLease(store, {
    workstream_id: 'cursor/b',
    component: 'checksops-staging-api',
    environment: 'staging',
  }, { nowMs: now.getTime() });
  assert.equal(released.ok, false);
});

test('M. production requires explicit approval', () => {
  const denied = assertProductionApproval({
    environment: 'production',
    manifest: { workstream_id: 'cursor/a' },
    stagingAcceptance: { successful: true },
    preflightFingerprint: { codeSha256: 'x', revisionId: '1' },
    liveFingerprint: { codeSha256: 'x', revisionId: '1' },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const inferred = assertProductionApproval({
    environment: 'production',
    approval: { explicit: true, marker: 'ok', inferred_from_workstream: 'cursor/old' },
    stagingAcceptance: { successful: true },
    preflightFingerprint: { codeSha256: 'x', revisionId: '1' },
    liveFingerprint: { codeSha256: 'x', revisionId: '1' },
  });
  assert.equal(inferred.ok, false);
  assert.equal(inferred.code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const okResult = assertProductionApproval({
    environment: 'production',
    manifest: { workstream_id: 'cursor/a' },
    approval: { explicit: true, marker: 'operator-approved', workstream_id: 'cursor/a' },
    stagingAcceptance: { successful: true },
    preflightFingerprint: { codeSha256: 'x', revisionId: '1' },
    liveFingerprint: { codeSha256: 'x', revisionId: '1' },
  });
  assert.equal(okResult.ok, true);
});

test('N. accepted-contract regression blocks deployment', () => {
  const registry = {
    fail_closed: true,
    contracts: [
      { id: 'ocr', title: 'OCR', accepted: true, test: 'aws/tests/ocr-azure-client.test.mjs' },
      { id: 'moov', title: 'Moov', accepted: true, test: 'aws/tests/api-moov-m62d-static-deploy-gate.test.mjs' },
    ],
  };
  const missing = evaluateContracts({
    registry,
    results: { ocr: { pass: true } },
    root: ROOT,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.REGRESSION_DETECTED);

  const disappeared = evaluateContracts({
    registry,
    results: { ocr: { pass: true }, moov: { pass: true } },
    previouslyAccepted: ['ocr', 'claim-ledger'],
    root: ROOT,
  });
  assert.equal(disappeared.ok, false);
  assert.equal(disappeared.code, CODES.REGRESSION_DETECTED);
});

test('O. no guard operation itself modifies live AWS during tests', () => {
  const aws = createDisabledAws();
  const store = tmpStore();
  const identity = baseIdentity();
  const result = runPreflight({
    identity,
    component: 'checksops-staging-api',
    acquireLease: true,
    lambda: {
      liveMembers: liveMembers(),
      overlayMembers: { 'owned.mjs': 'owned-v2' },
      provenance: identity.provenance,
    },
    intent: { action: 'overlay' },
  }, {
    root: ROOT,
    storeDir: store,
    aws,
    git: { branch: 'cursor/guard-a', commit: COMMIT },
    contractResults: passingResultsFor(loadGuardConfig(ROOT).contracts),
    dryRun: true,
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(aws.writes(), []);
  assert.deepEqual(result.aws_writes, []);

  const write = commitLambdaOverlay(result.lambda, aws);
  assert.equal(write.ok, false);
  assert.equal(write.code, CODES.AWS_WRITE_FORBIDDEN);
  assert.equal(aws.writes().length, 1);

  const verify = verifyLive({
    lambda: {
      liveMembersBefore: liveMembers(),
      liveMembersAfter: { ...liveMembers(), 'owned.mjs': 'owned-v2' },
      ownedMembers: ['owned.mjs'],
    },
    aws,
    forbidWrites: true,
  });
  assert.equal(verify.ok, false);
  assert.equal(verify.code, CODES.AWS_WRITE_FORBIDDEN);
});

test('reclaim / restore is forbidden', () => {
  const result = planLambdaOverlay({
    liveMembers: liveMembers(),
    overlayMembers: { 'owned.mjs': 'old' },
    ownedMembers: ['owned.mjs'],
    provenance: { source: 'live_download', codeSha256: 'live-sha' },
    liveFingerprint: { codeSha256: 'live-sha', revisionId: 'rev-1' },
    intent: { action: 'reclaim_staging' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
});

test('configs load fail-closed and contracts exist', () => {
  const config = loadGuardConfig(ROOT);
  assert.equal(config.targets.fail_closed, true);
  assert.equal(config.contracts.fail_closed, true);
  const ids = config.contracts.contracts.map((row) => row.id);
  for (const id of [
    'review-claim-save',
    'claim-ledger',
    'signature-requests',
    'check-files',
    'check-command-center-responsive-layout',
    'ocr',
    'moov',
    'checkalt',
    'tenant-isolation',
    'financial-write-protections',
  ]) {
    assert.ok(ids.includes(id), id);
  }
  const passing = evaluateContracts({
    registry: config.contracts,
    results: passingResultsFor(config.contracts),
    root: ROOT,
  });
  assert.equal(passing.ok, true, passing.message);
});

test('bypass inventory covers every scanned deploy-capable script', () => {
  const config = loadGuardConfig(ROOT);
  const hits = scanBypassCandidates(ROOT);
  const classified = classifyAgainstInventory(hits, config.inventory);
  assert.deepEqual(classified.missing, []);
  assert.deepEqual(classified.unknownClass, []);
  assert.ok(classified.inventoried.some((row) => row.classification === 'LEGACY/BYPASS'));
  assert.ok(classified.inventoried.some((row) => row.classification === 'SAFE'));
  assert.ok(classified.inventoried.some((row) => row.classification === 'NEEDS_GUARD'));
});

test('legacy scripts must fail without a guard receipt', () => {
  const denied = assertGuardCleared({ operation: 'update-function-code' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, CODES.GUARD_NOT_CLEARED);
});

test('production preflight refuses inferred approval and fingerprint drift', () => {
  const store = tmpStore();
  const result = runPreflight({
    identity: baseIdentity({
      target_environment: 'production',
      deployment_type: 'lambda-overlay',
      owned_components: ['production-prep-api'],
      production_approval: { explicit: true, marker: 'ok', inferred_from_workstream: 'cursor/old' },
      staging_acceptance: { successful: true },
    }),
    component: 'checksops-production-prep-api',
    lambda: {
      liveMembers: liveMembers(),
      overlayMembers: { 'owned.mjs': 'owned-v2' },
      provenance: { source: 'live_download', codeSha256: 'live-sha' },
      immediateFingerprint: { codeSha256: 'live-sha', revisionId: 'rev-1' },
    },
  }, {
    root: ROOT,
    storeDir: store,
    aws: WRITE_TRACKER,
    git: { branch: 'cursor/prod', commit: COMMIT },
    contractResults: passingResultsFor(loadGuardConfig(ROOT).contracts),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.deepEqual(WRITE_TRACKER.writes(), []);
});

test('CLI dry-run and helpers do not call AWS', () => {
  const scripts = [
    ['scripts/deployment-guard/preflight.mjs', '--dry-run'],
    ['scripts/deployment-guard/lambda-overlay.mjs'],
    ['scripts/deployment-guard/spa-promote.mjs'],
    ['scripts/deployment-guard/sql-apply.mjs'],
    ['scripts/deployment-guard/verify-live.mjs'],
  ];
  for (const [rel, ...args] of scripts) {
    const ran = spawnSync(process.execPath, [path.join(ROOT, rel), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '', CHECKSOPS_DEPLOYMENT_GUARD_AWS: '' },
    });
    assert.equal(ran.status, 0, `${rel} ${ran.stderr}`);
    assert.match(ran.stdout, /ok/);
  }
});

test('createManifest fills operator and rejects short workstream ids', () => {
  const created = createManifest(baseIdentity({ workstream_id: 'ab' }), {
    git: { branch: 'x', commit: COMMIT },
    env: { USER: 'tester' },
  });
  assert.equal(created.ok, false);
  const good = createManifest(baseIdentity(), {
    git: { branch: 'cursor/guard-a', commit: COMMIT },
    env: { USER: 'tester' },
  });
  assert.equal(good.ok, true);
  assert.equal(good.manifest.operator, 'agent-test');
  assert.equal(good.manifest.manifest_sha256.length, 64);
});

test('guard source does not embed live AWS write commands', () => {
  const dir = path.join(ROOT, 'scripts/deployment-guard');
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.doesNotMatch(text, /update-function-code/);
    assert.doesNotMatch(text, /create-invalidation/);
    assert.doesNotMatch(text, /sam deploy/);
  }
});
