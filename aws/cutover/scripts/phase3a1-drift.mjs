#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const FN = 'checksops-production-prep-api';
const ARTIFACTS = '/opt/cursor/artifacts';
const FLAG_KEYS = [
  'AWS_PROVIDER_EXECUTION_ENABLED', 'AWS_MOOV_ENABLED', 'AWS_CHECKALT_ENABLED',
  'AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED', 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
  'AWS_PROVIDER_WEBHOOK_DRY_RUN', 'PROVIDER_SECRETS_ARN',
];

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}));

const waitReady = () => {
  for (let i = 0; i < 30; i += 1) {
    const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', FN]);
    if (cfg.LastUpdateStatus === 'Successful') return cfg;
    if (cfg.LastUpdateStatus === 'Failed') throw new Error('lambda_update_failed');
    execFileSync('sleep', ['2']);
  }
  throw new Error('lambda_update_timeout');
};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const apiDir = path.join(root, 'aws/functions/api');
const zipPath = path.join(ARTIFACTS, 'checksops-production-prep-api-phase3a1.zip');
fs.mkdirSync(ARTIFACTS, { recursive: true });
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
const zip = spawnSync('zip', ['-rq', zipPath, '.', '-x', '*.test.mjs', '-x', 'coverage/*'], { cwd: apiDir });
if (zip.status !== 0) throw new Error('zip_failed');

const before = awsJson(['lambda', 'get-function-configuration', '--function-name', FN]);
awsJson(['lambda', 'update-function-code', '--function-name', FN, '--zip-file', `fileb://${zipPath}`]);
const after = waitReady();
const flags = Object.fromEntries(FLAG_KEYS.map((key) => [key, (after.Environment?.Variables || {})[key] ?? null]));

const payloadPath = path.join(ARTIFACTS, 'phase3a1-drift-payload.json');
const outPath = path.join(ARTIFACTS, 'phase3a1-drift-out.json');
fs.writeFileSync(payloadPath, JSON.stringify({ phase3a1Drift: true }));
execFileSync(AWS, [
  '--region', REGION, 'lambda', 'invoke',
  '--function-name', FN,
  '--cli-binary-format', 'raw-in-base64-out',
  '--payload', `fileb://${payloadPath}`,
  outPath,
], { stdio: ['ignore', 'pipe', 'pipe'] });
const raw = JSON.parse(fs.readFileSync(outPath, 'utf8'));
const body = raw?.body ? JSON.parse(raw.body) : raw;
const report = {
  beforeSha: before.CodeSha256,
  afterSha: after.CodeSha256,
  flagsUnchanged: FLAG_KEYS.every((key) => (before.Environment?.Variables || {})[key] === (after.Environment?.Variables || {})[key]),
  flags,
  providerSecretsArnSet: Boolean((after.Environment?.Variables || {}).PROVIDER_SECRETS_ARN),
  statusCode: raw.statusCode || 200,
  summary: body.summary || null,
  sql65: body.sql65 || null,
  additional: (body.rows || []).filter((row) => row.referencePresent !== true),
  referencedCount: (body.rows || []).filter((row) => row.referencePresent === true).length,
  rows: body.rows || [],
  issues: body.issues || [],
};
fs.writeFileSync(path.join(ARTIFACTS, 'phase3a1-drift.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
