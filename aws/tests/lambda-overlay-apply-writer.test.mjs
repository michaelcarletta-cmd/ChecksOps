import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLiveAwsAdapter } from '../../scripts/deployment-guard/lib/aws-adapter.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { applyLambdaOverlay } from '../../scripts/deployment-guard/lib/lambda-overlay-apply.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { hashZipMembers, writeZipMembers } from '../../scripts/deployment-guard/lib/zip-members.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = Date.parse('2026-10-02T00:00:00.000Z');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function tmpRootWithOps() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-lambda-apply-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'ops/deployment-guard/accepted-contracts.json'),
    path.join(root, 'ops/deployment-guard/accepted-contracts.json'),
  );
  return root;
}

function writeSources(root) {
  const owned = path.join(root, 'aws/functions/api');
  fs.mkdirSync(owned, { recursive: true });
  fs.writeFileSync(path.join(owned, 'admin-override-check-status.mjs'), 'export const overlay = "admin-new";\n');
  fs.writeFileSync(path.join(owned, 'tenant-check-user.mjs'), 'export const overlay = "tenant-new";\n');
  return {
    'admin-override-check-status.mjs': 'aws/functions/api/admin-override-check-status.mjs',
    'tenant-check-user.mjs': 'aws/functions/api/tenant-check-user.mjs',
  };
}

function liveZip() {
  return writeZipMembers({
    'admin-override-check-status.mjs': 'export const overlay = "admin-old";\n',
    'tenant-check-user.mjs': 'export const overlay = "tenant-old";\n',
    'unrelated.mjs': 'export const keep = true;\n',
    'index.mjs': 'export const handler = true;\n',
  });
}

function issueOverlayReceipt(root, {
  workstream_id = 'workstream-a',
  environment = 'staging',
  component = 'checksops-staging-api',
  fingerprint = { codeSha256: 'live-sha', revisionId: 'rev-1' },
  owned = ['admin-override-check-status.mjs', 'tenant-check-user.mjs'],
  ttlMs = 15 * 60 * 1000,
  now = NOW,
} = {}) {
  const lease = acquireLease(root, {
    workstream_id,
    component,
    environment,
    commit: SHA,
    operator: 'test-agent',
  }, now);
  assert.equal(lease.ok, true, lease.message);
  const issued = issueReceipt(root, {
    workstream_id,
    branch: 'cursor/test',
    commit: SHA,
    operator: 'test-agent',
    target_environment: environment,
    target_component: component,
    deployment_type: 'lambda-overlay',
    owned_components: owned,
    preflight_live_fingerprint: fingerprint,
    lease: lease.details.lease,
  }, { now, ttlMs });
  assert.equal(issued.ok, true, issued.message);
  return issued.details;
}

function createLambdaState({ zip, codeSha256 = 'live-sha', revisionId = 'rev-1', environment = { KEEP: '1' } } = {}) {
  const state = {
    zip,
    codeSha256,
    revisionId,
    lastUpdateStatus: 'Successful',
    configuration: {
      Role: 'arn:aws:iam::806168576068:role/checksops-staging-api',
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      MemorySize: 1024,
      Timeout: 30,
      Environment: { Variables: { ...environment } },
      VpcConfig: { SubnetIds: ['subnet-1'], SecurityGroupIds: ['sg-1'] },
    },
    updates: [],
  };
  return state;
}

function createMockAws(state) {
  return createLiveAwsAdapter({
    clients: {
      lambda: {
        async send(command) {
          if (command.operation === 'GetFunction') {
            return {
              Configuration: {
                CodeSha256: state.codeSha256,
                RevisionId: state.revisionId,
                ...state.configuration,
              },
              Code: { Location: 'https://example.test/current.zip' },
            };
          }
          if (command.operation === 'GetFunctionConfiguration') {
            return {
              CodeSha256: state.codeSha256,
              RevisionId: state.revisionId,
              LastUpdateStatus: state.lastUpdateStatus,
              ...state.configuration,
            };
          }
          if (command.operation === 'UpdateFunctionCode') {
            state.updates.push(command.input);
            state.zip = Buffer.from(command.input.ZipFile);
            state.codeSha256 = sha256(state.zip);
            state.revisionId = 'rev-2';
            return {
              CodeSha256: state.codeSha256,
              RevisionId: state.revisionId,
              LastUpdateStatus: 'Successful',
            };
          }
          throw new Error(`unexpected ${command.operation}`);
        },
      },
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => state.zip,
    }),
    loadSdkImpl: async () => {
      throw new Error('tests must not load the AWS SDK');
    },
  });
}

function applyOpts(root, extra = {}) {
  return {
    workstream_id: 'workstream-a',
    commit: SHA,
    apply: true,
    function_name: 'checksops-staging-api',
    member_sources: writeSources(root),
    ...extra,
  };
}

const APPLY_ENV = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' };

test('missing receipt performs no write', async () => {
  const root = tmpRootWithOps();
  const state = createLambdaState({ zip: liveZip() });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_GUARD_REQUIRED);
  assert.equal(state.updates.length, 0);
});

