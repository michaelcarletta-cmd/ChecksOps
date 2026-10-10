import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  SQL53_INSPECT_AUTH_ENV,
  SQL53_INSPECT_EXPIRES_ENV,
  SQL53_INSPECT_FUNCTION,
  SQL53_INSPECT_FUNCTION_ARN,
  SQL53_INSPECT_LIVE_PIN,
  SQL53_INSPECT_PUBLISHED_MARKER,
  evaluateSql53InspectPrepare,
  planInspectCleanup,
  planInspectIam,
  planInspectInvoke,
  planPreservingEnvOverlay,
} from '../../scripts/deployment-guard/lib/sql53-production-inspect-prepare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXISTING = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'ops/deployment-guard/production-sql53-inspect-ready.json'),
  'utf8',
)).live.environment_keys;
const TOKEN = 'owner-chosen-sql53-inspect-token-32chars-min';
const NOW = Date.parse('2026-10-10T18:30:00.000Z');
const EXPIRES = '2026-10-10T20:00:00.000Z';

test('env overlay preserves every existing key and adds only the two temporary inspect vars', () => {
  assert.equal(EXISTING.length, 49);
  assert.equal(EXISTING.includes(SQL53_INSPECT_AUTH_ENV), false);
  assert.equal(EXISTING.includes(SQL53_INSPECT_EXPIRES_ENV), false);
  const plan = planPreservingEnvOverlay({
    existingKeys: EXISTING,
    token: TOKEN,
    expiresAt: EXPIRES,
    now: NOW,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.details.preserved_key_count, 49);
  assert.deepEqual(plan.details.preserved_keys, EXISTING);
  assert.deepEqual(plan.details.added_keys, [SQL53_INSPECT_AUTH_ENV, SQL53_INSPECT_EXPIRES_ENV]);
  assert.deepEqual(plan.details.removed_keys, []);
  assert.equal(plan.details.revision_id_cas_required, true);
});

test('env overlay refuses dropped keys, published marker, short token, and over-long expiry', () => {
  assert.equal(planPreservingEnvOverlay({
    existingKeys: EXISTING,
    existingValues: { CHECKSOPS_ENV: 'production-prep' },
    token: TOKEN,
    expiresAt: EXPIRES,
    now: NOW,
  }).code, CODES.UNRELATED_MUTATION);
  assert.equal(planPreservingEnvOverlay({
    existingKeys: [...EXISTING, SQL53_INSPECT_AUTH_ENV],
    token: TOKEN,
    expiresAt: EXPIRES,
    now: NOW,
  }).code, CODES.UNRELATED_MUTATION);
  assert.equal(planPreservingEnvOverlay({
    existingKeys: EXISTING,
    token: SQL53_INSPECT_PUBLISHED_MARKER,
    expiresAt: EXPIRES,
    now: NOW,
  }).code, CODES.INVALID_MANIFEST);
  assert.equal(planPreservingEnvOverlay({
    existingKeys: EXISTING,
    token: 'too-short',
    expiresAt: EXPIRES,
    now: NOW,
  }).code, CODES.INVALID_MANIFEST);
  assert.equal(planPreservingEnvOverlay({
    existingKeys: EXISTING,
    token: TOKEN,
    expiresAt: '2026-10-10T21:31:00.000Z',
    now: NOW,
  }).code, CODES.INVALID_MANIFEST);
});

test('IAM plan is limited to the production prep Lambda', () => {
  const iam = planInspectIam();
  assert.equal(iam.ok, true);
  assert.equal(iam.details.resource, SQL53_INSPECT_FUNCTION_ARN);
  assert.deepEqual(iam.details.actions, [
    'lambda:GetFunction',
    'lambda:GetFunctionConfiguration',
    'lambda:UpdateFunctionConfiguration',
    'lambda:InvokeFunction',
  ]);
  assert.equal(planInspectIam({ functionArn: 'arn:aws:lambda:us-east-1:806168576068:function:checksops-staging-api' }).ok, false);
});

test('invoke payload is exactly two keys and cleanup restores the original 49', () => {
  const invoke = planInspectInvoke({ token: TOKEN });
  assert.equal(invoke.ok, true);
  assert.deepEqual(Object.keys(invoke.details.payload), ['diagnostic', 'authorization']);
  assert.equal(invoke.details.payload.diagnostic, 'sql53-production-readonly-inspect');
  const cleanup = planInspectCleanup({ existingKeys: EXISTING });
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.details.restore_key_count, 49);
  assert.deepEqual(cleanup.details.unset_keys, [SQL53_INSPECT_AUTH_ENV, SQL53_INSPECT_EXPIRES_ENV]);
  assert.equal(cleanup.details.revision_id_cas_required, true);
});

test('official prepare CLI stays evaluate-only and does not print a token', () => {
  const evaluation = evaluateSql53InspectPrepare({
    existingKeys: EXISTING,
    token: TOKEN,
    expiresAt: EXPIRES,
    now: NOW,
  });
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.details.apply, false);
  assert.equal(evaluation.details.execute_authorized, false);
  assert.equal(evaluation.details.live_pin.codeSha256, SQL53_INSPECT_LIVE_PIN.codeSha256);
  assert.equal(evaluation.details.invoke.function_name, SQL53_INSPECT_FUNCTION);
  assert.equal(JSON.stringify(evaluation).includes(TOKEN), false);

  const blocked = evaluateSql53InspectPrepare({
    existingKeys: EXISTING,
    token: TOKEN,
    expiresAt: EXPIRES,
    apply: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, CODES.GUARD_APPLY_FORBIDDEN);

  const input = path.join(os.tmpdir(), `sql53-inspect-prepare-${process.pid}.json`);
  fs.writeFileSync(input, JSON.stringify({
    existingKeys: EXISTING,
    token: TOKEN,
    expiresAt: EXPIRES,
    now: NOW,
  }));
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/sql53-production-inspect-prepare.mjs'),
    '--input',
    input,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.details.apply, false);
  assert.equal(parsed.details.execute_authorized, false);
  assert.equal((result.stdout + result.stderr).includes(TOKEN), false);
  fs.unlinkSync(input);

  const apply = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/sql53-production-inspect-prepare.mjs'),
    '--apply',
    '--input',
    path.join(ROOT, 'ops/deployment-guard/production-sql53-inspect-ready.json'),
  ], { encoding: 'utf8' });
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr || apply.stdout, /evaluate-only|GUARD_APPLY_FORBIDDEN/);
});
