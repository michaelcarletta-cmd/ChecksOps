#!/usr/bin/env node
/**
 * Staging-only: apply the leftover occurrence SELECT policy, invoke
 * moov-monthly-tenant-billing twice, and prove other financial jobs stay
 * disabled. Does not create EventBridge rules or touch production.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const API_NAME = 'checksops-staging-api';
const ONESHOT = 'checksops-staging-moov-billing-tenant-2d41';
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';
const SYNTHETIC = '1ca29fed-4b71-44ce-9650-54b7215f5c3a';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OCCURRENCE = '0c22fa27-5f34-45c6-9208-238bb06b28a0';
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const SANDBOX_WALLET_PM = '3c3133e7-5489-4af8-9d9a-4b0cf6bad362';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', 'us-east-1', '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const policyHandler = () => `import fs from 'node:fs';
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
    await client.query('SET default_transaction_read_only = off');
    await client.query(\`DROP POLICY IF EXISTS aws_select_tenant_maintenance_payments_job ON public.tenant_maintenance_payments\`);
    await client.query(\`
      CREATE POLICY aws_select_tenant_maintenance_payments_job ON public.tenant_maintenance_payments
        FOR SELECT TO checksops
        USING (public.aws_monthly_billing_job())
    \`);
    await client.query(\`
      UPDATE public.tenant_billing_settings
         SET next_period_start = NULL, updated_at = now()
       WHERE tenant_id = $1::uuid
    \`, ['${SYNTHETIC}']);
    const settings = (await client.query(
      'SELECT tenant_id, billing_enabled, billing_day_of_month, next_period_start FROM public.tenant_billing_settings WHERE tenant_id = $1::uuid',
      ['${SYNTHETIC}']
    )).rows[0];
    const occurrences = (await client.query(
      \`SELECT id, billing_period, status, idempotence_key, provider_transfer_id, destination_account_id
         FROM public.tenant_maintenance_payments
        WHERE tenant_id = $1::uuid AND billing_period = '2026-09'\`,
      ['${SYNTHETIC}']
    )).rows;
    const dest = (await client.query(
      "SELECT environment, moov_account_id, moov_payment_method_id FROM public.platform_billing_destination WHERE environment = 'sandbox'"
    )).rows[0] || null;
    return {
      ok: true,
      settings,
      occurrences,
      dest,
      synthetic: true,
      neverProductionDebitSource: true,
    };
  } finally {
    await client.end();
  }
};
`;

const applyPolicy = async () => {
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);
  const apiCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const staging = path.join(os.tmpdir(), 'checksops-billing-scheduler-policy');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, 'index.mjs'), policyHandler());
  await writeFile(path.join(staging, 'package.json'), JSON.stringify({
    type: 'module',
    dependencies: { '@aws-sdk/client-secrets-manager': '3.1124.0', pg: '8.23.0' },
  }));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-billing-scheduler-policy.zip');
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
    awsJson(['lambda', 'get-function', '--function-name', ONESHOT]);
    awsJson(['lambda', 'update-function-code', '--function-name', ONESHOT, '--zip-file', `fileb://${zip}`]);
    waitFn(ONESHOT);
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT, '--timeout', '60', '--environment', JSON.stringify(env)]);
  } catch {
    const vpc = apiCfg.VpcConfig || {};
    awsJson([
      'lambda', 'create-function',
      '--function-name', ONESHOT,
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
  waitFn(ONESHOT);
  const outFile = path.join(os.tmpdir(), `billing-scheduler-policy-${Date.now()}.json`);
  execFileSync(AWS, ['lambda', 'invoke', '--function-name', ONESHOT, outFile]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const invokeJob = (secret, job) => {
  const raw = execFileSync('curl', [
    '-sS', '-X', 'POST',
    `${API}/scheduled`,
    '-H', `x-scheduled-job-secret: ${secret}`,
    '-H', 'content-type: application/json',
    '-d', JSON.stringify({ job }),
  ], { encoding: 'utf8' });
  try { return JSON.parse(raw); } catch { return { ok: false, raw: raw.slice(0, 400) }; }
};

const summarize = (scheduled) => {
  const results = Array.isArray(scheduled?.results) ? scheduled.results : [];
  const synthetic = results.find((row) => row.tenant_id === SYNTHETIC) || null;
  const freedom = results.find((row) => row.tenant_id === FREEDOM) || null;
  return {
    job: scheduled?.job || null,
    ok: scheduled?.ok === true,
    due: scheduled?.due ?? null,
    period: scheduled?.period || null,
    resultCount: results.length,
    synthetic: synthetic && {
      ok: synthetic.ok ?? null,
      duplicate: synthetic.duplicate ?? synthetic.occurrence?.id === OCCURRENCE,
      occurrenceId: synthetic.occurrence?.id || null,
      idempotence_key: synthetic.occurrence?.idempotence_key || synthetic.idempotency_key || null,
      simulated: synthetic.simulated ?? null,
      liveProviderCalled: synthetic.liveProviderCalled ?? null,
      status: synthetic.occurrence?.status || null,
      destination: synthetic.occurrence?.destination_account_id || null,
      reasons: synthetic.reasons || null,
      error: synthetic.error || null,
    },
    freedom: freedom && {
      ok: freedom.ok ?? null,
      error: freedom.error || null,
      reasons: freedom.reasons || null,
    },
    skippedUnauthorized: results.filter((row) => (
      row.tenant_id !== SYNTHETIC
      && (row.error === 'billing_not_ready' || (row.reasons || []).includes('missing_authorization'))
    )).length,
    skippedPaused: results.filter((row) => (
      row.error === 'billing_paused' || (row.reasons || []).includes('billing_paused')
    )).length,
    skippedNotDue: results.filter((row) => (
      row.error === 'not_due' || (row.reasons || []).includes('not_due')
    )).length,
    otherTenantIds: results.filter((row) => row.tenant_id !== SYNTHETIC).map((row) => row.tenant_id),
  };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('moov-billing-scheduler-accept');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const vars = cfg.Environment?.Variables || {};
  const flags = {
    destinationAccount: vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || null,
    destinationPaymentMethod: vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID || null,
    sandboxTransferPost: vars.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    productionPost: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
    monthlyBillingEnabled: vars.AWS_MOOV_MONTHLY_BILLING_ENABLED || null,
  };
  if (flags.destinationAccount !== SANDBOX_MERCHANT || flags.destinationPaymentMethod !== SANDBOX_WALLET_PM) {
    throw new Error('staging destination drifted; refusing to continue');
  }
  if (flags.sandboxTransferPost === 'true' || flags.productionPost === 'true') {
    throw new Error('transfer posting is enabled; refusing to continue');
  }
  const policy = await applyPolicy();
  const secret = vars.AWS_SCHEDULED_JOB_SECRET;
  if (!secret) throw new Error('scheduled_secret_missing');
  const first = invokeJob(secret, 'moov-monthly-tenant-billing');
  const second = invokeJob(secret, 'moov-monthly-tenant-billing');
  const financialJobs = ['deposit-daily-automation', 'wallet-fund-on-clear', 'checkalt-approve-cron', 'moov-sweep'];
  const financial = financialJobs.map((job) => {
    const row = invokeJob(secret, job);
    return { job, ok: row.ok === true, error: row.error || null, message: row.message || null };
  });
  const firstSum = summarize(first);
  const secondSum = summarize(second);
  const report = {
    generatedAt: new Date().toISOString(),
    productionTouched: false,
    eventBridgeCreated: false,
    stagingTransferPostEnabled: false,
    flags,
    policy,
    first: firstSum,
    second: secondSum,
    sameOccurrence: firstSum.synthetic?.occurrenceId === OCCURRENCE
      && secondSum.synthetic?.occurrenceId === OCCURRENCE,
    noDuplicateDebit: firstSum.synthetic?.occurrenceId === OCCURRENCE
      && (secondSum.synthetic == null || secondSum.synthetic.occurrenceId === OCCURRENCE),
    financialJobsRemainDisabled: financial.every((row) => row.error === 'financial_job_disabled'),
    financial,
    destinationUnchanged: flags.destinationAccount === SANDBOX_MERCHANT
      && flags.destinationPaymentMethod === SANDBOX_WALLET_PM,
  };
  await writeFile(`${OUT}/scheduler-acceptance.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
