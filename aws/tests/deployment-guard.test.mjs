import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AWS_WRITE_METHODS,
  assertNoLiveAwsCalls,
  createForbiddenAwsAdapter,
  createRecordingAwsAdapter,
} from '../../scripts/deployment-guard/lib/aws-adapter.mjs';
import { buildManifest, validateWorkstreamIdentity } from '../../scripts/deployment-guard/lib/identity.mjs';
import { evaluateDistFreshness, evaluatePackageProvenance } from '../../scripts/deployment-guard/lib/packages.mjs';
import {
  evaluateFingerprintCas,
  evaluateLambdaOverlay,
  evaluateMembership,
  evaluatePostOverlay,
  evaluateSameFileConflict,
  planLambdaApply,
} from '../../scripts/deployment-guard/lib/lambda-overlay.mjs';
import { evaluateSourceComposition, evaluateSpaPromote } from '../../scripts/deployment-guard/lib/spa-promote.mjs';
import { evaluateSqlApply, hashSqlDefinition } from '../../scripts/deployment-guard/lib/sql-apply.mjs';
import { acquireLease, inspectLease, releaseLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import {
  evaluateAcceptedContracts,
  loadContractRegistry,
  passingContractResults,
} from '../../scripts/deployment-guard/lib/contracts.mjs';
import { evaluateProductionGate } from '../../scripts/deployment-guard/lib/production.mjs';
import { evaluateDeployment } from '../../scripts/deployment-guard/lib/guard.mjs';
import { requireDeploymentGuard } from '../../scripts/deployment-guard/require-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = '2026-09-29T16:00:00.000Z';

function identity(overrides = {}) {
  return {
    workstream_id: 'workstream-a',
    branch: 'cursor/guard-a',
    commit: SHA,
    operator: 'test-agent',
    target_environment: 'staging',
    deployment_type: 'lambda-overlay',
    owned_members: ['owned.mjs'],
    owned_components: ['owned.mjs'],
    preflight: { codeSha256: 'live-code', revisionId: 'rev-1', lastModified: NOW },
    preflight_live_fingerprint: { codeSha256: 'live-code', revisionId: 'rev-1', lastModified: NOW },
    build_timestamp: NOW,
    package: { origin: 'fresh-live-download', downloaded_at: NOW, preflight_at: NOW },
    live_members: { 'owned.mjs': 'old', 'shared.mjs': 'keep', 'vendor/lib.js': 'vendor' },
    candidate_members: { 'owned.mjs': 'new', 'shared.mjs': 'keep', 'vendor/lib.js': 'vendor' },
    immediately_before: { codeSha256: 'live-code', revisionId: 'rev-1' },
    ...overrides,
  };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-guard-'));
}

test('anonymous deployment is rejected', () => {
  const result = validateWorkstreamIdentity({});
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.ANONYMOUS_DEPLOYMENT);
});

