import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { loadContractRegistry, passingContractResults } from '../../scripts/deployment-guard/lib/contracts.mjs';
import { applyProductionSpaUpload, distFingerprint, entryFromHtml } from '../../scripts/deployment-guard/lib/production-spa-upload.mjs';
import { ACCEPTED_PRODUCTION_SPA } from '../../scripts/lib/production-spa-baseline.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = Date.parse('2026-10-01T00:00:00.000Z');

function sha256Text(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

const LOCKED_PINS = Object.freeze({
  spa_bundle: ACCEPTED_PRODUCTION_SPA.spa_bundle,
  spa_sha256: ACCEPTED_PRODUCTION_SPA.spa_sha256,
  index_html_sha256: ACCEPTED_PRODUCTION_SPA.index_html_sha256,
  s3_version: ACCEPTED_PRODUCTION_SPA.s3_version,
});

function lockedLiveBefore(overrides = {}) {
  return {
    index_html_sha256: ACCEPTED_PRODUCTION_SPA.index_html_sha256,
    entry_bundle: ACCEPTED_PRODUCTION_SPA.spa_bundle,
    etag: 'etag-live',
    last_modified: ACCEPTED_PRODUCTION_SPA.last_modified,
    s3_version_id: ACCEPTED_PRODUCTION_SPA.s3_version,
    ...overrides,
  };
}

function tmpRootWithOps() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-prod-spa-writer-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'ops/deployment-guard/accepted-contracts.json'),
    path.join(root, 'ops/deployment-guard/accepted-contracts.json'),
  );
  return root;
}

