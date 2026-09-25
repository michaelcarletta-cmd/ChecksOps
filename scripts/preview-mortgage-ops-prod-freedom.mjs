#!/usr/bin/env node
/**
 * Read-only production Freedom September preview via persist:false engine.
 * Does not Pull Now, post ACH, or mutate production records.
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
const OUT = '/opt/cursor/artifacts/mortgage-ops-prod-safe';
const PROD_API = 'checksops-production-prep-api';
const REHEARSAL = 'checksops-staging-rehearsal-oneshot';
const ONESHOT = 'checksops-prod-mortgage-ops-preview-2d41';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};
const awsTry = (args) => {
  try {
    return { ok: true, data: awsJson(args) };
  } catch (error) {
    const text = String(error.stderr || error.stdout || error.message || error);
    return { ok: false, error: text.replace(/\s+/g, ' ').trim().slice(0, 600) };
  }
};
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('mortgage-ops-prod-preview');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  if ((cfg.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST) !== 'false') {
    throw new Error('PRODUCTION_POST is not false; refusing preview');
  }
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', REHEARSAL]);
  const adminSecretArn = rehearsal.Environment?.Variables?.PROD_ADMIN_SECRET_ARN;
  const rdsHost = rehearsal.Environment?.Variables?.PROD_RDS_HOST;
  const staging = path.join(os.tmpdir(), 'checksops-mortgage-ops-prod-preview-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/mortgage-ops-prod-preview/index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/mortgage-ops-prod-preview/package.json'), path.join(staging, 'package.json'));
  await copyFile(path.join(ROOT, 'aws/functions/api/tenant-billing-engine.mjs'), path.join(staging, 'tenant-billing-engine.mjs'));
  await copyFile(path.join(ROOT, 'aws/functions/api/tenant-billing-destination.mjs'), path.join(staging, 'tenant-billing-destination.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-mortgage-ops-prod-preview.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: rdsHost,
      DATABASE_NAME: 'checksops',
      AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: 'false',
    },
  };
  const vpc = cfg.VpcConfig || rehearsal.VpcConfig || {};
  const existing = awsTry(['lambda', 'get-function', '--function-name', ONESHOT]);
  if (existing.ok) {
    awsJson(['lambda', 'update-function-code', '--function-name', ONESHOT, '--zip-file', `fileb://${zip}`]);
    waitFn(ONESHOT);
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT, '--timeout', '90', '--memory-size', '512', '--environment', JSON.stringify(env)]);
  } else {
    const created = awsTry([
      'lambda', 'create-function',
      '--function-name', ONESHOT,
      '--runtime', 'nodejs20.x',
      '--role', rehearsal.Role,
      '--handler', 'index.handler',
      '--timeout', '90',
      '--memory-size', '512',
      '--zip-file', `fileb://${zip}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`,
    ]);
    if (!created.ok) throw new Error(created.error);
  }
  waitFn(ONESHOT);
  const outFile = path.join(os.tmpdir(), `mortgage-ops-prod-preview-${Date.now()}.json`);
  awsJson(['lambda', 'invoke', '--function-name', ONESHOT, '--cli-binary-format', 'raw-in-base64-out', outFile]);
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  await writeFile(path.join(OUT, 'freedom-preview.json'), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  if (payload.ok !== true) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