test('A. Lambda non-owned member changed -> STOP', () => {
  const result = evaluateMembership({
    liveMembers: { a: '1', b: '2' },
    candidateMembers: { a: '1', b: 'CHANGED' },
    ownedMembers: ['a'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.deepEqual(result.details.unexpected_changed, ['b']);
});

test('B. RevisionId changed -> STOP', () => {
  const result = evaluateFingerprintCas({
    preflight: { codeSha256: 'x', revisionId: '1' },
    immediatelyBefore: { codeSha256: 'x', revisionId: '2' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(result.message, /RevisionId/);
});

test('C. CodeSha changed -> STOP', () => {
  const result = evaluateFingerprintCas({
    preflight: { codeSha256: 'aaa', revisionId: '1' },
    immediatelyBefore: { codeSha256: 'bbb', revisionId: '1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(result.message, /CodeSha256/);
});

test('D. same owned file concurrently changed -> reconciliation required', () => {
  const result = evaluateSameFileConflict({
    liveMembers: { 'owned.mjs': 'live' },
    candidateMembers: { 'owned.mjs': 'a-new' },
    ownedMembers: ['owned.mjs'],
    peerSources: [{
      workstream_id: 'workstream-b',
      commit: SHA_B,
      current_workstream_id: 'workstream-a',
      current_commit: SHA,
      members: { 'owned.mjs': 'b-new' },
    }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_RECONCILIATION_REQUIRED);
  assert.equal(result.details.file, 'owned.mjs');
  assert.equal(result.details.live_version, 'live');
  assert.equal(result.details.current_source_version, 'a-new');
  assert.equal(result.details.peer_version, 'b-new');
});

test('E. old ZIP rejected', () => {
  for (const origin of ['saved-live-zip', 'tmp-deployment-package', 'reused-old-zip', 'branch-local-full-lambda', 'reclaim-baseline']) {
    const result = evaluatePackageProvenance({ origin });
    assert.equal(result.ok, false, origin);
    assert.equal(result.code, CODES.STALE_PACKAGE, origin);
  }
});

test('F. stale dist rejected', () => {
  const result = evaluateDistFreshness({ origin: 'stale-dist', clean_build: false, restore_previous_index: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.STALE_PACKAGE);
});

test('G. index.html changed -> STOP', () => {
  const result = evaluateSpaPromote(identity({
    deployment_type: 'spa-promote',
    owned_components: ['index.html'],
    clean_build: true,
    dist: { clean_build: true },
    source_composition_manifest: { files: ['src/main.tsx'] },
    frontend_workstreams: ['workstream-a'],
    preflight: { index_html_sha256: 'idx-1', entry_bundle: '/assets/index-aaa.js' },
    immediately_before: { index_html_sha256: 'idx-2', entry_bundle: '/assets/index-aaa.js' },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(result.message, /index.html/);
});

test('H. unrelated Lambda members preserved', () => {
  const overlay = evaluateLambdaOverlay(identity());
  assert.equal(overlay.ok, true);
  const post = evaluatePostOverlay({
    liveMembersBefore: identity().live_members,
    liveMembersAfter: { 'owned.mjs': 'new', 'shared.mjs': 'keep', 'vendor/lib.js': 'vendor' },
    ownedMembers: ['owned.mjs'],
  });
  assert.equal(post.ok, true);
  assert.deepEqual(post.details.preserved, ['shared.mjs', 'vendor/lib.js']);
});

test('I. SPA multi-workstream source composition required', () => {
  const result = evaluateSourceComposition({
    frontend_workstreams: ['workstream-a', 'workstream-b'],
    accepted_composition: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_COMPOSITION_REQUIRED);
});

test('J. SQL function drift -> STOP', () => {
  const expected = hashSqlDefinition('CREATE FUNCTION foo() RETURNS void AS $$ SELECT 1 $$');
  const live = hashSqlDefinition('CREATE FUNCTION foo() RETURNS void AS $$ SELECT 2 $$');
  const result = evaluateSqlApply(identity({
    deployment_type: 'sql-apply',
    owned_components: ['aws/rls/sql/example.sql'],
    filename: 'aws/rls/sql/example.sql',
    migration_id: 'example',
    source_sha256: 'c'.repeat(64),
    expected_live_definition_sha256: expected,
    live_definition_sha256: live,
    preflight_live_fingerprint: { sql: expected },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
});

test('K. expired lease handled safely', () => {
  const root = tmpRoot();
  const start = Date.parse(NOW);
  const first = acquireLease(root, {
    workstream_id: 'workstream-a',
    component: 'checksops-staging-api',
    environment: 'staging',
    commit: SHA,
    ttl_ms: 1000,
  }, start);
  assert.equal(first.ok, true);
  const expired = inspectLease(root, 'staging', 'checksops-staging-api', start + 5000);
  assert.equal(expired.ok, true);
  assert.equal(expired.details.expired, true);
  const second = acquireLease(root, {
    workstream_id: 'workstream-b',
    component: 'checksops-staging-api',
    environment: 'staging',
    commit: SHA_B,
    ttl_ms: 1000,
  }, start + 5000);
  assert.equal(second.ok, true);
  assert.equal(second.details.lease.replaced_expired, true);
  assert.equal(second.details.lease.workstream_id, 'workstream-b');
});

test('L. active lease blocks competing deployment', () => {
  const root = tmpRoot();
  const start = Date.parse(NOW);
  assert.equal(acquireLease(root, {
    workstream_id: 'workstream-a',
    component: 'checksops-staging-api',
    environment: 'staging',
    commit: SHA,
  }, start).ok, true);
  const blocked = acquireLease(root, {
    workstream_id: 'workstream-b',
    component: 'checksops-staging-api',
    environment: 'staging',
    commit: SHA_B,
  }, start + 1000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, CODES.LEASE_HELD);
  const released = releaseLease(root, {
    workstream_id: 'workstream-b',
    component: 'checksops-staging-api',
    environment: 'staging',
  }, start + 1000);
  assert.equal(released.ok, false);
  assert.equal(released.code, CODES.LEASE_HELD);
});

test('M. production requires explicit approval', () => {
  const missing = evaluateProductionGate({
    target_environment: 'production',
    workstream_id: 'workstream-a',
    deployment_type: 'lambda-overlay',
    production_fingerprint: { revisionId: '1' },
    immediately_before_fingerprint: { revisionId: '1' },
    staging_acceptance: { ok: true, reference: 'staging#123' },
    approval: { approved: true, workstream_id: 'workstream-previous', inherited: true },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const okProd = evaluateProductionGate({
    target_environment: 'production',
    workstream_id: 'workstream-a',
    deployment_type: 'lambda-overlay',
    production_fingerprint: { revisionId: '1' },
    immediately_before_fingerprint: { revisionId: '1' },
    staging_acceptance: { ok: true, reference: 'staging#123' },
    approval: { approved: true, workstream_id: 'workstream-a' },
  });
  assert.equal(okProd.ok, true);
});

test('N. accepted-contract regression blocks deployment', () => {
  const registry = loadContractRegistry(ROOT);
  const disappeared = evaluateAcceptedContracts({
    registry: { contracts: [] },
    previously_accepted: ['tenant-isolation'],
    results: {},
  });
  assert.equal(disappeared.ok, false);
  assert.equal(disappeared.code, CODES.REGRESSION_DETECTED);

  const failed = evaluateAcceptedContracts({
    registry,
    environment: 'staging',
    results: { ...passingContractResults(registry), 'tenant-isolation': { ok: false } },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, CODES.REGRESSION_DETECTED);

  const pass = evaluateAcceptedContracts({
    registry,
    environment: 'staging',
    results: passingContractResults(registry),
  });
  assert.equal(pass.ok, true);
});

test('O. no guard operation itself modifies live AWS during tests', () => {
  const forbidden = createForbiddenAwsAdapter();
  const recording = createRecordingAwsAdapter({
    updateFunctionCode: () => {
      throw new Error('should not be called');
    },
  });
  const result = evaluateDeployment(identity({
    contract_results: passingContractResults(loadContractRegistry(ROOT)),
  }), { root: ROOT, aws: forbidden, skip_contracts: true });
  assert.equal(result.ok, true);
  assert.equal(result.details.aws_adapter, 'forbidden');
  assert.equal(forbidden.calls.length, 0);
  assertNoLiveAwsCalls(forbidden);
  assertNoLiveAwsCalls(recording);
  for (const method of AWS_WRITE_METHODS) {
    assert.throws(() => forbidden[method](), (error) => error.code === CODES.GUARD_NO_AWS);
  }
  const applyBlocked = planLambdaApply(evaluateLambdaOverlay(identity()), {
    apply: true,
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '0' },
  });
  assert.equal(applyBlocked.ok, false);
  assert.equal(applyBlocked.code, CODES.GUARD_APPLY_FORBIDDEN);
});

test('happy-path overlay only changes owned members and uses RevisionId CAS', () => {
  const result = evaluateLambdaOverlay(identity());
  assert.equal(result.ok, true);
  assert.deepEqual(result.details.owned_changed, ['owned.mjs']);
  assert.equal(result.details.update_function_code.revisionId, 'rev-1');
  assert.equal(result.details.update_function_code.compareAndSwap, true);
});

test('unexpected ZIP addition or deletion fails closed', () => {
  const added = evaluateMembership({
    liveMembers: { keep: '1' },
    candidateMembers: { keep: '1', extra: '2' },
    ownedMembers: ['keep'],
  });
  assert.equal(added.ok, false);
  const deleted = evaluateMembership({
    liveMembers: { keep: '1', other: '2' },
    candidateMembers: { keep: '1' },
    ownedMembers: ['keep'],
  });
  assert.equal(deleted.ok, false);
  assert.deepEqual(deleted.details.unexpected_deleted, ['other']);
});

test('silent SQL backfill is rejected', () => {
  const result = evaluateSqlApply(identity({
    deployment_type: 'sql-apply',
    owned_components: ['x.sql'],
    filename: 'x.sql',
    migration_id: 'x',
    source_sha256: 'd'.repeat(64),
    expected_live_definition_sha256: 'e'.repeat(64),
    live_definition_sha256: 'e'.repeat(64),
    preflight_live_fingerprint: { sql: 'e'.repeat(64) },
    plan: { silent_backfill: true },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.UNRELATED_MUTATION);
});

test('manifest is machine-readable and refuses anonymous work', () => {
  const missing = buildManifest({});
  assert.equal(missing.ok, false);
  const manifest = buildManifest(identity());
  assert.equal(manifest.ok, true);
  assert.equal(manifest.details.workstream_id, 'workstream-a');
  assert.equal(manifest.details.reclaim_forbidden, true);
  assert.equal(manifest.details.stale_package_forbidden, true);
});

test('requireDeploymentGuard needs an active lease for shared targets', () => {
  const root = tmpRoot();
  const payload = identity({
    target_component: 'checksops-staging-api',
    contract_results: passingContractResults(loadContractRegistry(ROOT)),
  });
  assert.throws(() => requireDeploymentGuard(payload, { root, skip_contracts: true }), (error) => (
    error.code === CODES.LEASE_EXPIRED
  ));
  acquireLease(root, {
    workstream_id: 'workstream-a',
    component: 'checksops-staging-api',
    environment: 'staging',
    commit: SHA,
  }, Date.parse(NOW));
  const okGuard = requireDeploymentGuard(payload, { root, skip_contracts: true, now: Date.parse(NOW) + 1000 });
  assert.equal(okGuard.ok, true);
});

test('CLI evaluators fail closed and never invoke AWS', () => {
  const overlay = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/lambda-overlay.mjs'),
    '--json',
    JSON.stringify(identity({ package: { origin: 'saved-live-zip' } })),
  ], { encoding: 'utf8' });
  assert.notEqual(overlay.status, 0);
  assert.match(overlay.stderr, /STALE_PACKAGE|saved-live-zip/);

  const spa = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/spa-promote.mjs'),
    '--json',
    JSON.stringify(identity({
      deployment_type: 'spa-promote',
      owned_components: ['index.html'],
      frontend_workstreams: ['a', 'b'],
      source_composition_manifest: { files: ['src/App.tsx'] },
      dist: { clean_build: true },
      preflight: { index_html_sha256: '1', entry_bundle: '/assets/x.js' },
    })),
  ], { encoding: 'utf8' });
  assert.notEqual(spa.status, 0);
  assert.match(spa.stderr, /SOURCE_COMPOSITION_REQUIRED/);
});

test('bypass inventory classifies known writers and does not delete them', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  assert.equal(inventory.migration.do_not_delete, true);
  const byPath = Object.fromEntries(inventory.scripts.map((row) => [row.path, row]));
  assert.equal(byPath['aws/cutover/scripts/hardening-batch4-apply.mjs'].classification, 'LEGACY/BYPASS');
  assert.equal(byPath['scripts/production-deploy-guard.mjs'].classification, 'SAFE');
  for (const row of inventory.scripts) {
    assert.ok(fs.existsSync(path.join(ROOT, row.path)), row.path);
  }
});

test('accepted-contracts registry is extensible and includes required seeds', () => {
  const registry = loadContractRegistry(ROOT);
  const ids = registry.contracts.map((row) => row.id);
  for (const id of [
    'review-claim-save',
    'claim-ledger',
    'signature-requests',
    'check-files',
    'check-command-center-responsive',
    'ocr',
    'moov',
    'checkalt',
    'tenant-isolation',
    'financial-write-protections',
  ]) {
    assert.ok(ids.includes(id), id);
  }
});

test('cursor rule and AGENTS.md instruct future chats to use the guard', () => {
  const rule = fs.readFileSync(path.join(ROOT, '.cursor/rules/deployment-guard.mdc'), 'utf8');
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  for (const text of [rule, agents]) {
    assert.match(text, /scripts\/deployment-guard/);
    assert.match(text, /reclaim/i);
    assert.match(text, /DEPLOYMENT_COLLISION/);
    assert.match(text, /SOURCE_RECONCILIATION_REQUIRED/);
  }
});
