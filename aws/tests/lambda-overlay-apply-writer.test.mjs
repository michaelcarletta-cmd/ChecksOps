import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLiveAwsAdapter } from '../../scripts/deployment-guard/lib/aws-adapter.mjs';
import { consumedReceiptFile } from '../../scripts/deployment-guard/lib/consumed-receipts.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { applyLambdaOverlay } from '../../scripts/deployment-guard/lib/lambda-overlay-apply.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { hashZipMembers, readZipMembers, writeZipMembers } from '../../scripts/deployment-guard/lib/zip-members.mjs';

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

function writeNestedSources(root) {
  const owned = path.join(root, 'aws/functions/api/providers/parity');
  fs.mkdirSync(owned, { recursive: true });
  fs.writeFileSync(path.join(owned, 'moov-onboard.mjs'), 'export const nested = "new";\n');
  return {
    'providers/parity/moov-onboard.mjs': 'aws/functions/api/providers/parity/moov-onboard.mjs',
  };
}

function writeNestedMismatchSources(root) {
  const owned = path.join(root, 'aws/functions/api/providers/parity');
  fs.mkdirSync(owned, { recursive: true });
  fs.writeFileSync(path.join(owned, 'other.mjs'), 'export const nested = "wrong";\n');
  return {
    'providers/parity/moov-onboard.mjs': 'aws/functions/api/providers/parity/other.mjs',
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

function liveZipWithNested() {
  return writeZipMembers({
    ...readZipMembers(liveZip()),
    'providers/parity/moov-onboard.mjs': 'export const nested = "old";\n',
  });
}

function liveZipWithoutTenant() {
  return writeZipMembers({
    'admin-override-check-status.mjs': 'export const overlay = "admin-old";\n',
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
  owned_member_ops,
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
    ...(owned_member_ops ? { owned_member_ops } : {}),
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

function receiptConsumed(root, receipt) {
  const file = consumedReceiptFile(root, receipt);
  return Boolean(file && fs.existsSync(file));
}

function createMockAws(state, hooks = {}) {
  let getCount = 0;
  return createLiveAwsAdapter({
    clients: {
      lambda: {
        async send(command) {
          if (command.operation === 'GetFunction') {
            getCount += 1;
            const identity = typeof hooks.functionIdentity === 'function'
              ? hooks.functionIdentity({ getCount, state })
              : { CodeSha256: state.codeSha256, RevisionId: state.revisionId };
            return {
              Configuration: {
                CodeSha256: identity.CodeSha256,
                RevisionId: identity.RevisionId,
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
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

test('nested member overlay succeeds when member_sources matches aws/functions/api relative path', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, { owned: ['providers/parity/moov-onboard.mjs'] });
  const before = liveZipWithNested();
  const state = createLambdaState({ zip: before });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, {
    receipt: issued.receipt,
    member_sources: writeNestedSources(root),
  }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(state.updates.length, 1);
  const afterMembers = hashZipMembers(state.zip);
  const beforeMembers = hashZipMembers(before);
  assert.equal(afterMembers['unrelated.mjs'], beforeMembers['unrelated.mjs']);
  assert.equal(afterMembers['index.mjs'], beforeMembers['index.mjs']);
  assert.notEqual(afterMembers['providers/parity/moov-onboard.mjs'], beforeMembers['providers/parity/moov-onboard.mjs']);
  assert.equal(receiptConsumed(root, issued.receipt), true);
});

test('nested member/source mismatch fails closed before consume/write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, { owned: ['providers/parity/moov-onboard.mjs'] });
  const before = liveZipWithNested();
  const state = createLambdaState({ zip: before });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, {
    receipt: issued.receipt,
    member_sources: writeNestedMismatchSources(root),
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('nested member ../ traversal in member_sources fails closed', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, { owned: ['providers/parity/moov-onboard.mjs'] });
  const before = liveZipWithNested();
  const state = createLambdaState({ zip: before });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, {
    receipt: issued.receipt,
    member_sources: {
      'providers/parity/moov-onboard.mjs': 'aws/functions/api/providers/../parity/moov-onboard.mjs',
    },
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('nested member absolute source path outside repo fails closed', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, { owned: ['providers/parity/moov-onboard.mjs'] });
  const before = liveZipWithNested();
  const state = createLambdaState({ zip: before });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, {
    receipt: issued.receipt,
    member_sources: {
      'providers/parity/moov-onboard.mjs': '/etc/passwd',
    },
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('nested member source outside aws/functions/api fails closed', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, { owned: ['providers/parity/moov-onboard.mjs'] });
  const before = liveZipWithNested();
  const state = createLambdaState({ zip: before });
  const aws = createMockAws(state);
  const outside = path.join(root, 'scripts/outside.mjs');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'export const nested = "nope";\n');
  const result = await applyLambdaOverlay(applyOpts(root, {
    receipt: issued.receipt,
    member_sources: {
      'providers/parity/moov-onboard.mjs': 'scripts/outside.mjs',
    },
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('valid receipt + lease + incomplete { note: "no-sha" } fingerprint is refused before consume/write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, { fingerprint: { note: 'no-sha' } });
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
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(result.message, /CodeSha256/);
  assert.equal(state.updates.length, 0);
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('valid receipt + lease missing only CodeSha256 is refused before consume/write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, { fingerprint: { revisionId: 'rev-1' } });
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
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(result.message, /CodeSha256/);
  assert.equal(state.updates.length, 0);
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('valid receipt + lease missing only RevisionId is refused before consume/write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, { fingerprint: { codeSha256: 'live-sha' } });
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
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(result.message, /RevisionId/);
  assert.equal(state.updates.length, 0);
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('production gate uses actual immediately-before live identity, not receipt-to-itself', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    environment: 'production',
    component: 'checksops-production-prep-api',
  });
  const state = createLambdaState({ zip: liveZip() });
  const aws = createMockAws(state, {
    functionIdentity({ getCount, state: live }) {
      if (getCount >= 2) return { CodeSha256: 'drifted-sha', RevisionId: 'rev-drift' };
      return { CodeSha256: live.codeSha256, RevisionId: live.revisionId };
    },
  });
  const result = await applyLambdaOverlay({
    ...applyOpts(root, { receipt: issued.receipt }),
    function_name: 'checksops-production-prep-api',
    target_environment: 'production',
    staging_acceptance: { ok: true, reference: 'staging-accept-606' },
    approval: { approved: true, workstream_id: 'workstream-a' },
  }, {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.equal(state.updates.length, 0);
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('/tmp member source is refused before consume/write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root);
  const evil = path.join(os.tmpdir(), `checksops-evil-${process.pid}.mjs`);
  fs.writeFileSync(evil, 'export const pwned = true;\n');
  const sources = writeSources(root);
  sources['admin-override-check-status.mjs'] = evil;
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('traversal member source is refused before consume/write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root);
  const sources = writeSources(root);
  sources['admin-override-check-status.mjs'] = '../../evil.mjs';
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('symlink-escape member source is refused before consume/write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root);
  const evil = path.join(os.tmpdir(), `checksops-symlink-evil-${process.pid}.mjs`);
  fs.writeFileSync(evil, 'export const pwned = true;\n');
  const sources = writeSources(root);
  const link = path.join(root, 'aws/functions/api/admin-override-check-status.mjs');
  fs.unlinkSync(link);
  fs.symlinkSync(evil, link);
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('owned member absent from the current live ZIP is refused before consume/write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    owned: ['admin-override-check-status.mjs', 'tenant-check-user.mjs', 'brand-new-member.mjs'],
  });
  const sources = writeSources(root);
  fs.writeFileSync(path.join(root, 'aws/functions/api/brand-new-member.mjs'), 'export const created = true;\n');
  sources['brand-new-member.mjs'] = 'aws/functions/api/brand-new-member.mjs';
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
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(result.message, /absent from the current live Lambda ZIP/);
  assert.equal(state.updates.length, 0);
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

function zipWithDuplicateMember() {
  const base = writeZipMembers({
    'admin-override-check-status.mjs': 'export const overlay = "admin-old";\n',
    'tenant-check-user.mjs': 'export const overlay = "tenant-old";\n',
  });
  let eocd = -1;
  for (let i = base.length - 22; i >= 0; i -= 1) {
    if (base.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  const cdOffset = base.readUInt32LE(eocd + 16);
  const cdSize = base.readUInt32LE(eocd + 12);
  const nameLen = base.readUInt16LE(cdOffset + 28);
  const extraLen = base.readUInt16LE(cdOffset + 30);
  const commentLen = base.readUInt16LE(cdOffset + 32);
  const firstCd = base.subarray(cdOffset, cdOffset + 46 + nameLen + extraLen + commentLen);
  const eocdBuf = Buffer.from(base.subarray(eocd));
  eocdBuf.writeUInt16LE(base.readUInt16LE(eocd + 8) + 1, 8);
  eocdBuf.writeUInt16LE(base.readUInt16LE(eocd + 10) + 1, 10);
  eocdBuf.writeUInt32LE(cdSize + firstCd.length, 12);
  return Buffer.concat([base.subarray(0, cdOffset + cdSize), firstCd, eocdBuf]);
}

const ADD_OPS = {
  replace: ['admin-override-check-status.mjs'],
  add: ['tenant-check-user.mjs'],
};

test('explicitly authorized absent add member is eligible in mocked apply', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    owned: ['admin-override-check-status.mjs', 'tenant-check-user.mjs'],
    owned_member_ops: ADD_OPS,
  });
  assert.ok(issued.receipt.owned_member_ops);
  const before = liveZipWithoutTenant();
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
  assert.ok(afterMembers['tenant-check-user.mjs']);
  assert.equal(beforeMembers['tenant-check-user.mjs'], undefined);
  assert.deepEqual(result.details.added_members, ['tenant-check-user.mjs']);
  assert.deepEqual(result.details.after.configuration.Environment, result.details.before.configuration.Environment);
});

test('add member already present is refused before consume/write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    owned: ['admin-override-check-status.mjs', 'tenant-check-user.mjs'],
    owned_member_ops: ADD_OPS,
  });
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
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(result.message, /already exists/);
  assert.equal(state.updates.length, 0);
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('absent replacement member is refused even when add is authorized', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    owned: ['missing-replace.mjs', 'tenant-check-user.mjs'],
    owned_member_ops: { replace: ['missing-replace.mjs'], add: ['tenant-check-user.mjs'] },
  });
  const sources = writeSources(root);
  fs.writeFileSync(path.join(root, 'aws/functions/api/missing-replace.mjs'), 'export const x = 1;\n');
  const memberSources = {
    'missing-replace.mjs': 'aws/functions/api/missing-replace.mjs',
    'tenant-check-user.mjs': sources['tenant-check-user.mjs'],
  };
  const state = createLambdaState({ zip: liveZipWithoutTenant() });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, {
    receipt: issued.receipt,
    member_sources: memberSources,
  }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(result.message, /absent from the current live Lambda ZIP/);
  assert.equal(state.updates.length, 0);
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('unlisted new member is refused', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    owned: ['admin-override-check-status.mjs'],
  });
  const sources = writeSources(root);
  const state = createLambdaState({ zip: liveZipWithoutTenant() });
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

test('second unapproved new member is refused', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    owned: ['admin-override-check-status.mjs', 'tenant-check-user.mjs'],
    owned_member_ops: ADD_OPS,
  });
  const sources = writeSources(root);
  fs.writeFileSync(path.join(root, 'aws/functions/api/brand-new-member.mjs'), 'export const created = true;\n');
  sources['brand-new-member.mjs'] = 'aws/functions/api/brand-new-member.mjs';
  const state = createLambdaState({ zip: liveZipWithoutTenant() });
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('replace-only receipt cannot be reinterpreted as add by caller input', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    owned: ['admin-override-check-status.mjs', 'tenant-check-user.mjs'],
  });
  assert.equal(issued.receipt.owned_member_ops, undefined);
  const state = createLambdaState({ zip: liveZipWithoutTenant() });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, {
    receipt: issued.receipt,
    owned_member_ops: ADD_OPS,
  }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_MISMATCH);
  assert.equal(state.updates.length, 0);
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('receipt replace/add tampering fails signature validation', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    owned: ['admin-override-check-status.mjs', 'tenant-check-user.mjs'],
    owned_member_ops: ADD_OPS,
  });
  const tampered = {
    ...issued.receipt,
    owned_member_ops: {
      replace: ['admin-override-check-status.mjs'],
      add: ['tenant-check-user.mjs', 'brand-new-member.mjs'],
    },
    owned_components: [
      'admin-override-check-status.mjs',
      'tenant-check-user.mjs',
      'brand-new-member.mjs',
    ],
  };
  const state = createLambdaState({ zip: liveZipWithoutTenant() });
  const aws = createMockAws(state);
  const result = await applyLambdaOverlay(applyOpts(root, { receipt: tampered }), {
    env: APPLY_ENV,
    guardRoot: root,
    repoRoot: root,
    aws,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_FORGED);
  assert.equal(state.updates.length, 0);
});

test('traversal destination is refused', async () => {
  const root = tmpRootWithOps();
  const lease = acquireLease(root, {
    workstream_id: 'workstream-a',
    component: 'checksops-staging-api',
    environment: 'staging',
    commit: SHA,
    operator: 'test-agent',
  }, NOW);
  const issued = issueReceipt(root, {
    workstream_id: 'workstream-a',
    branch: 'cursor/test',
    commit: SHA,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'checksops-staging-api',
    deployment_type: 'lambda-overlay',
    owned_components: ['../evil.mjs'],
    owned_member_ops: { replace: [], add: ['../evil.mjs'] },
    preflight_live_fingerprint: { codeSha256: 'live-sha', revisionId: 'rev-1' },
    lease: lease.details.lease,
  }, { now: NOW });
  assert.equal(issued.ok, false);
  assert.equal(issued.code, CODES.UNRELATED_MUTATION);
});

test('absolute destination is refused', async () => {
  const root = tmpRootWithOps();
  const lease = acquireLease(root, {
    workstream_id: 'workstream-a',
    component: 'checksops-staging-api',
    environment: 'staging',
    commit: SHA,
    operator: 'test-agent',
  }, NOW);
  const result = issueReceipt(root, {
    workstream_id: 'workstream-a',
    branch: 'cursor/test',
    commit: SHA,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'checksops-staging-api',
    deployment_type: 'lambda-overlay',
    owned_components: ['/tmp/evil.mjs'],
    owned_member_ops: { replace: ['/tmp/evil.mjs'], add: [] },
    preflight_live_fingerprint: { codeSha256: 'live-sha', revisionId: 'rev-1' },
    lease: lease.details.lease,
  }, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.UNRELATED_MUTATION);
});

test('duplicate destination between replace and add is refused', async () => {
  const root = tmpRootWithOps();
  const lease = acquireLease(root, {
    workstream_id: 'workstream-a',
    component: 'checksops-staging-api',
    environment: 'staging',
    commit: SHA,
    operator: 'test-agent',
  }, NOW);
  const result = issueReceipt(root, {
    workstream_id: 'workstream-a',
    branch: 'cursor/test',
    commit: SHA,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'checksops-staging-api',
    deployment_type: 'lambda-overlay',
    owned_components: ['tenant-check-user.mjs'],
    owned_member_ops: {
      replace: ['tenant-check-user.mjs'],
      add: ['tenant-check-user.mjs'],
    },
    preflight_live_fingerprint: { codeSha256: 'live-sha', revisionId: 'rev-1' },
    lease: lease.details.lease,
  }, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.INVALID_MANIFEST);
});

test('add-member source traversal is refused before consume/write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    owned: ['admin-override-check-status.mjs', 'tenant-check-user.mjs'],
    owned_member_ops: ADD_OPS,
  });
  const sources = writeSources(root);
  sources['tenant-check-user.mjs'] = '../../evil.mjs';
  const state = createLambdaState({ zip: liveZipWithoutTenant() });
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('add-member source symlink escape is refused before consume/write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    owned: ['admin-override-check-status.mjs', 'tenant-check-user.mjs'],
    owned_member_ops: ADD_OPS,
  });
  const evil = path.join(os.tmpdir(), `checksops-add-symlink-evil-${process.pid}.mjs`);
  fs.writeFileSync(evil, 'export const pwned = true;\n');
  const sources = writeSources(root);
  const link = path.join(root, 'aws/functions/api/tenant-check-user.mjs');
  fs.unlinkSync(link);
  fs.symlinkSync(evil, link);
  const state = createLambdaState({ zip: liveZipWithoutTenant() });
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('add-member CodeSha256 drift performs no write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    owned: ['admin-override-check-status.mjs', 'tenant-check-user.mjs'],
    owned_member_ops: ADD_OPS,
    fingerprint: { codeSha256: 'old-sha', revisionId: 'rev-1' },
  });
  const state = createLambdaState({ zip: liveZipWithoutTenant(), codeSha256: 'new-sha', revisionId: 'rev-1' });
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('add-member RevisionId drift performs no write', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root, {
    owned: ['admin-override-check-status.mjs', 'tenant-check-user.mjs'],
    owned_member_ops: ADD_OPS,
    fingerprint: { codeSha256: 'live-sha', revisionId: 'rev-old' },
  });
  const state = createLambdaState({ zip: liveZipWithoutTenant(), codeSha256: 'live-sha', revisionId: 'rev-1' });
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
  assert.equal(receiptConsumed(root, issued.receipt), false);
});

test('duplicate live ZIP member names fail closed before overlay/rebuild', async () => {
  const root = tmpRootWithOps();
  const issued = issueOverlayReceipt(root);
  const duplicate = zipWithDuplicateMember();
  assert.throws(() => readZipMembers(duplicate), /DUPLICATE_ZIP_MEMBER/);
  const state = createLambdaState({ zip: duplicate });
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
  assert.match(result.message, /duplicate member names/);
  assert.equal(state.updates.length, 0);
  assert.equal(receiptConsumed(root, issued.receipt), false);
});
