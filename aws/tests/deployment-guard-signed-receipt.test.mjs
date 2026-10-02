/**
 * Signed-receipt contract for #539.
 *
 * Tampering a MAC-covered field invalidates the HMAC => RECEIPT_FORGED.
 * An intact, correctly signed receipt used for a different requested
 * identity/target => RECEIPT_MISMATCH.
 *
 * Tests isolate process.env so a leftover live CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT
 * cannot replace the intact receipt under test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { buildReceipt, issueReceipt, validateReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { refuseUnguardedDeploy } from '../../scripts/deployment-guard/require-guard.mjs';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = Date.parse('2026-09-29T16:00:00.000Z');
const ISOLATED_ENV = {};

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-signed-receipt-'));
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

function present(root, receipt, requested, now = NOW + 1000) {
  return refuseUnguardedDeploy({
    receipt,
    ...requested,
  }, { root, now, env: ISOLATED_ENV });
}

function matchingRequest(overrides = {}) {
  return {
    workstream_id: 'workstream-a',
    commit: SHA,
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    ...overrides,
  };
}

test('1. hand-written receipt without valid MAC => RECEIPT_FORGED', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const unsigned = buildReceipt({
    workstream_id: 'workstream-a',
    branch: 'cursor/guard-a',
    commit: SHA,
    operator: 'hostile',
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    owned_components: ['storage.mjs'],
    preflight_live_fingerprint: { codeSha256: 'live-code', revisionId: 'rev-1' },
    lease: issued.receipt.lease,
  }, { now: NOW });
  const result = present(root, unsigned, matchingRequest());
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_FORGED);
});

test('2. valid receipt with one MAC-covered field edited after issuance => RECEIPT_FORGED', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const tampered = { ...issued.receipt, operator: 'edited-after-sign' };
  const result = present(root, tampered, matchingRequest());
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_FORGED);
});

test('3. valid receipt with workstream edited => RECEIPT_FORGED', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const tampered = { ...issued.receipt, workstream_id: 'workstream-b' };
  const result = present(root, tampered, matchingRequest({ workstream_id: 'workstream-b' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_FORGED);
});

test('4. valid receipt with commit edited => RECEIPT_FORGED', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const tampered = { ...issued.receipt, commit: SHA_B };
  const result = present(root, tampered, matchingRequest({ commit: SHA_B }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_FORGED);
});

test('5. valid receipt with environment edited => RECEIPT_FORGED', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const tampered = { ...issued.receipt, target_environment: 'staging' };
  const result = present(root, tampered, matchingRequest({ target_environment: 'staging' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_FORGED);
});

test('6. valid receipt with component edited => RECEIPT_FORGED', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const tampered = { ...issued.receipt, target_component: 'production-spa' };
  const result = present(root, tampered, matchingRequest({
    target_component: 'production-spa',
    deployment_type: 'spa-promote',
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_FORGED);
});

test('7. valid receipt with deployment_type edited => RECEIPT_FORGED', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const tampered = { ...issued.receipt, deployment_type: 'spa-promote' };
  const result = present(root, tampered, matchingRequest({ deployment_type: 'spa-promote' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_FORGED);
});

test('8. intact signed receipt presented for a different requested identity => RECEIPT_MISMATCH', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const cases = [
    matchingRequest({ workstream_id: 'workstream-b' }),
    matchingRequest({ commit: SHA_B }),
    matchingRequest({ target_environment: 'staging' }),
    matchingRequest({ target_component: 'production-spa', deployment_type: 'spa-promote' }),
    matchingRequest({ deployment_type: 'spa-promote' }),
  ];
  for (const requested of cases) {
    const result = present(root, issued.receipt, requested);
    assert.equal(result.ok, false, JSON.stringify(requested));
    assert.equal(result.code, CODES.RECEIPT_MISMATCH, JSON.stringify({ requested, code: result.code, message: result.message }));
  }
});

test('9. expired but otherwise intact valid receipt => RECEIPT_EXPIRED', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const result = validateReceipt(issued.receipt, matchingRequest(), {
    now: NOW + 16 * 60 * 1000,
    root,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_EXPIRED);
});

test('10. stale live fingerprint with intact valid receipt => DEPLOYMENT_COLLISION', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const result = present(root, issued.receipt, matchingRequest({
    preflight_live_fingerprint: { codeSha256: 'newer-live', revisionId: 'rev-9' },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
});

test('11. expired or missing lease remains fail-closed', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const leaseFile = path.join(root, '.deployment-guard/leases/production::checksops-production-prep-api.json');
  assert.equal(fs.existsSync(leaseFile), true);
  fs.rmSync(leaseFile);
  const missing = present(root, issued.receipt, matchingRequest());
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.LEASE_EXPIRED);

  const otherRoot = tmpRoot();
  const noLease = issueReceipt(otherRoot, issued.receipt, { now: NOW });
  assert.equal(noLease.ok, false);
  assert.equal(noLease.code, CODES.LEASE_EXPIRED);
});

test('owned_member_ops is MAC-covered and cannot be added after issuance', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root, {
    owned_components: ['admin-override-check-status.mjs', 'tenant-check-user.mjs'],
  });
  assert.equal(issued.receipt.owned_member_ops, undefined);
  const tampered = {
    ...issued.receipt,
    owned_member_ops: {
      replace: ['admin-override-check-status.mjs'],
      add: ['tenant-check-user.mjs'],
    },
  };
  const result = present(root, tampered, matchingRequest());
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_FORGED);
});

test('owned_member_ops add list cannot be expanded after issuance', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root, {
    owned_components: ['admin-override-check-status.mjs', 'tenant-check-user.mjs'],
    owned_member_ops: {
      replace: ['admin-override-check-status.mjs'],
      add: ['tenant-check-user.mjs'],
    },
  });
  assert.deepEqual(issued.receipt.owned_member_ops.add, ['tenant-check-user.mjs']);
  const tampered = {
    ...issued.receipt,
    owned_components: [
      'admin-override-check-status.mjs',
      'tenant-check-user.mjs',
      'second.mjs',
    ],
    owned_member_ops: {
      replace: ['admin-override-check-status.mjs'],
      add: ['tenant-check-user.mjs', 'second.mjs'],
    },
  };
  const result = present(root, tampered, matchingRequest());
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_FORGED);
});

test('12. environment variables cannot bypass receipt validation', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  for (const env of [
    { CHECKSOPS_DEPLOYMENT_GUARD_BYPASS: '1' },
    { CHECKSOPS_SKIP_DEPLOYMENT_GUARD: '1' },
    { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', CHECKSOPS_DEPLOYMENT_GUARD_BYPASS: '1' },
  ]) {
    const result = refuseUnguardedDeploy(matchingRequest({ receipt: issued.receipt }), {
      root,
      now: NOW + 1000,
      env,
    });
    assert.equal(result.ok, false, JSON.stringify(env));
    assert.equal(result.code, CODES.DEPLOYMENT_GUARD_REQUIRED);
  }
});
