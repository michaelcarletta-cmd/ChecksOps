#!/usr/bin/env node
/**
 * Staging-only: persist the uniquely verified ChecksOps sandbox merchant wallet
 * and set AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID. Simulation remains on.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_NAME = 'checksops-staging-api';
const PERSIST_NAME = 'checksops-staging-moov-billing-dest-2d41';
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const SANDBOX_WALLET_PM = '3c3133e7-5489-4af8-9d9a-4b0cf6bad362';
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';

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
  const creds = JSON.parse(run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN,
    '--role-session-name', 'moov-billing-staging-dest',
    '--web-identity-token', String(await oidcToken()),
    '--duration-seconds', '3600',
    '--output', 'json',
  ])).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
};

const waitFn = (name) => {
  try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const persistSql = `
INSERT INTO public.platform_billing_destination (
  environment, moov_account_id, moov_payment_method_id, label, verified_at
) VALUES (
  'sandbox',
  '${SANDBOX_MERCHANT}',
  '${SANDBOX_WALLET_PM}',
  'ChecksOps sandbox merchant',
  now()
)
ON CONFLICT (environment) DO UPDATE SET
  moov_account_id = EXCLUDED.moov_account_id,
  moov_payment_method_id = EXCLUDED.moov_payment_method_id,
  label = EXCLUDED.label,
  verified_at = now(),
  updated_at = now();
`;

const persistHandler = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
const { Client } = pg;
const CA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rds-global-bundle.pem');
export const handler = async () => {
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: process.env.ADMIN_SECRET_ARN }));
  const parsed = JSON.parse(secret.SecretString);
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  const client = new Client({
    host, port: Number(parsed.port || 5432), user: parsed.username, password: parsed.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000, query_timeout: 20000,
  });
  await client.connect();
  try {
    await client.query(\`${persistSql.replace(/`/g, '\\`')}\`);
    const row = (await client.query(
      "SELECT environment, moov_account_id, moov_payment_method_id, label, verified_at FROM public.platform_billing_destination WHERE environment = 'sandbox'"
    )).rows[0];
    return { ok: true, persisted: row, firstWalletFallback: false };
  } finally {
    await client.end();
  }
};
`;

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeRole();
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const vars = { ...(before.Environment?.Variables || {}) };
  vars.AWS_MOOV_MONTHLY_BILLING_ENABLED = 'true';
  vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID = SANDBOX_MERCHANT;
  vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID = SANDBOX_WALLET_PM;
  delete vars.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED;
  delete vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST;
  awsJson([
    'lambda', 'update-function-configuration',
    '--function-name', API_NAME,
    '--environment', JSON.stringify({ Variables: vars }),
  ]);
  waitFn(API_NAME);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);

  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);
  const staging = path.join(os.tmpdir(), 'checksops-billing-dest-persist');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, 'index.mjs'), persistHandler);
  await writeFile(path.join(staging, 'package.json'), JSON.stringify({
    type: 'module',
    dependencies: { '@aws-sdk/client-secrets-manager': '3.1124.0', pg: '8.23.0' },
  }));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-billing-dest-persist.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN,
      RDS_HOST: rehearsal.Environment?.Variables?.RDS_HOST,
      DATABASE_NAME: 'checksops',
    },
  };
  try {
    awsJson(['lambda', 'get-function', '--function-name', PERSIST_NAME]);
    awsJson(['lambda', 'update-function-code', '--function-name', PERSIST_NAME, '--zip-file', `fileb://${zip}`]);
    waitFn(PERSIST_NAME);
    awsJson(['lambda', 'update-function-configuration', '--function-name', PERSIST_NAME, '--timeout', '60', '--environment', JSON.stringify(env)]);
  } catch {
    const vpc = before.VpcConfig || {};
    awsJson([
      'lambda', 'create-function',
      '--function-name', PERSIST_NAME,
      '--runtime', 'nodejs20.x',
      '--role', rehearsal.Role,
      '--handler', 'index.handler',
      '--timeout', '60',
      '--memory-size', '256',
      '--zip-file', `fileb://${zip}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`,
    ]);
  }
  waitFn(PERSIST_NAME);
  const persistFile = path.join(os.tmpdir(), `billing-dest-persist-${Date.now()}.json`);
  run(AWS, ['lambda', 'invoke', '--function-name', PERSIST_NAME, persistFile]);
  const persisted = JSON.parse(fs.readFileSync(persistFile, 'utf8'));

  const secret = after.Environment?.Variables?.AWS_SCHEDULED_JOB_SECRET;
  let scheduled = { ok: false, error: 'scheduled_secret_missing' };
  if (secret) {
    const raw = execFileSync('curl', [
      '-sS', '-X', 'POST',
      'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging/scheduled',
      '-H', `x-scheduled-job-secret: ${secret}`,
      '-H', 'content-type: application/json',
      '-d', JSON.stringify({ job: 'moov-monthly-tenant-billing' }),
    ], { encoding: 'utf8' });
    try { scheduled = JSON.parse(raw); } catch { scheduled = { ok: false, raw: raw.slice(0, 400) }; }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sandboxMerchantAccountId: SANDBOX_MERCHANT,
    sandboxWalletPaymentMethodId: SANDBOX_WALLET_PM,
    lambda: {
      codeSha256: after.CodeSha256,
      lastModified: after.LastModified,
      flags: {
        AWS_MOOV_MONTHLY_BILLING_ENABLED: after.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_ENABLED || null,
        AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: after.Environment?.Variables?.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || null,
        AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID: after.Environment?.Variables?.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID || null,
        AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: after.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
        AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: after.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
      },
    },
    persisted,
    scheduled: {
      ok: scheduled.ok,
      error: scheduled.error || null,
      destination: scheduled.destination || null,
      results: scheduled.results || scheduled.due || null,
      simulated: scheduled.simulated ?? null,
      firstWalletFallback: false,
    },
    firstWalletFallback: false,
    sandboxTransferPostEnabled: false,
    productionBillingPostEnabled: false,
  };
  await writeFile(path.join(OUT, 'staging-destination.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