function writeDist(root, { entry = '/assets/index-candidate.js', js = "console.log('candidate');\n" } = {}) {
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), `<!doctype html>
<html>
  <head></head>
  <body>
    <script type="module" src="${entry}"></script>
  </body>
</html>
`);
  fs.writeFileSync(path.join(distDir, entry.replace(/^\//, '')), js);
  return distDir;
}

function issueSpaReceipt(root, {
  workstream_id = 'workstream-a',
  commit = SHA,
  fingerprint,
  ttlMs = 15 * 60 * 1000,
  now = NOW,
} = {}) {
  const lease = acquireLease(root, {
    workstream_id,
    component: 'production-spa',
    environment: 'production',
    commit,
    operator: 'test-agent',
  }, now);
  assert.equal(lease.ok, true, lease.message);
  const issued = issueReceipt(root, {
    workstream_id,
    branch: 'cursor/test',
    commit,
    operator: 'test-agent',
    target_environment: 'production',
    target_component: 'production-spa',
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    owned_components: ['index.html'],
    preflight_live_fingerprint: fingerprint,
    lease: lease.details.lease,
  }, { now, ttlMs });
  assert.equal(issued.ok, true, issued.message);
  return issued.details;
}

function okResult(details) {
  return { ok: true, code: null, message: null, details, errors: [] };
}

function createSharedReceiptRegistry() {
  const consumed = new Set();
  const calls = [];
  return {
    kind: 'in-memory-consumed-receipts',
    calls,
    consumed,
    async consumeOnce({ receipt, target }) {
      calls.push({ mac: receipt?.mac || null, target: target?.id || null });
      const mac = String(receipt?.mac || '').trim();
      if (consumed.has(mac)) {
        return { ok: false, code: CODES.RECEIPT_REUSED, message: 'already consumed', details: { mac }, errors: [{ code: CODES.RECEIPT_REUSED, message: 'already consumed', details: { mac } }] };
      }
      consumed.add(mac);
      return okResult({ consumed: true, mac, registry: 'memory' });
    },
  };
}

function createFakeAws({ liveBefore, liveBeforeIndex = '<html></html>' } = {}) {
  const calls = [];
  let current = { ...liveBefore };
  let afterIndexHtml = null;
  let indexUploaded = false;
  return {
    calls,
    setAfterIndexHtml(html) {
      afterIndexHtml = html;
    },
    async readIndexHtml({ bucket, key }) {
      calls.push({ method: 'readIndexHtml', bucket, key });
      // Simulate S3 reads: after index upload, reflect the uploaded index.
      if (indexUploaded && afterIndexHtml) {
        current = {
          ...current,
          index_html_sha256: sha256Text(afterIndexHtml),
          entry_bundle: entryFromHtml(afterIndexHtml),
        };
      }
      return okResult({ fingerprint: current, head: { VersionId: current.s3_version_id || null } });
    },
    async putObject({ bucket, key }) {
      calls.push({ method: 'putObject', bucket, key });
      if (key === 'index.html') indexUploaded = true;
      return okResult({ key, s3_version_id: 'v-new' });
    },
    async createInvalidation({ distributionId, paths }) {
      calls.push({ method: 'createInvalidation', distributionId, paths });
      return okResult({ distribution_id: distributionId, invalidation_id: 'INV123' });
    },
    async waitForInvalidation({ distributionId, invalidationId }) {
      calls.push({ method: 'waitForInvalidation', distributionId, invalidationId });
      return okResult({ distribution_id: distributionId, invalidation_id: invalidationId, status: 'Completed' });
    },
  };
}

function fetchFromDist(distDir, { overrideIndexHtml = null, overrideJs = null } = {}) {
  return async (url) => {
    const u = new URL(url);
    const pathname = u.pathname;
    let body;
    if (pathname === '/index.html') {
      body = overrideIndexHtml ?? fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    } else if (pathname.startsWith('/assets/')) {
      body = overrideJs ?? fs.readFileSync(path.join(distDir, pathname.replace(/^\//, '')), 'utf8');
    } else {
      return { ok: false, status: 404, text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => body };
  };
}

const TARGET = Object.freeze({
  id: 'production-spa',
  kind: 'spa',
  environment: 'production',
  s3_bucket: 'checksops-production-frontend-806168576068',
  cloudfront_id: 'E1B0ZWWO5559U5',
  host: 'https://checksops.example.test',
});

test('production SPA writer: happy-path upload order, drift checks, and post-verify', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root, { entry: '/assets/index-candidate.js', js: "console.log('candidate');\n" });
  const candidate = distFingerprint(distDir);
  assert.equal(candidate.ok, true);

  const liveBefore = lockedLiveBefore();

  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  // After index upload, the "live" index becomes the candidate.
  aws.setAfterIndexHtml(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8'));

  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    operator: 'test-agent',
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    accepted_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
    script: 'test',
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  const putKeys = aws.calls.filter((c) => c.method === 'putObject').map((c) => c.key);
  assert.ok(putKeys.includes('index.html'));
  assert.equal(putKeys[putKeys.length - 1], 'index.html', `expected index.html last, got: ${putKeys.join(', ')}`);
  const invalidationIdx = aws.calls.findIndex((c) => c.method === 'createInvalidation');
  const waitIdx = aws.calls.findIndex((c) => c.method === 'waitForInvalidation');
  const indexPutIdx = aws.calls.findIndex((c) => c.method === 'putObject' && c.key === 'index.html');
  assert.ok(invalidationIdx > indexPutIdx, 'expected invalidation after index.html upload');
  assert.ok(waitIdx > invalidationIdx, 'expected waitForInvalidation after createInvalidation');
  assert.equal(result.details.receipt.mac, issued.receipt.mac);
});

test('production SPA writer: missing receipt fails closed', async () => {
  const root = tmpRootWithOps();
  writeDist(root);
  const aws = createFakeAws({ liveBefore: { index_html_sha256: 'x', entry_bundle: '/assets/index-x.js' } });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    dist_dir: path.join(root, 'dist'),
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(path.join(root, 'dist')),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_GUARD_REQUIRED);
});

test('production SPA writer: expired receipt is rejected', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore, ttlMs: 1000, now: NOW });
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW + 5000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_EXPIRED);
});

test('production SPA writer: wrong workstream is RECEIPT_MISMATCH', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore, workstream_id: 'workstream-a' });
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-b',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-b'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-b' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_MISMATCH);
});

