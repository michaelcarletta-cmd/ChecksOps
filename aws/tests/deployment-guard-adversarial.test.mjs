import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { evaluateLambdaOverlay } from '../../scripts/deployment-guard/lib/lambda-overlay.mjs';
import { evaluateSpaPromote } from '../../scripts/deployment-guard/lib/spa-promote.mjs';
import { evaluateSqlApply } from '../../scripts/deployment-guard/lib/sql-apply.mjs';
import { evaluatePackageProvenance, evaluateDistFreshness } from '../../scripts/deployment-guard/lib/packages.mjs';
import { evaluateSameFileConflict } from '../../scripts/deployment-guard/lib/lambda-overlay.mjs';
import { evaluateSourceComposition } from '../../scripts/deployment-guard/lib/spa-promote.mjs';
import { evaluateInterruptedApply } from '../../scripts/deployment-guard/lib/verify-live.mjs';
import { issueReceipt, validateReceipt, buildReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { refuseUnguardedDeploy } from '../../scripts/deployment-guard/require-guard.mjs';
import { scanRepository } from '../../scripts/deployment-guard/scan-bypass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = Date.parse('2026-09-29T16:00:00.000Z');
// Isolate process.env so a leftover live CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT
// cannot replace the intact in-memory receipt under test.
const ISOLATED_ENV = {};

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-guard-adv-'));
}

