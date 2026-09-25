#!/usr/bin/env node
/**
 * Staging-only overlay for monthly tenant billing.
 * Does not SAM-deploy. Does not enable sandbox/production transfer-post.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_NAME = 'checksops-staging-api';
const ONESHOT_NAME = 'checksops-staging-moov-billing-2d41';
const ROLE_NAME = 'checksops-staging-rehearsal-oneshot';
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const OUT = '/opt/cursor/artifacts/moov-monthly-billing';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};

const oidcToken = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/run/cursor/api.sock',
    path: '/v1/tokens/oidc',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed.token || parsed.oidcToken || parsed);
      } catch (error) { reject(error); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const assumeRole = async () => {
  const role = process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
  if (!role) throw new Error('CURSOR_AWS_ASSUME_IAM_ROLE_ARN missing');
  const token = await oidcToken();
  const out = run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'moov-monthly-billing-staging',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
    '--output', 'json',
  ]);
  const creds = JSON.parse(out).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
};

const waitFn = (name) => {
  try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const overlayApi = async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-billing-overlay-'));
  const zipIn = path.join(tmp, 'live.zip');
  const unpacked = path.join(tmp, 'pkg');
  const loc = awsJson(['lambda', 'get-function', '--function-name', API_NAME]);
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  fs.mkdirSync(unpacked, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', unpacked]);
  const copies = [
    ['aws/functions/api/tenant-billing-destination.mjs', 'tenant-billing-destination.mjs'],
    ['aws/functions/api/tenant-billing-engine.mjs', 'tenant-billing-engine.mjs'],
    ['aws/functions/api/tenant-billing-handlers.mjs', 'tenant-billing-handlers.mjs'],
    ['aws/functions/api/allowed-tables.json', 'allowed-tables.json'],
    ['aws/functions/api/app-services.mjs', 'app-services.mjs'],
    ['aws/functions/api/scheduled.mjs', 'scheduled.mjs'],
    ['aws/functions/api/providers/webhook-apply.mjs', 'providers/webhook-apply.mjs'],
    ['aws/functions/api/providers/parity/moov-money.mjs', 'providers/parity/moov-money.mjs'],
    ['aws/functions/api/providers/parity/moov-onboard.mjs', 'providers/parity/moov-onboard.mjs'],
    ['aws/functions/api/providers/parity/moov-functions.mjs', 'providers/parity/moov-functions.mjs'],
    ['aws/functions/api/providers/parity/moov-rails.mjs', 'providers/parity/moov-rails.mjs'],
  ];
  const placed = [];
  for (const [src, dest] of copies) {
    const target = path.join(unpacked, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, src), target);
    placed.push(dest);
  }
  const zipOut = path.join(tmp, 'overlay.zip');
  execFileSync('zip', ['-qr', zipOut, '.'], { cwd: unpacked });
  awsJson(['lambda', 'update-function-code', '--function-name', API_NAME, '--zip-file', `fileb://${zipOut}`]);
  waitFn(API_NAME);

  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const vars = { ...(before.Environment?.Variables || {}) };
  vars.AWS_MOOV_MONTHLY_BILLING_ENABLED = 'true';
  vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID = SANDBOX_MERCHANT;
  if (!vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID) {
    vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID = '3c3133e7-5489-4af8-9d9a-4b0cf6bad362';
  }
  delete vars.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED;
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
    placed,
    flags: {
      AWS_MOOV_MONTHLY_BILLING_ENABLED: after.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_ENABLED || null,
      AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: after.Environment?.Variables?.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || null,
      AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID: after.Environment?.Variables?.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: after.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: after.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
    },
  };
};

const applySql = async () => {
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const adminSecretArn = rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN;
  const rdsHost = rehearsal.Environment?.Variables?.RDS_HOST || 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
  const vpc = api.VpcConfig || {};
  const staging = path.join(os.tmpdir(), 'checksops-moov-billing-oneshot-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/moov-monthly-billing/index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/moov-monthly-billing/package.json'), path.join(staging, 'package.json'));
  await copyFile(path.join(ROOT, 'aws/rls/sql/43_moov_monthly_tenant_billing.sql'), path.join(staging, '43_moov_monthly_tenant_billing.sql'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-moov-billing-oneshot.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: rdsHost,
      DATABASE_NAME: 'checksops',
      AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: SANDBOX_MERCHANT,
      PROVIDER_SECRETS_ARN: api.Environment?.Variables?.PROVIDER_SECRETS_ARN || '',
    },
  };
  const vpcConfig = `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`;
  const roleArn = rehearsal.Role || `arn:aws:iam::806168576068:role/${ROLE_NAME}`;
  try {
    awsJson(['lambda', 'get-function', '--function-name', ONESHOT_NAME]);
    execFileSync(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', ONESHOT_NAME, '--zip-file', `fileb://${zip}`], { stdio: 'ignore' });
    waitFn(ONESHOT_NAME);
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT_NAME, '--timeout', '120', '--environment', JSON.stringify(env)]);
  } catch {
    awsJson([
      'lambda', 'create-function',
      '--function-name', ONESHOT_NAME,
      '--runtime', 'nodejs20.x',
      '--role', roleArn,
      '--handler', 'index.handler',
      '--timeout', '120',
      '--memory-size', '512',
      '--zip-file', `fileb://${zip}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', vpcConfig,
    ]);
  }
  waitFn(ONESHOT_NAME);
  const outFile = path.join(os.tmpdir(), `moov-billing-oneshot-${Date.now()}.json`);
  run(AWS, ['lambda', 'invoke', '--function-name', ONESHOT_NAME, outFile]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const invokeScheduler = async () => {
  const secret = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME])
    .Environment?.Variables?.AWS_SCHEDULED_JOB_SECRET;
  if (!secret) return { ok: false, error: 'scheduled_secret_missing' };
  const apiId = 'psr19uhop4';
  const url = `https://${apiId}.execute-api.us-east-1.amazonaws.com/staging/scheduled`;
  try {
    const raw = execFileSync('curl', [
      '-sS', '-X', 'POST', url,
      '-H', `x-scheduled-job-secret: ${secret}`,
      '-H', 'content-type: application/json',
      '-d', JSON.stringify({ job: 'moov-monthly-tenant-billing' }),
    ], { encoding: 'utf8' });
    return JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 300) };
  }
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeRole();
  const sql = await applySql();
  const overlay = await overlayApi();
  if (sql?.persisted?.moov_payment_method_id) {
    const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
    const vars = { ...(cfg.Environment?.Variables || {}) };
    vars.AWS_MOOV_MONTHLY_BILLING_ENABLED = 'true';
    vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID = SANDBOX_MERCHANT;
    vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID = sql.persisted.moov_payment_method_id;
    delete vars.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED;
    delete vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST;
    awsJson(['lambda', 'update-function-configuration', '--function-name', API_NAME, '--environment', JSON.stringify({ Variables: vars })]);
    waitFn(API_NAME);
    overlay.flags.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID = sql.persisted.moov_payment_method_id;
  }
  const scheduled = await invokeScheduler();
  const report = {
    generatedAt: new Date().toISOString(),
    productionRecordsMutated: false,
    liveDebitCreated: false,
    sandboxTransferPostEnabled: false,
    productionBillingPostEnabled: false,
    sql,
    overlay,
    scheduled: {
      ok: scheduled.ok,
      error: scheduled.error || null,
      period: scheduled.period || null,
      due: scheduled.due,
      resultCount: Array.isArray(scheduled.results) ? scheduled.results.length : 0,
    },
  };
  await writeFile(path.join(OUT, 'staging-deploy.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
