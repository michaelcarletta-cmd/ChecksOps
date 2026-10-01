import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { repoRootFrom } from '../../scripts/deployment-guard/lib/paths.mjs';
import { issueReceipt, validateReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-guard-enf-'));
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

test('direct Lambda writer fails before AWS mutation', () => {
  const result = spawnWriter('aws/cutover/scripts/hardening-batch4-apply.mjs', ['--confirm-batch4']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.equal(result.awsLog, '');
});

test('direct SPA writer fails before AWS mutation', () => {
  const result = spawnWriter('scripts/deployment-guard/spa-upload.mjs', ['--environment', 'production']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.equal(result.awsLog, '');
});

test('direct official production SPA writer fails before AWS mutation', () => {
  const result = spawnWriter('scripts/deployment-guard/production-spa-upload.mjs', ['--environment', 'production']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.equal(result.awsLog, '');
});

test('direct staging SPA writer fails before AWS mutation', () => {
  const result = spawnWriter('scripts/deployment-guard/staging-spa-upload.mjs', ['--environment', 'staging']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.equal(result.awsLog, '');
});

test('direct SQL executor invoke fails before AWS mutation', () => {
  const result = spawnWriter('scripts/deployment-guard/sql-executor-invoke.mjs', []);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.equal(result.awsLog, '');
});

test('direct CloudFront writer fails before AWS mutation', () => {
  const result = spawnWriter('aws/cloudfront/apply-step1.mjs', [], {
    CHECKSOPS_APPLY_CF_STEP1: 'APPLY_GATE1',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.equal(result.awsLog, '');
});

test('direct SQL writer fails before mutation', () => {
  const result = spawnWriter('scripts/run-hosted-tax-profile-containment.mjs', ['apply']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.equal(result.awsLog, '');
});

test('intact receipt presented for a different workstream is RECEIPT_MISMATCH', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const result = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    workstream_id: 'workstream-b',
    receipt: issued.receipt,
  }, { root, now: NOW + 1000, env: ISOLATED_ENV });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_MISMATCH);
});

test('expired receipt is rejected', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const result = validateReceipt(issued.receipt, {
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    workstream_id: 'workstream-a',
  }, { now: NOW + 16 * 60 * 1000, root });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_EXPIRED);
});

test('intact receipt presented for a different component is RECEIPT_MISMATCH', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const result = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: 'production-spa',
    deployment_type: 'spa-promote',
    workstream_id: 'workstream-a',
    receipt: issued.receipt,
  }, { root, now: NOW + 1000, env: ISOLATED_ENV });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_MISMATCH);
});

test('staging receipt cannot authorize production', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root, {
    target_environment: 'staging',
    target_component: 'checksops-staging-api',
  });
  const result = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: 'checksops-staging-api',
    deployment_type: 'lambda-overlay',
    workstream_id: 'workstream-a',
    receipt: issued.receipt,
  }, { root, now: NOW + 1000, env: ISOLATED_ENV });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.RECEIPT_MISMATCH);
});

test('stale fingerprint is rejected', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root);
  const result = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    workstream_id: 'workstream-a',
    preflight_live_fingerprint: { codeSha256: 'newer-live', revisionId: 'rev-9' },
    receipt: issued.receipt,
  }, { root, now: NOW + 1000, env: ISOLATED_ENV });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
});

test('env var alone cannot bypass the guard', () => {
  const root = tmpRoot();
  const result = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
  }, {
    root,
    now: NOW + 1000,
    env: {
      CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1',
      CHECKSOPS_DEPLOYMENT_GUARD_BYPASS: '1',
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_GUARD_REQUIRED);
});

test('valid guarded invocation reaches the mutation boundary using mocked AWS only', () => {
  const root = tmpRoot();
  const issued = issueValidReceipt(root, {}, Date.now());
  const authorized = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    workstream_id: 'workstream-a',
    commit: SHA,
    receipt: issued.receipt,
  }, { root, now: Date.now(), env: ISOLATED_ENV });
  assert.equal(authorized.ok, true);

  const spawned = spawnWriter('aws/cutover/scripts/hardening-batch4-apply.mjs', ['--confirm-batch4'], {
    CHECKSOPS_DEPLOYMENT_GUARD_ROOT: root,
    CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: issued.file,
    CHECKSOPS_WORKSTREAM_ID: 'workstream-a',
    CHECKSOPS_COMMIT: SHA,
  });
  assert.notEqual(spawned.awsLog, '');
  assert.doesNotMatch(spawned.stderr || '', /DEPLOYMENT_GUARD_REQUIRED/);
});

test('direct API Gateway writer fails before AWS mutation', () => {
  const result = spawnWriter('aws/origin-verify/apply-gate3c.mjs', [], {
    CHECKSOPS_APPLY_GATE3C: 'I_UNDERSTAND_PRODUCTION',
    CHECKSOPS_STEP3_EXECUTE: '1',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.equal(result.awsLog, '');
});

test('oneshot retargeted at a shared Lambda is refused', () => {
  const result = spawnWriter('scripts/staging-partner-integrity-inspect.mjs', [], {
    PARTNER_INTEGRITY_LAMBDA_NAME: 'checksops-staging-api',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.equal(result.awsLog, '');
});

test('repoRootFrom walks up from any in-repo caller', () => {
  assert.equal(repoRootFrom(import.meta.url), ROOT);
});

test('CI scanner accepts registered hooked writers and rejects an unregistered sample', () => {
  const live = scanRepository(ROOT);
  assert.equal(live.ok, true, live.errors.join('\n'));
  const probeDir = tmpRoot();
  fs.writeFileSync(path.join(probeDir, 'rogue-deploy.mjs'), "execFileSync('aws', ['lambda', 'update-function-code']);\n");
  fs.mkdirSync(path.join(probeDir, 'ops/deployment-guard'), { recursive: true });
  fs.writeFileSync(path.join(probeDir, 'ops/deployment-guard/bypass-inventory.json'), JSON.stringify({ scripts: [] }));
  const rogue = scanRepository(probeDir);
  assert.equal(rogue.ok, false);
  assert.ok(rogue.errors.some((row) => /unregistered/.test(row)));
});

test('package.json has no unguarded deploy command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const scripts = Object.entries(pkg.scripts || {});
  for (const [name, cmd] of scripts) {
    assert.doesNotMatch(String(cmd), /update-function-code|s3 sync|create-invalidation|sam deploy/);
    if (/^deploy:/.test(name)) {
      assert.match(String(cmd), /deployment-guard|production-deploy-guard/);
    }
  }
});