function writeFakeAws(dir) {
  const log = path.join(dir, 'aws-calls.log');
  const bin = path.join(dir, 'fake-aws');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 1\n`);
  fs.chmodSync(bin, 0o755);
  return { bin, log };
}

function issueValidReceipt(root, overrides = {}, now = NOW) {
  const spec = {
    workstream_id: 'workstream-a',
    branch: 'cursor/guard-a',
    commit: SHA,
    operator: 'test-agent',
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    owned_components: ['storage.mjs'],
    preflight_live_fingerprint: { codeSha256: 'live-code', revisionId: 'rev-1' },
    ...overrides,
  };
  const lease = acquireLease(root, {
    workstream_id: spec.workstream_id,
    component: spec.target_component,
    environment: spec.target_environment,
    commit: spec.commit,
    operator: spec.operator,
  }, now);
  assert.equal(lease.ok, true, lease.message);
  spec.lease = lease.details.lease;
  const issued = issueReceipt(root, spec, { now, ttlMs: 15 * 60 * 1000 });
  assert.equal(issued.ok, true, issued.message);
  return issued.details;
}

function spawnWriter(script, args, extraEnv = {}) {
  const dir = tmpRoot();
  const fake = writeFakeAws(dir);
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      AWS_CLI: fake.bin,
      HOME: dir,
      CHECKSOPS_DEPLOYMENT_GUARD_ROOT: extraEnv.CHECKSOPS_DEPLOYMENT_GUARD_ROOT || dir,
      ...extraEnv,
    },
  });
  const awsLog = fs.existsSync(fake.log) ? fs.readFileSync(fake.log, 'utf8') : '';
  return { ...result, awsLog, dir };
}

const DIRECT_WRITERS = [
  ['aws/cutover/scripts/hardening-batch3-apply.mjs', ['--confirm-batch3']],
  ['aws/cutover/scripts/hardening-batch4-apply.mjs', ['--confirm-batch4']],
  ['aws/cutover/scripts/hardening-batch5-apply.mjs', ['--confirm-batch5']],
  ['scripts/deployment-guard/spa-upload.mjs', ['--environment', 'production']],
  ['scripts/deployment-guard/lambda-overlay-apply.mjs', ['--apply']],
  ['scripts/deployment-guard/production-spa-upload.mjs', ['--input', 'ops/deployment-guard/protected-targets.json']],
  ['scripts/deployment-guard/sql-executor-invoke.mjs', []],
  ['scripts/deployment-guard/staging-spa-upload.mjs', ['--environment', 'staging']],
  ['aws/cloudfront/apply-step1.mjs', [], { CHECKSOPS_APPLY_CF_STEP1: 'APPLY_GATE1' }],
  ['scripts/run-hosted-tax-profile-containment.mjs', ['apply']],
];

for (const [script, args, extraEnv] of DIRECT_WRITERS) {
  test(`A. direct ${script} fails before mutation`, () => {
    const result = spawnWriter(script, args, extraEnv);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
    assert.equal(result.awsLog, '');
  });
}

test('A. both #604 production SPA and #606 Lambda overlay writers stay in inventory', () => {
  const requiredGuardedWriters = [
    'scripts/deployment-guard/lambda-overlay-apply.mjs',
    'scripts/deployment-guard/production-spa-upload.mjs',
  ];
  const directPaths = DIRECT_WRITERS.map(([script]) => script);
  const inventory = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'),
    'utf8',
  ));
  const byPath = Object.fromEntries((inventory.scripts || []).map((row) => [row.path, row]));
  for (const writer of requiredGuardedWriters) {
    assert.ok(directPaths.includes(writer), `DIRECT_WRITERS dropped ${writer}`);
    assert.ok(fs.existsSync(path.join(ROOT, writer)), writer);
    assert.equal(byPath[writer]?.classification, 'GUARDED', `${writer} classification`);
  }
  assert.ok(
    (byPath['scripts/deployment-guard/lambda-overlay-apply.mjs'].capabilities || [])
      .includes('lambda-update-function-code'),
    'lambda-overlay-apply must retain lambda-update-function-code capability',
  );
  assert.ok(
    (byPath['scripts/deployment-guard/production-spa-upload.mjs'].capabilities || [])
      .includes('s3-put-object'),
    'production-spa-upload must retain s3-put-object capability',
  );
})

test('B. APPLY/BYPASS/SKIP env vars cannot authorize mutation', () => {
  const root = tmpRoot();
  for (const env of [
    { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    { CHECKSOPS_DEPLOYMENT_GUARD_BYPASS: '1' },
    { CHECKSOPS_SKIP_DEPLOYMENT_GUARD: '1' },
    {
      CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1',
      CHECKSOPS_DEPLOYMENT_GUARD_BYPASS: '1',
      CHECKSOPS_SKIP_DEPLOYMENT_GUARD: '1',
    },
  ]) {
    const result = refuseUnguardedDeploy({
      target_environment: 'production',
      target_component: 'checksops-production-prep-api',
      deployment_type: 'lambda-overlay',
    }, { root, now: NOW + 1000, env });
    assert.equal(result.ok, false, JSON.stringify(env));
    assert.equal(result.code, CODES.DEPLOYMENT_GUARD_REQUIRED);
  }

  const issued = issueValidReceipt(root);
  const bypassWithReceipt = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    workstream_id: 'workstream-a',
    commit: SHA,
    receipt: issued.receipt,
  }, {
    root,
    now: NOW + 1000,
    env: { CHECKSOPS_DEPLOYMENT_GUARD_BYPASS: '1' },
  });
  assert.equal(bypassWithReceipt.ok, false);
  assert.equal(bypassWithReceipt.code, CODES.DEPLOYMENT_GUARD_REQUIRED);
});

test('C. copied/renamed legacy writer is rejected by the scanner', () => {
  const probe = tmpRoot();
  fs.mkdirSync(path.join(probe, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'),
    path.join(probe, 'ops/deployment-guard/bypass-inventory.json'),
  );
  fs.copyFileSync(
    path.join(ROOT, 'aws/cutover/scripts/hardening-batch4-apply.mjs'),
    path.join(probe, 'rogue-batch4-copy.mjs'),
  );
  const scanned = scanRepository(probe);
  assert.equal(scanned.ok, false);
  assert.ok(scanned.errors.some((row) => /rogue-batch4-copy/.test(row)));
});

test('D. new unregistered Lambda/SPA/CloudFront/SQL writers fail the scanner', () => {
  const probe = tmpRoot();
  fs.mkdirSync(path.join(probe, 'ops/deployment-guard'), { recursive: true });
  fs.writeFileSync(path.join(probe, 'ops/deployment-guard/bypass-inventory.json'), JSON.stringify({ scripts: [] }));
  fs.writeFileSync(path.join(probe, 'rogue-lambda.mjs'), "execFileSync('aws', ['lambda', 'update-function-code']);\n");
  fs.writeFileSync(path.join(probe, 'rogue-spa.mjs'), "execFileSync('aws', ['s3', 'cp', 'dist/index.html', 's3://bucket/index.html']);\n");
  fs.writeFileSync(path.join(probe, 'rogue-cf.mjs'), "execFileSync('aws', ['cloudfront', 'create-invalidation']);\n");
  fs.writeFileSync(path.join(probe, 'rogue-sql.mjs'), "execFileSync('psql', ['-f', 'apply.sql']);\n");
  const scanned = scanRepository(probe);
  assert.equal(scanned.ok, false);
  const joined = scanned.errors.join('\n');
  assert.match(joined, /rogue-lambda/);
  assert.match(joined, /rogue-spa/);
  assert.match(joined, /rogue-cf/);
  assert.match(joined, /rogue-sql/);
});

test('E. intact receipt reuse across workstream/commit/component/environment is RECEIPT_MISMATCH', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const cases = [
    { workstream_id: 'workstream-b', commit: SHA, target_environment: 'production', target_component: 'checksops-production-prep-api', deployment_type: 'lambda-overlay' },
    { workstream_id: 'workstream-a', commit: SHA_B, target_environment: 'production', target_component: 'checksops-production-prep-api', deployment_type: 'lambda-overlay' },
    { workstream_id: 'workstream-a', commit: SHA, target_environment: 'production', target_component: 'production-spa', deployment_type: 'spa-promote' },
    { workstream_id: 'workstream-a', commit: SHA, target_environment: 'production', target_component: 'checksops-production-prep-api', deployment_type: 'spa-promote' },
  ];
  for (const expected of cases) {
    const result = refuseUnguardedDeploy({ ...expected, receipt: issued.receipt }, { root, now: NOW + 1000, env: ISOLATED_ENV });
    assert.equal(result.ok, false, JSON.stringify(expected));
    assert.equal(result.code, CODES.RECEIPT_MISMATCH);
  }

  const staging = issueValidReceipt(root, {
    target_environment: 'staging',
    target_component: 'checksops-staging-api',
  });
  const crossEnv = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: 'checksops-staging-api',
    deployment_type: 'lambda-overlay',
    workstream_id: 'workstream-a',
    receipt: staging.receipt,
  }, { root, now: NOW + 1000, env: ISOLATED_ENV });
  assert.equal(crossEnv.ok, false);
  assert.equal(crossEnv.code, CODES.RECEIPT_MISMATCH);

  const expired = validateReceipt(issued.receipt, {
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    workstream_id: 'workstream-a',
  }, { now: NOW + 16 * 60 * 1000, root });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, CODES.RECEIPT_EXPIRED);

  const stale = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    workstream_id: 'workstream-a',
    preflight_live_fingerprint: { codeSha256: 'newer-live', revisionId: 'rev-9' },
    receipt: issued.receipt,
  }, { root, now: NOW + 1000, env: ISOLATED_ENV });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, CODES.DEPLOYMENT_COLLISION);
});

test('hand-written receipt JSON is rejected even when fields match', () => {
  const root = tmpRoot();
  const lease = acquireLease(root, {
    workstream_id: 'workstream-a',
    component: 'checksops-production-prep-api',
    environment: 'production',
    commit: SHA,
  }, NOW);
  assert.equal(lease.ok, true);
  const forged = buildReceipt({
    workstream_id: 'workstream-a',
    branch: 'cursor/guard-a',
    commit: SHA,
    operator: 'hostile',
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    owned_components: ['storage.mjs'],
    preflight_live_fingerprint: { codeSha256: 'live-code', revisionId: 'rev-1' },
    lease: lease.details.lease,
  }, { now: NOW });
  const file = path.join(root, '.deployment-guard/receipts/forged.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(forged, null, 2)}\n`);
  const result = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    workstream_id: 'workstream-a',
    commit: SHA,
    receipt: forged,
  }, { root, now: NOW + 1000, env: ISOLATED_ENV });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_FORGED);

  const otherRoot = tmpRoot();
  const noLease = issueReceipt(otherRoot, forged, { now: NOW });
  assert.equal(noLease.ok, false);
  assert.equal(noLease.code, CODES.LEASE_EXPIRED);
});