test('production SPA writer: lost lease is fail-closed', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  fs.rmSync(path.join(root, '.deployment-guard/leases/production::production-spa.json'));
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.LEASE_EXPIRED);
});

test('production SPA writer: production changed between asset upload and index switch => DEPLOYMENT_COLLISION', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  // simulate drift on second read (immediately before)
  let reads = 0;
  const originalRead = aws.readIndexHtml;
  aws.readIndexHtml = async (...args) => {
    reads += 1;
    if (reads === 3) return okResult({ fingerprint: { ...liveBefore, index_html_sha256: 'idx-CHANGED' }, head: {} });
    return originalRead(...args);
  };
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
});

test('production SPA writer: production drift before first write => DEPLOYMENT_COLLISION and no writes', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const receiptFingerprint = { index_html_sha256: 'idx-OLD', entry_bundle: '/assets/index-live.js', etag: 'e', last_modified: 't', s3_version_id: 'v1' };
  const issued = issueSpaReceipt(root, { fingerprint: receiptFingerprint });
  const aws = createFakeAws({ liveBefore: { ...receiptFingerprint, index_html_sha256: 'idx-NEW' } });

  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();
  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.equal(aws.calls.filter((c) => c.method === 'putObject').length, 0);
});

test('production SPA writer: malformed/dist missing entry bundle => STALE_PACKAGE', async () => {
  const root = tmpRootWithOps();
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<html><script type="module" src="/assets/index-missing.js"></script></html>');

  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });

  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.STALE_PACKAGE);
});

test('production SPA writer: wrong environment or bucket is rejected', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const wrongEnv = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: { ...TARGET, environment: 'staging' },
    aws: createFakeAws({ liveBefore }),
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });
  assert.equal(wrongEnv.ok, false);
  assert.equal(wrongEnv.code, CODES.INVALID_MANIFEST);

  const wrongBucket = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: { ...TARGET, s3_bucket: 'unregistered-bucket' },
    aws: createFakeAws({ liveBefore }),
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });
  assert.equal(wrongBucket.ok, false);
  assert.equal(wrongBucket.code, CODES.INVALID_MANIFEST);
});

test('production SPA writer: destructive deployment mode is rejected', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'sync',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.STALE_PACKAGE);
});

test('production SPA writer: missing staging acceptance fails production gate', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
});

test('production SPA writer: missing production approval fails production gate', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
});

test('production SPA writer: missing accepted_source_composition fails closed', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_COMPOSITION_REQUIRED);
});

test('production SPA writer: failing accepted contract blocks deployment', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });

  const registry = loadContractRegistry(root);
  const contract_results = { ...passingContractResults(registry), 'tenant-isolation': { ok: false } };
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
});

test('production SPA writer: post-deploy verification mismatch fails without rollback', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root, { entry: '/assets/index-candidate.js', js: "console.log('candidate');\n" });
  const candidate = distFingerprint(distDir);
  assert.equal(candidate.ok, true);

  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  aws.setAfterIndexHtml(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8'));

  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir, { overrideIndexHtml: '<html>WRONG</html>' }),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
});

test('production SPA writer: receipt reuse is blocked (single-use)', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);
  const receiptRegistry = createSharedReceiptRegistry();

  const makeCall = async () => {
    const aws = createFakeAws({ liveBefore });
    aws.setAfterIndexHtml(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8'));
    return applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });
  };

  const first = await makeCall();
  assert.equal(first.ok, true, JSON.stringify(first, null, 2));
  const second = await makeCall();
  assert.equal(second.ok, false);
  assert.equal(second.code, CODES.RECEIPT_REUSED);
});

