#!/usr/bin/env node
/**
 * Apply the production frontend bucket lock policy.
 * Does not upload SPA files. Does not change CloudFront.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_SPA_LOCK } from './production-spa-lock.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = path.join(ROOT, 'aws/production/production-frontend-bucket-lock-policy.json');
const APPLY = process.argv.includes('--apply');
const AWS = process.env.AWS_CLI || 'aws';
const bucket = PRODUCTION_SPA_LOCK.knownGood.s3Bucket;

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    applied: false,
    bucket,
    policy: POLICY,
    hint: 'Re-run with --apply to attach the Deny-except-ChecksOpsProductionSpaDeploy policy.',
  }, null, 2));
  process.exit(0);
}

const result = spawnSync(AWS, [
  's3api',
  'put-bucket-policy',
  '--bucket',
  bucket,
  '--policy',
  `file://${POLICY}`,
], { encoding: 'utf8' });
if (result.status !== 0) {
  console.error(JSON.stringify({
    error: 'production_frontend_bucket_policy_apply_failed',
    status: result.status,
    stderr: (result.stderr || '').slice(-2000),
  }, null, 2));
  process.exit(result.status || 1);
}

const got = spawnSync(AWS, ['s3api', 'get-bucket-policy', '--bucket', bucket, '--output', 'json'], { encoding: 'utf8' });
const policy = got.status === 0 ? JSON.parse(JSON.parse(got.stdout).Policy) : null;
console.log(JSON.stringify({
  ok: true,
  applied: true,
  bucket,
  sids: (policy?.Statement || []).map((row) => row.Sid),
}, null, 2));
