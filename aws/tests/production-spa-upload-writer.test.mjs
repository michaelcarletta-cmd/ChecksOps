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
import { applyProductionSpaUpload, distFingerprint } from '../../scripts/deployment-guard/lib/production-spa-upload.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = Date.parse('2026-10-01T00:00:00.000Z');

function sha256Text(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
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
          entry_bundle: (String(afterIndexHtml).match(/\/assets\/index-[^"'\\s]+\.js/) || [null])[0],
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

  const liveBefore = {
    index_html_sha256: 'idx-live-1',
    entry_bundle: '/assets/index-live.js',
    etag: 'etag-live',
    last_modified: '2026-10-01T00:00:00.000Z',
    s3_version_id: 'v1',
  };

  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  // After index upload, the "live" index becomes the candidate.
  aws.setAfterIndexHtml(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8'));

  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
    script: 'test',
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  const putKeys = aws.calls.filter((c) => c.method === 'putObject').map((c) => c.key);
  assert.ok(putKeys.includes('index.html'));
  assert.equal(putKeys[putKeys.length - 1], 'index.html', `expected index.html last, got: ${putKeys.join(', ')}`);
  const invalidationIdx = aws.calls.findIndex((c) => c.method === 'createInvalidation');
  const indexPutIdx = aws.calls.findIndex((c) => c.method === 'putObject' && c.key === 'index.html');
  assert.ok(invalidationIdx > indexPutIdx, 'expected invalidation after index.html upload');
  assert.equal(result.details.receipt.mac, issued.receipt.mac);
});

test('production SPA writer: missing receipt fails closed', async () => {
  const root = tmpRootWithOps();
  writeDist(root);
  const aws = createFakeAws({ liveBefore: { index_html_sha256: 'x', entry_bundle: '/assets/index-x.js' } });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    fetchImpl: fetchFromDist(path.join(root, 'dist')),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_GUARD_REQUIRED);
});

test('production SPA writer: expired receipt is rejected', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = { index_html_sha256: 'idx', entry_bundle: '/assets/index-live.js', etag: 'e', last_modified: 't', s3_version_id: 'v1' };
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore, ttlMs: 1000, now: NOW });
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    fetchImpl: fetchFromDist(distDir),
    now: NOW + 5000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_EXPIRED);
});

test('production SPA writer: wrong workstream is RECEIPT_MISMATCH', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = { index_html_sha256: 'idx', entry_bundle: '/assets/index-live.js', etag: 'e', last_modified: 't', s3_version_id: 'v1' };
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore, workstream_id: 'workstream-a' });
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-b',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_MISMATCH);
});

test('production SPA writer: lost lease is fail-closed', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = { index_html_sha256: 'idx', entry_bundle: '/assets/index-live.js', etag: 'e', last_modified: 't', s3_version_id: 'v1' };
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  fs.rmSync(path.join(root, '.deployment-guard/leases/production::production-spa.json'));
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.LEASE_EXPIRED);
});

test('production SPA writer: production changed between asset upload and index switch => DEPLOYMENT_COLLISION', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = { index_html_sha256: 'idx-1', entry_bundle: '/assets/index-live.js', etag: 'e1', last_modified: 't1', s3_version_id: 'v1' };
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  // simulate drift on second read (immediately before)
  let reads = 0;
  const originalRead = aws.readIndexHtml;
  aws.readIndexHtml = async (...args) => {
    reads += 1;
    if (reads === 2) return okResult({ fingerprint: { ...liveBefore, index_html_sha256: 'idx-CHANGED' }, head: {} });
    return originalRead(...args);
  };
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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

  const liveBefore = { index_html_sha256: 'idx', entry_bundle: '/assets/index-live.js', etag: 'e', last_modified: 't', s3_version_id: 'v1' };
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });

  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.STALE_PACKAGE);
});

test('production SPA writer: wrong environment or bucket is rejected', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = { index_html_sha256: 'idx', entry_bundle: '/assets/index-live.js', etag: 'e', last_modified: 't', s3_version_id: 'v1' };
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const wrongEnv = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });
  assert.equal(wrongEnv.ok, false);
  assert.equal(wrongEnv.code, CODES.INVALID_MANIFEST);

  const wrongBucket = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });
  assert.equal(wrongBucket.ok, false);
  assert.equal(wrongBucket.code, CODES.INVALID_MANIFEST);
});

test('production SPA writer: destructive deployment mode is rejected', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = { index_html_sha256: 'idx', entry_bundle: '/assets/index-live.js', etag: 'e', last_modified: 't', s3_version_id: 'v1' };
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.STALE_PACKAGE);
});

test('production SPA writer: missing staging acceptance fails production gate', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = { index_html_sha256: 'idx', entry_bundle: '/assets/index-live.js', etag: 'e', last_modified: 't', s3_version_id: 'v1' };
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
});

test('production SPA writer: missing accepted_source_composition fails closed', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = { index_html_sha256: 'idx', entry_bundle: '/assets/index-live.js', etag: 'e', last_modified: 't', s3_version_id: 'v1' };
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_COMPOSITION_REQUIRED);
});

test('production SPA writer: failing accepted contract blocks deployment', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = { index_html_sha256: 'idx', entry_bundle: '/assets/index-live.js', etag: 'e', last_modified: 't', s3_version_id: 'v1' };
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });

  const registry = loadContractRegistry(root);
  const contract_results = { ...passingContractResults(registry), 'tenant-isolation': { ok: false } };

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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

  const liveBefore = {
    index_html_sha256: 'idx-live-1',
    entry_bundle: '/assets/index-live.js',
    etag: 'etag-live',
    last_modified: '2026-10-01T00:00:00.000Z',
    s3_version_id: 'v1',
  };
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const aws = createFakeAws({ liveBefore });
  aws.setAfterIndexHtml(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8'));

  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const result = await applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    fetchImpl: fetchFromDist(distDir, { overrideIndexHtml: '<html>WRONG</html>' }),
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
});

test('production SPA writer: receipt reuse is blocked (single-use)', async () => {
  const root = tmpRootWithOps();
  const distDir = writeDist(root);
  const liveBefore = { index_html_sha256: 'idx', entry_bundle: '/assets/index-live.js', etag: 'e', last_modified: 't', s3_version_id: 'v1' };
  const issued = issueSpaReceipt(root, { fingerprint: liveBefore });
  const registry = loadContractRegistry(root);
  const contract_results = passingContractResults(registry);

  const makeCall = async () => applyProductionSpaUpload({
    workstream_id: 'workstream-a',
    commit: SHA,
    deployment_type: 'spa-promote',
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
    aws: createFakeAws({ liveBefore }),
    fetchImpl: fetchFromDist(distDir),
    now: NOW,
  });

  const first = await makeCall();
  assert.equal(first.ok, true, JSON.stringify(first, null, 2));
  const second = await makeCall();
  assert.equal(second.ok, false);
  assert.equal(second.code, CODES.RECEIPT_REUSED);
});

