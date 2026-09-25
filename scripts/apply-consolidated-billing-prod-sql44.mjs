#!/usr/bin/env node
/**
 * Phase 3A Step 7: apply SQL 44 to production RDS only.
 * Does not UpdateFunctionCode, change env, create EventBridge, or post ACH.
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
const OUT = '/opt/cursor/artifacts/consolidated-billing-prod-safe';
const PROD_API = 'checksops-production-prep-api';
const REHEARSAL = 'checksops-staging-rehearsal-oneshot';
const ONESHOT = 'checksops-prod-sql44-apply-2d41';
const EXPECTED_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const EXPECTED_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';

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
  await assumeCursorRole('phase3a-sql44-apply');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const vars = cfg.Environment?.Variables || {};
  if (vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false') {
    throw new Error('PRODUCTION_POST is not false; refusing SQL apply');
  }
  if (vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID !== EXPECTED_ACCOUNT
    || vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID !== EXPECTED_METHOD) {
    throw new Error('production destination mismatch; refusing SQL apply');
  }

  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', REHEARSAL]);
  const adminSecretArn = rehearsal.Environment?.Variables?.PROD_ADMIN_SECRET_ARN;
  const rdsHost = rehearsal.Environment?.Variables?.PROD_RDS_HOST;
  if (!adminSecretArn || !rdsHost) throw new Error('rehearsal missing PROD_ADMIN_SECRET_ARN or PROD_RDS_HOST');
  if (!/checksops-production/i.test(adminSecretArn) || !/checksops-production/i.test(rdsHost)) {
    throw new Error('rehearsal PROD_* does not point at production');
  }

  const staging = path.join(os.tmpdir(), 'checksops-sql44-prod-apply-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/consolidated-billing-prod-apply/index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/consolidated-billing-prod-apply/package.json'), path.join(staging, 'package.json'));
  await copyFile(path.join(ROOT, 'aws/rls/sql/44_consolidated_monthly_tenant_billing.sql'), path.join(staging, '44_consolidated_monthly_tenant_billing.sql'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'inherit' });
  const zip = path.join(os.tmpdir(), 'checksops-sql44-prod-apply.zip');
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
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT, '--timeout', '120', '--environment', JSON.stringify(env)]);
  } else {
    const created = awsTry([
      'lambda', 'create-function',
      '--function-name', ONESHOT,
      '--runtime', 'nodejs20.x',
      '--role', rehearsal.Role,
      '--handler', 'index.handler',
      '--timeout', '120',
      '--memory-size', '256',
      '--zip-file', `fileb://${zip}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`,
    ]);
    if (!created.ok) throw new Error(created.error || 'create-function failed');
  }
  waitFn(ONESHOT);
  const outFile = path.join(os.tmpdir(), `sql44-prod-apply-${Date.now()}.json`);
  const invoked = awsTry(['lambda', 'invoke', '--function-name', ONESHOT, '--cli-binary-format', 'raw-in-base64-out', outFile]);
  if (!invoked.ok) throw new Error(invoked.error || 'invoke failed');
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  await writeFile(path.join(OUT, 'phase3a-sql44-apply.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    oneshot: ONESHOT,
    productionLambdaUntouchedSha: cfg.CodeSha256,
    productionPost: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST,
    payload,
  }, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  if (!payload.ok) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
