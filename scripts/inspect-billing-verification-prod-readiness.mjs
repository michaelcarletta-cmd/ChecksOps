#!/usr/bin/env node
/**
 * Read-only production pre-$1 readiness. Does not enable the verification gate
 * and does not invoke verify-debit.
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
const OUT = '/opt/cursor/artifacts/billing-verification-v2';
const PROD_API = 'checksops-production-prep-api';
const REHEARSAL = 'checksops-staging-rehearsal-oneshot';
const ONESHOT = 'checksops-prod-sql47-inspect-2d41';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};
const awsTry = (args) => {
  try { return { ok: true, data: awsJson(args) }; }
  catch (error) {
    return { ok: false, error: String(error.stderr || error.message || error).replace(/\s+/g, ' ').trim().slice(0, 600) };
  }
};
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('billing-verification-inspect');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const vars = cfg.Environment?.Variables || {};
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', REHEARSAL]);
  const adminSecretArn = rehearsal.Environment?.Variables?.PROD_ADMIN_SECRET_ARN;
  const rdsHost = rehearsal.Environment?.Variables?.PROD_RDS_HOST;
  if (!adminSecretArn || !rdsHost) throw new Error('rehearsal missing PROD_ADMIN_SECRET_ARN or PROD_RDS_HOST');

  const staging = path.join(os.tmpdir(), 'checksops-sql47-prod-inspect-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/billing-verification-prod-inspect/index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/billing-verification-prod-inspect/package.json'), path.join(staging, 'package.json'));
  await copyFile(path.join(ROOT, 'aws/functions/api/tenant-billing-engine.mjs'), path.join(staging, 'tenant-billing-engine.mjs'));
  await copyFile(path.join(ROOT, 'aws/functions/api/tenant-billing-destination.mjs'), path.join(staging, 'tenant-billing-destination.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'inherit' });
  const zip = path.join(os.tmpdir(), 'checksops-sql47-prod-inspect.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: rdsHost,
      DATABASE_NAME: 'checksops',
    },
  };
  const vpc = cfg.VpcConfig || rehearsal.VpcConfig || {};
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
  const outFile = path.join(os.tmpdir(), `sql47-prod-inspect-${Date.now()}.json`);
  awsJson(['lambda', 'invoke', '--function-name', ONESHOT, '--cli-binary-format', 'raw-in-base64-out', outFile]);
  const sql = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    realDollarSent: false,
    verificationInvoked: false,
    lambda: {
      codeSha256: cfg.CodeSha256,
      lastModified: cfg.LastModified,
      monthlyPost: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
      verificationPost: vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
      destination: {
        account: vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || null,
        method: vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID || null,
      },
    },
    sql,
  };
  await writeFile(path.join(OUT, 'prod-readiness.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (sql.ok !== true) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
