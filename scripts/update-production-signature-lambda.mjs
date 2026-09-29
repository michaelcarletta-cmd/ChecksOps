#!/usr/bin/env node
/**
 * Update production-prep-api code from the surgical overlay zip.
 * Refuses if live CodeSha256 drifted. Does not change configuration.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const NAME = 'checksops-production-prep-api';
const ZIP = process.env.CHECKSOPS_PROD_LAMBDA_ZIP || '/tmp/prod-lambda-signature-overlay.zip';
const EXPECTED = '9OLR9DMhuDrAUp5/TmT6+8bfQC2I6USFk+zwFkluJLQ=';
const FLAG_KEYS = [
  'AWS_MOOV_ENABLED',
  'AWS_CHECKALT_ENABLED',
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
  'AWS_MOOV_TRANSFER_POST_ENABLED',
  'AWS_WRITES_ENABLED',
  'AWS_STORAGE_WRITES_ENABLED',
  'AWS_CHECK_WORKFLOW_WRITES_ENABLED',
  'SIGN_BASE_URL',
  'CHECKSOPS_ENV',
];

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

if (!fs.existsSync(ZIP)) throw new Error(`missing overlay zip ${ZIP}`);

const before = awsJson(['lambda', 'get-function-configuration', '--function-name', NAME]);
const beforeFlags = Object.fromEntries(FLAG_KEYS.map((key) => [key, before.Environment?.Variables?.[key] ?? null]));
if (before.CodeSha256 !== EXPECTED) {
  console.log(JSON.stringify({ stop: true, reason: 'code_sha_drift', live: before.CodeSha256, expected: EXPECTED }, null, 2));
  process.exit(3);
}

const updated = awsJson([
  'lambda', 'update-function-code',
  '--function-name', NAME,
  '--zip-file', `fileb://${ZIP}`,
]);
try {
  execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', NAME], { encoding: 'utf8' });
} catch { /* describe below */ }
const after = awsJson(['lambda', 'get-function-configuration', '--function-name', NAME]);
const afterFlags = Object.fromEntries(FLAG_KEYS.map((key) => [key, after.Environment?.Variables?.[key] ?? null]));
const configUnchanged = (
  before.Role === after.Role
  && before.Runtime === after.Runtime
  && before.MemorySize === after.MemorySize
  && before.Timeout === after.Timeout
  && JSON.stringify(before.VpcConfig?.SubnetIds) === JSON.stringify(after.VpcConfig?.SubnetIds)
  && JSON.stringify(beforeFlags) === JSON.stringify(afterFlags)
);
const report = {
  ok: Boolean(updated.CodeSha256 && updated.CodeSha256 !== EXPECTED && configUnchanged && after.LastUpdateStatus === 'Successful'),
  before_sha: before.CodeSha256,
  after_sha: after.CodeSha256,
  last_modified: after.LastModified,
  last_update_status: after.LastUpdateStatus,
  config_unchanged: configUnchanged,
  flags_before: beforeFlags,
  flags_after: afterFlags,
  role: after.Role,
  runtime: after.Runtime,
  memory: after.MemorySize,
  timeout: after.Timeout,
};
fs.writeFileSync('/opt/cursor/artifacts/prod-lambda-update.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(2);