test('production SPA writer: same receipt consumed across independent guard roots', async () => {
  const rootA = tmpRootWithOps();
  const rootB = tmpRootWithOps();
  const distA = writeDist(rootA);
  const distB = writeDist(rootB);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(rootA, { fingerprint: liveBefore });

  // Copy issuer key + lease so rootB can validate the signed receipt.
  fs.mkdirSync(path.join(rootB, '.deployment-guard'), { recursive: true });
  fs.copyFileSync(
    path.join(rootA, '.deployment-guard/issuer.key'),
    path.join(rootB, '.deployment-guard/issuer.key'),
  );
  fs.mkdirSync(path.join(rootB, '.deployment-guard/leases'), { recursive: true });
  fs.copyFileSync(
    path.join(rootA, '.deployment-guard/leases/production::production-spa.json'),
    path.join(rootB, '.deployment-guard/leases/production::production-spa.json'),
  );

  const contract_results_a = passingContractResults(loadContractRegistry(rootA));
  const contract_results_b = passingContractResults(loadContractRegistry(rootB));
  const receiptRegistry = createSharedReceiptRegistry();

  const first = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distA,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results: contract_results_a,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: rootA,
    target: TARGET,
    aws: (() => {
      const aws = createFakeAws({ liveBefore });
      aws.setAfterIndexHtml(fs.readFileSync(path.join(distA, 'index.html'), 'utf8'));
      return aws;
    })(),
    receiptRegistry,
    fetchImpl: fetchFromDist(distA),
    now: NOW,
  });
  assert.equal(first.ok, true, JSON.stringify(first, null, 2));

  const secondAws = createFakeAws({ liveBefore });
  secondAws.setAfterIndexHtml(fs.readFileSync(path.join(distB, 'index.html'), 'utf8'));
  const second = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distB,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results: contract_results_b,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: rootB,
    target: TARGET,
    aws: secondAws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distB),
    now: NOW,
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, CODES.RECEIPT_REUSED);
  assert.equal(secondAws.calls.filter((c) => c.method === 'putObject').length, 0);
});

test('production SPA writer: simultaneous consumption attempts -> exactly one succeeds', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const contract_results = passingContractResults(loadContractRegistry(root));
  const receiptRegistry = createSharedReceiptRegistry();

  const makeCall = () => {
    const aws = createFakeAws({ liveBefore });
    aws.setAfterIndexHtml(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8'));
    const p = applyProductionSpaUpload({
      workstream_id: 'workstream-a',
      commit: SHA,
      deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
      receipt: issued.receipt,
      dist_dir: distDir,
      deploy_mode: 'per_object_put',
      accepted_source_composition: true,
      source_composition_manifest: { files: ['src/App.tsx'] },
      frontend_workstreams: ['workstream-a'],
      staging_acceptance: { ok: true, reference: 'staging#acceptance' },
      approval: { approved: true, workstream_id: 'workstream-a' },
      contract_results,
    }, {
      env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
      guardRoot: root,
      target: TARGET,
      aws,
      receiptRegistry,
      fetchImpl: fetchFromDist(distDir),
      now: NOW,
    });
    return { p, aws };
  };

  const a = makeCall();
  const b = makeCall();
  const settled = await Promise.allSettled([a.p, b.p]);
  const oks = settled.filter((r) => r.status === 'fulfilled' && r.value?.ok === true);
  const reuses = settled.filter((r) => r.status === 'fulfilled' && r.value?.code === CODES.RECEIPT_REUSED);
  assert.equal(oks.length, 1, JSON.stringify(settled, null, 2));
  assert.equal(reuses.length, 1, JSON.stringify(settled, null, 2));
});

