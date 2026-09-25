#!/usr/bin/env node
/**
 * Staging overlay + SQL 47 apply + simulated verification acceptance.
 * Does not enable sandbox/production transfer-post. Does not touch production.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const API_NAME = 'checksops-staging-api';
const ONESHOT = 'checksops-staging-billing-verification-2d41';
const OUT = '/opt/cursor/artifacts/billing-verification-v2';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};
const awsTry = (args) => {
  try { return { ok: true, data: awsJson(args) }; }
  catch (error) {
    return { ok: false, error: String(error.stderr || error.message || error).replace(/\s+/g, ' ').trim().slice(0, 500) };
  }
};
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const overlayApi = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-verify-overlay-'));
  const zipIn = path.join(tmp, 'live.zip');
  const unpacked = path.join(tmp, 'pkg');
  const loc = awsJson(['lambda', 'get-function', '--function-name', API_NAME]);
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  fs.mkdirSync(unpacked, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', unpacked]);
  const copies = [
    'tenant-billing-engine.mjs',
    'tenant-billing-handlers.mjs',
    'tenant-billing-destination.mjs',
  ];
  for (const rel of copies) {
    fs.copyFileSync(path.join(ROOT, 'aws/functions/api', rel), path.join(unpacked, rel));
  }
  const zipOut = path.join(tmp, 'overlay.zip');
  execFileSync('zip', ['-qr', zipOut, '.'], { cwd: unpacked });
  awsJson(['lambda', 'update-function-code', '--function-name', API_NAME, '--zip-file', `fileb://${zipOut}`]);
  waitFn(API_NAME);
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const vars = { ...(before.Environment?.Variables || {}) };
  vars.AWS_MOOV_MONTHLY_BILLING_ENABLED = vars.AWS_MOOV_MONTHLY_BILLING_ENABLED || 'true';
  delete vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED;
  delete vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST;
  awsJson([
    'lambda', 'update-function-configuration',
    '--function-name', API_NAME,
    '--environment', JSON.stringify({ Variables: vars }),
  ]);
  waitFn(API_NAME);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  return {
    codeSha256: after.CodeSha256,
    lastModified: after.LastModified,
    flags: {
      AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: after.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
      AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: after.Environment?.Variables?.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: after.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    },
  };
};

const invokeOneshot = async () => {
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const staging = path.join(os.tmpdir(), 'checksops-verify-oneshot-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/billing-verification-staging/index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/billing-verification-staging/package.json'), path.join(staging, 'package.json'));
  await copyFile(path.join(ROOT, 'aws/rls/sql/47_billing_verification_occurrence.sql'), path.join(staging, '47_billing_verification_occurrence.sql'));
  await copyFile(path.join(ROOT, 'aws/functions/api/tenant-billing-engine.mjs'), path.join(staging, 'tenant-billing-engine.mjs'));
  await copyFile(path.join(ROOT, 'aws/functions/api/tenant-billing-destination.mjs'), path.join(staging, 'tenant-billing-destination.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-verify-oneshot.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN,
      RDS_HOST: rehearsal.Environment?.Variables?.RDS_HOST || 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
      AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: 'false',
    },
  };
  const vpc = api.VpcConfig || {};
  const existing = awsTry(['lambda', 'get-function', '--function-name', ONESHOT]);
  if (existing.ok) {
    awsJson(['lambda', 'update-function-code', '--function-name', ONESHOT, '--zip-file', `fileb://${zip}`]);
    waitFn(ONESHOT);
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT, '--timeout', '90', '--environment', JSON.stringify(env)]);
  } else {
    awsJson([
      'lambda', 'create-function',
      '--function-name', ONESHOT,
      '--runtime', 'nodejs20.x',
      '--role', rehearsal.Role,
      '--handler', 'index.handler',
      '--timeout', '90',
      '--memory-size', '256',
      '--zip-file', `fileb://${zip}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`,
    ]);
  }
  waitFn(ONESHOT);
  const outFile = path.join(os.tmpdir(), `verify-staging-${Date.now()}.json`);
  awsJson(['lambda', 'invoke', '--function-name', ONESHOT, '--cli-binary-format', 'raw-in-base64-out', outFile]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('billing-verification-staging');
  const baseline = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const accept = await invokeOneshot();
  if (accept.ok !== true) {
    const report = {
      generatedAt: new Date().toISOString(),
      staging: true,
      productionTouched: false,
      baseline: { codeSha256: baseline.CodeSha256, lastModified: baseline.LastModified },
      accept,
      overlay: null,
    };
    await writeFile(path.join(OUT, 'staging-acceptance.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }
  const overlay = overlayApi();
  const report = {
    generatedAt: new Date().toISOString(),
    staging: true,
    productionTouched: false,
    baseline: { codeSha256: baseline.CodeSha256, lastModified: baseline.LastModified },
    overlay,
    accept,
  };
  await writeFile(path.join(OUT, 'staging-acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