test('F. stale Lambda ZIP, dist, and index.html are rejected', () => {
  assert.equal(evaluatePackageProvenance({ origin: 'saved-live-zip' }).code, CODES.STALE_PACKAGE);
  assert.equal(evaluatePackageProvenance({ origin: 'reused-old-zip' }).code, CODES.STALE_PACKAGE);
  assert.equal(evaluateDistFreshness({ origin: 'stale-dist', clean_build: false }).code, CODES.STALE_PACKAGE);
  assert.equal(evaluateDistFreshness({ clean_build: true, restore_previous_index: true }).code, CODES.STALE_PACKAGE);
});

test('G. workstream 2 changing live fingerprint blocks workstream 1 mutation', () => {
  const result = evaluateLambdaOverlay({
    workstream_id: 'workstream-a',
    branch: 'cursor/guard-a',
    commit: SHA,
    target_environment: 'staging',
    deployment_type: 'lambda-overlay',
    owned_members: ['owned.mjs'],
    owned_components: ['owned.mjs'],
    preflight: { codeSha256: 'live-code', revisionId: 'rev-1' },
    preflight_live_fingerprint: { codeSha256: 'live-code', revisionId: 'rev-1' },
    immediately_before: { codeSha256: 'changed-by-b', revisionId: 'rev-2' },
    build_timestamp: '2026-09-29T16:00:00.000Z',
    package: { origin: 'fresh-live-download' },
    live_members: { 'owned.mjs': 'old' },
    candidate_members: { 'owned.mjs': 'new' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
});

test('preflight fingerprint alone is not a mutation-boundary CAS', () => {
  const missing = evaluateLambdaOverlay({
    workstream_id: 'workstream-a',
    branch: 'cursor/guard-a',
    commit: SHA,
    target_environment: 'staging',
    deployment_type: 'lambda-overlay',
    owned_members: ['owned.mjs'],
    owned_components: ['owned.mjs'],
    preflight: { codeSha256: 'live-code', revisionId: 'rev-1' },
    preflight_live_fingerprint: { codeSha256: 'live-code', revisionId: 'rev-1' },
    build_timestamp: '2026-09-29T16:00:00.000Z',
    package: { origin: 'fresh-live-download' },
    live_members: { 'owned.mjs': 'old' },
    candidate_members: { 'owned.mjs': 'new' },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(missing.message, /immediately_before/);
});

test('H. same Lambda member across workstreams requires reconciliation', () => {
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
});

test('I. independent SPA workstreams require composition, not old-dist restore', () => {
  const composition = evaluateSourceComposition({
    frontend_workstreams: ['workstream-a', 'workstream-b'],
    accepted_composition: false,
  });
  assert.equal(composition.ok, false);
  assert.equal(composition.code, CODES.SOURCE_COMPOSITION_REQUIRED);
  const restore = evaluateSpaPromote({
    workstream_id: 'workstream-a',
    branch: 'cursor/guard-a',
    commit: SHA,
    target_environment: 'production',
    deployment_type: 'spa-promote',
    owned_components: ['index.html'],
    build_timestamp: '2026-09-29T16:00:00.000Z',
    preflight: { index_html_sha256: 'idx-1', entry_bundle: '/assets/a.js' },
    immediately_before: { index_html_sha256: 'idx-1', entry_bundle: '/assets/a.js' },
    preflight_live_fingerprint: { index_html_sha256: 'idx-1', entry_bundle: '/assets/a.js' },
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    dist: { clean_build: true },
    restore_previous_index: true,
  });
  assert.equal(restore.ok, false);
  assert.equal(restore.code, CODES.STALE_PACKAGE);
});

test('concurrent lease acquire: exactly one competing workstream succeeds', async () => {
  const root = tmpRoot();
  const children = [];
  for (let i = 0; i < 8; i += 1) {
    const script = `
      import { acquireLease } from ${JSON.stringify(path.join(ROOT, 'scripts/deployment-guard/lib/lease.mjs'))};
      const r = acquireLease(${JSON.stringify(root)}, {
        workstream_id: ${JSON.stringify(`workstream-${i}`)},
        component: 'checksops-staging-api',
        environment: 'staging',
        commit: ${JSON.stringify(SHA)},
      });
      process.stdout.write(JSON.stringify({ ok: r.ok, code: r.code, ws: r.details?.lease?.workstream_id || null }));
    `;
    children.push(spawn(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  }
  const parsed = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(out || '{}'));
      } catch (error) {
        reject(new Error(`${out} ${err} ${error.message}`));
      }
    });
  })));
  const winners = parsed.filter((row) => row.ok === true);
  assert.equal(winners.length, 1, JSON.stringify(parsed));
  assert.ok(parsed.filter((row) => row.code === CODES.LEASE_HELD).length >= 7);
});

test('interrupted apply never rolls back and reports UNKNOWN after unverified mutation', () => {
  const afterLease = evaluateInterruptedApply({ lease_acquired: true, mutated: false, verified: false });
  assert.equal(afterLease.ok, true);
  assert.equal(afterLease.details.rollback, false);
  assert.equal(afterLease.details.reclaim_forbidden, true);

  const during = evaluateInterruptedApply({ lease_acquired: true, mutated: true, verified: false });
  assert.equal(during.ok, true);
  assert.equal(during.details.status, 'UNKNOWN');
  assert.equal(during.details.reconciliation_required, true);

  const reclaim = evaluateInterruptedApply({ mutated: true, verified: false, rollback_to_previous: true });
  assert.equal(reclaim.ok, false);
  assert.equal(reclaim.code, CODES.STALE_PACKAGE);
});