test('production SPA writer: different receipts are independent', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const r1 = issueSpaReceipt(root, { fingerprint: liveBefore, now: NOW });
  const r2 = issueSpaReceipt(root, { fingerprint: liveBefore, now: NOW + 1000 });
  const contract_results = passingContractResults(loadContractRegistry(root));
  const receiptRegistry = createSharedReceiptRegistry();

  for (const issued of [r1, r2]) {
    const aws = createFakeAws({ liveBefore });
    aws.setAfterIndexHtml(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8'));
    const result = await applyProductionSpaUpload({
      workstream_id: 'workstream-a',
      commit: SHA,
      deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
      receipt: issued.receipt,
      dist_dir: distDir,
      deploy_mode: 'per_object_put',
      accepted_source_composition: true,
      source_composition_manifest: { files: ['src/App.tsx'] },
      frontend_workstreams: ['workstream-a'],
      staging_acceptance: { ok: true, reference: 'staging#acceptance' },
      approval: { approved: true, workstream_id: 'workstream-a' },
      contract_results,
    }, {
      env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
      guardRoot: root,
      target: TARGET,
      aws,
      receiptRegistry,
      fetchImpl: fetchFromDist(distDir),
      now: NOW,
    });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  }
});

test('production SPA writer: invalid receipts do not get recorded as consumed', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore, ttlMs: 1000, now: NOW });
  const contract_results = passingContractResults(loadContractRegistry(root));
  const receiptRegistry = createSharedReceiptRegistry();
  const aws = createFakeAws({ liveBefore });

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW + 5000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_EXPIRED);
  assert.equal(receiptRegistry.calls.length, 0);
});

test('production SPA writer: entry regex accepts hashes containing s', () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root, { entry: '/assets/index-CTqMys28.js', js: "console.log('live');\n" });
  const candidate = distFingerprint(distDir);
  assert.equal(candidate.ok, true, JSON.stringify(candidate, null, 2));
  assert.equal(candidate.details.entry_bundle, '/assets/index-CTqMys28.js');
  assert.equal(entryFromHtml(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')), '/assets/index-CTqMys28.js');
});

test('production SPA writer: superseded SPA bundle is refused before write', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root, { entry: '/assets/index-DSbVZXu8.js', js: "console.log('stale');\n" });
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  const contract_results = passingContractResults(loadContractRegistry(root));
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.STALE_PACKAGE);
  assert.equal(aws.calls.filter((c) => c.method === 'putObject').length, 0);
  assert.equal(receiptRegistry.calls.length, 0);
});

test('production SPA writer: live lock pin mismatch is refused before write', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root, { entry: '/assets/index-candidate.js' });
  const liveBefore = lockedLiveBefore({
    entry_bundle: '/assets/index-Unexpected.js',
    index_html_sha256: 'd'.repeat(64),
    s3_version_id: 'OTHER',
  });
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  const contract_results = passingContractResults(loadContractRegistry(root));
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.equal(aws.calls.filter((c) => c.method === 'putObject').length, 0);
  assert.equal(receiptRegistry.calls.length, 0);
});

test('production SPA writer: host verify waits for CloudFront invalidation', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root, { entry: '/assets/index-CTqMys28.js', js: "console.log('candidate');\n" });
  const liveBefore = lockedLiveBefore();
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  aws.setAfterIndexHtml(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8'));
  const order = [];
  const originalWait = aws.waitForInvalidation.bind(aws);
  aws.waitForInvalidation = async (...args) => {
    order.push('wait');
    return originalWait(...args);
  };
  const fetchImpl = fetchFromDist(distDir);
  const wrappedFetch = async (...args) => {
    order.push('host');
    return fetchImpl(...args);
  };
  const contract_results = passingContractResults(loadContractRegistry(root));
  const receiptRegistry = createSharedReceiptRegistry();

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
    clean_build: true,
    based_on_baseline: LOCKED_PINS,
    receipt: issued.receipt,
    dist_dir: distDir,
    deploy_mode: 'per_object_put',
    accepted_source_composition: true,
    source_composition_manifest: { files: ['src/App.tsx'] },
    frontend_workstreams: ['workstream-a'],
    staging_acceptance: { ok: true, reference: 'staging#acceptance' },
    approval: { approved: true, workstream_id: 'workstream-a' },
    contract_results,
  }, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: root,
    target: TARGET,
    aws,
    receiptRegistry,
    fetchImpl: wrappedFetch,
    now: NOW,
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.ok(order.indexOf('wait') >= 0);
  assert.ok(order.indexOf('host') > order.indexOf('wait'));
});