test('apply flag without valid authorization is insufficient', async () => {
  const root = tmpRootWithOps();
  const state = createLambdaState({ zip: liveZip() });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root), {
    env: {},
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal(state.updates.length, 0);
});

test('invalid receipt performs no write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root);
  const state = createLambdaState({ zip: liveZip() });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, {
    receipt: { ...issued.receipt, mac: '0'.repeat(64) },
  }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.ok([CODES.RECEIPT_FORGED, CODES.DEPLOYMENT_GUARD_REQUIRED, CODES.RECEIPT_MISMATCH].includes(result.code), result.code);
  assert.equal(state.updates.length, 0);
});

test('expired receipt performs no write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, { ttlMs: 1000 });
  const state = createLambdaState({ zip: liveZip() });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, { receipt: issued.receipt }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW + 5000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_EXPIRED);
  assert.equal(state.updates.length, 0);
});

test('wrong lease / lost lease performs no write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root);
  fs.rmSync(path.join(root, '.deployment-guard/leases/staging::checksops-staging-api.json'));
  const state = createLambdaState({ zip: liveZip() });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, { receipt: issued.receipt }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.LEASE_EXPIRED);
  assert.equal(state.updates.length, 0);
});

test('wrong environment / Lambda performs no write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    environment: 'staging',
    component: 'checksops-staging-api',
  });
  const state = createLambdaState({ zip: liveZip() });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, {
    receipt: issued.receipt,
    function_name: 'checksops-production-prep-api',
    target_environment: 'production',
  }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.ok([CODES.RECEIPT_MISMATCH, CODES.DEPLOYMENT_GUARD_REQUIRED].includes(result.code), result.code);
  assert.equal(state.updates.length, 0);
});

test('unapproved member is refused', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root);
  const sources = writeSources(root);
  sources['unrelated.mjs'] = 'aws/functions/api/admin-override-check-status.mjs';
  const state = createLambdaState({ zip: liveZip() });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, {
    receipt: issued.receipt,
    member_sources: sources,
  }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.UNRELATED_MUTATION);
  assert.equal(state.updates.length, 0);
});

test('CodeSha256 drift performs no write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, { fingerprint: { codeSha256: 'old-sha', revisionId: 'rev-1' } });
  const state = createLambdaState({ zip: liveZip(), codeSha256: 'new-sha', revisionId: 'rev-1' });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, { receipt: issued.receipt }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.equal(state.updates.length, 0);
});

test('RevisionId drift performs no write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, { fingerprint: { codeSha256: 'live-sha', revisionId: 'rev-old' } });
  const state = createLambdaState({ zip: liveZip(), codeSha256: 'live-sha', revisionId: 'rev-1' });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, { receipt: issued.receipt }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.equal(state.updates.length, 0);
});

test('reused receipt performs no second write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root);
  const state = createLambdaState({ zip: liveZip() });
  const first = await applyLambdaOverlay(applyOpts(root, { receipt: issued.receipt }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws: createMockAws(state),
    now: NOW,
  });
  assert.equal(first.ok, true, first.message);
  const secondState = createLambdaState({ zip: liveZip(), codeSha256: 'live-sha', revisionId: 'rev-1' });
  const second = await applyLambdaOverlay(applyOpts(root, { receipt: issued.receipt }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws: createMockAws(secondState),
    now: NOW,
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, CODES.RECEIPT_REUSED);
  assert.equal(secondState.updates.length, 0);
});

test('old ZIP restore input is impossible', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root);
  const state = createLambdaState({ zip: liveZip() });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, {
    receipt: issued.receipt,
    saved_zip: '/tmp/old.zip',
    restore: true,
  }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.STALE_PACKAGE);
  assert.equal(state.updates.length, 0);
});

test('happy path overlays only owned members and preserves env/config', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root);
  const before = liveZip();
  const state = createLambdaState({ zip: before });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, { receipt: issued.receipt }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(state.updates.length, 1);
  assert.equal(state.updates[0].RevisionId, 'rev-1');
  const afterMembers = hashZipMembers(state.zip);
  const beforeMembers = hashZipMembers(before);
  assert.equal(afterMembers['unrelated.mjs'], beforeMembers['unrelated.mjs']);
  assert.equal(afterMembers['index.mjs'], beforeMembers['index.mjs']);
  assert.notEqual(afterMembers['admin-override-check-status.mjs'], beforeMembers['admin-override-check-status.mjs']);
  assert.notEqual(afterMembers['tenant-check-user.mjs'], beforeMembers['tenant-check-user.mjs']);
  assert.equal(result.details.after.configuration.Environment.KEEP, '1');
  assert.deepEqual(result.details.after.configuration.Environment, result.details.before.configuration.Environment);
});

test('production structurally requires approval and is not exercised', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    environment: 'production',
    component: 'checksops-production-prep-api',
  });
  const state = createLambdaState({ zip: liveZip() });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay({
    ...applyOpts(root, { receipt: issued.receipt }),
    function_name: 'checksops-production-prep-api',
    target_environment: 'production',
  }, {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal(state.updates.length, 0);
});
