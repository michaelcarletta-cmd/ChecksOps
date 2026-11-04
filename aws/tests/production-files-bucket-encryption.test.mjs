/**
 * The production files bucket encryption change (ops/production-files-bucket-encryption.md): the
 * after state differs from the recorded live state only in BucketKeyEnabled (true -> false), keeps
 * SSE-S3 default encryption and the SSE-C block, and the key policy still scopes the API role to
 * object ARNs under files/verification-docs/ (which a Bucket Key context can never match). Static.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const BEFORE = JSON.parse(read('ops/production-files-bucket-encryption/before-2026-11-04.json'));
const AFTER = JSON.parse(read('ops/production-files-bucket-encryption/after.json'));
const KEYS = read('aws/production/onboarding-keys.yaml');
const RUNBOOK = read('ops/production-files-bucket-encryption.md');

test('1 the before state is the live Bucket Key setting', () => {
  assert.equal(BEFORE.Rules.length, 1);
  assert.equal(BEFORE.Rules[0].BucketKeyEnabled, true);
});

test('2 the after state only turns Bucket Keys off; SSE-S3 default and the SSE-C block stay', () => {
  const { BucketKeyEnabled: b, ...restBefore } = BEFORE.Rules[0];
  const { BucketKeyEnabled: a, ...restAfter } = AFTER.Rules[0];
  assert.equal(b, true);
  assert.equal(a, false);
  assert.deepEqual(restAfter, restBefore);
  assert.equal(AFTER.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
  assert.deepEqual(AFTER.Rules[0].BlockedEncryptionTypes.EncryptionType, ['SSE-C']);
});

test('3 the key policy scopes the API role to object ARNs under files/verification-docs/', () => {
  assert.match(KEYS, /kms:EncryptionContext:aws:s3:arn/);
  assert.match(KEYS, /files\/verification-docs\/\*/);
});

test('4 the runbook checks the live state before and after and stops on the first failure', () => {
  assert.match(RUNBOOK, /bash -euo pipefail -c/);
  assert.match(RUNBOOK, /before-2026-11-04\.json\)\necho "LIVE MATCHES BEFORE"/);
  assert.match(RUNBOOK, /--server-side-encryption-configuration file:\/\/ops\/production-files-bucket-encryption\/after\.json/);
  assert.match(RUNBOOK, /after\.json\)\necho "LIVE MATCHES AFTER"/);
  assert.match(RUNBOOK, /e5882379-206a-43f2-ad6d-f691dd772f77/);
});
