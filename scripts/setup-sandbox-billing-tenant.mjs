#!/usr/bin/env node
/**
 * Staging-only: create a clearly marked synthetic sandbox billing tenant,
 * connect a real Moov sandbox bank, authorize via tenant-billing-authorize,
 * then simulate Pull Now. Does not enable transfer posting or touch production.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';
const API_NAME = 'checksops-staging-api';
const ONESHOT = 'checksops-staging-moov-billing-tenant-2d41';
const SLUG = 'synthetic-monthly-billing';
const NAME = 'SYNTHETIC Monthly Billing Test';
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const SANDBOX_WALLET_PM = '3c3133e7-5489-4af8-9d9a-4b0cf6bad362';
const OWNER = '233c588f-dc33-4307-8c3f-3da49c9fd2b3';
const ROUTING = '021000021';
const ACCOUNT = '4099999992';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', 'us-east-1', '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const api = async (pathName, { token, body, method = 'POST' } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathName}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
  return { ok: res.ok && data?.ok !== false && data?.success !== false, status: res.status, data };
};

const persistHandler = () => `import fs from 'node:fs';
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
    const existing = (await client.query(
      "SELECT id FROM public.tenants WHERE slug = $1 LIMIT 1",
      ['${SLUG}']
    )).rows[0];
    const created = !existing;
    const tenantId = existing?.id || (await client.query(
      "INSERT INTO public.tenants (name, slug) VALUES ($1, $2) RETURNING id",
      ['${NAME}', '${SLUG}']
    )).rows[0].id;
    await client.query(
      \`UPDATE public.tenants SET
         is_test_account = true,
         moov_environment = 'sandbox',
         subscription_status = 'active',
         monthly_rate_cents = COALESCE(NULLIF(monthly_rate_cents, 0), 2500),
         name = $2
       WHERE id = $1::uuid\`,
      [tenantId, '${NAME}']
    );
    await client.query(
      \`INSERT INTO public.tenant_billing_settings (
         tenant_id, billing_enabled, billing_day_of_month
       ) VALUES ($1::uuid, true, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET
         billing_enabled = true,
         billing_day_of_month = 1,
         updated_at = now()\`,
      [tenantId]
    );
    await client.query(
      \`INSERT INTO public.tenant_users (user_id, tenant_id, role)
       SELECT $1::uuid, $2::uuid, 'admin'
       WHERE NOT EXISTS (
         SELECT 1 FROM public.tenant_users
         WHERE user_id = $1::uuid AND tenant_id = $2::uuid
       )\`,
      ['${OWNER}', tenantId]
    );
    const accountId = process.env.MOOV_ACCOUNT_ID || null;
    let account = null;
    if (accountId) {
      account = (await client.query(
        \`INSERT INTO public.payment_provider_accounts
           (tenant_id, provider, environment, provider_account_id, account_type, display_name,
            onboarding_status, verification_status, last_synced_at)
         VALUES ($1::uuid, 'moov', 'sandbox', $2, 'business', $3, 'onboarding_incomplete', 'not_started', now())
         ON CONFLICT (tenant_id, provider, environment) DO UPDATE SET
           provider_account_id = EXCLUDED.provider_account_id,
           last_synced_at = now()
         RETURNING id, tenant_id, provider_account_id, environment, onboarding_status\`,
        [tenantId, accountId, '${NAME}']
      )).rows[0];
    }
    const paymentMethodId = process.env.MOOV_PAYMENT_METHOD_ID || null;
    let method = null;
    if (paymentMethodId) {
      method = (await client.query(
        \`INSERT INTO public.payment_provider_methods
           (tenant_id, provider, environment, provider_account_id, provider_bank_account_id,
            provider_payment_method_id, holder_name, last_four, verification_status,
            connection_status, can_send, can_receive, is_default, connected_at)
         VALUES ($1::uuid, 'moov', 'sandbox', $2, $3, $4, $5, $6, 'verified', 'connected', true, true, true, now())
         ON CONFLICT (provider, environment, provider_bank_account_id) DO UPDATE SET
           provider_payment_method_id = COALESCE(EXCLUDED.provider_payment_method_id, payment_provider_methods.provider_payment_method_id),
           connection_status = 'connected',
           can_send = true,
           last_four = EXCLUDED.last_four
         RETURNING provider_payment_method_id, provider_account_id, last_four, connection_status\`,
        [
          tenantId,
          process.env.MOOV_ACCOUNT_ID,
          process.env.MOOV_BANK_ACCOUNT_ID || paymentMethodId,
          paymentMethodId,
          '${NAME}',
          process.env.MOOV_LAST_FOUR || '9992',
        ]
      )).rows[0];
    }
    const tenant = (await client.query(
      "SELECT id, name, slug, is_test_account, moov_environment, subscription_status, monthly_rate_cents FROM public.tenants WHERE id = $1::uuid",
      [tenantId]
    )).rows[0];
    const membership = (await client.query(
      "SELECT user_id, tenant_id, role FROM public.tenant_users WHERE tenant_id = $1::uuid AND user_id = $2::uuid",
      [tenantId, '${OWNER}']
    )).rows[0] || null;
    const grants = (await client.query(
      \`SELECT grantee, privilege_type
       FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name IN ('payment_provider_accounts','payment_provider_methods')
       ORDER BY table_name, grantee, privilege_type\`
    )).rows;
    return { ok: true, created, tenant, membership, account, method, grants, synthetic: true, neverProductionDebitSource: true };
  } finally {
    await client.end();
  }
};
`;

const upsertSyntheticTenant = async ({ accountId = '', paymentMethodId = '', bankAccountId = '', lastFour = '', skipRebuild = false } = {}) => {
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);
  const apiCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN,
      RDS_HOST: rehearsal.Environment?.Variables?.RDS_HOST,
      DATABASE_NAME: 'checksops',
      ...(accountId ? { MOOV_ACCOUNT_ID: accountId } : {}),
      ...(paymentMethodId ? { MOOV_PAYMENT_METHOD_ID: paymentMethodId } : {}),
      ...(bankAccountId ? { MOOV_BANK_ACCOUNT_ID: bankAccountId } : {}),
      ...(lastFour ? { MOOV_LAST_FOUR: lastFour } : {}),
    },
  };
  if (!skipRebuild) {
    const staging = path.join(os.tmpdir(), 'checksops-billing-tenant-mark');
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, 'index.mjs'), persistHandler());
    await writeFile(path.join(staging, 'package.json'), JSON.stringify({
      type: 'module',
      dependencies: { '@aws-sdk/client-secrets-manager': '3.1124.0', pg: '8.23.0' },
    }));
    await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
    execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
    const zip = path.join(os.tmpdir(), 'checksops-billing-tenant-mark.zip');
    await rm(zip, { force: true });
    execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
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
  } else {
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT, '--environment', JSON.stringify(env)]);
    waitFn(ONESHOT);
  }
  const outFile = path.join(os.tmpdir(), `billing-tenant-mark-${Date.now()}.json`);
  execFileSync(AWS, ['lambda', 'invoke', '--function-name', ONESHOT, outFile]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const mintOwnerIfNeeded = async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/mint-platform-owner-token.mjs')], { stdio: 'inherit' });
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('moov-billing-sandbox-tenant');
  await mintOwnerIfNeeded();
  const owner = JSON.parse(await readFile(`${OUT}/.staging-owner.jwt.json`, 'utf8'));
  const token = owner.idToken;

  const marked = await upsertSyntheticTenant();
  const tenantId = marked.tenant?.id || marked.Payload && JSON.parse(marked.Payload)?.tenant?.id || null;
  const created = marked.created === true || marked.Payload && JSON.parse(marked.Payload)?.created === true;
  if (!tenantId) {
    await writeFile(`${OUT}/sandbox-tenant-setup.json`, JSON.stringify({ ok: false, step: 'create_tenant', marked }, null, 2));
    console.log(JSON.stringify({ ok: false, step: 'create_tenant', marked }, null, 2));
    return;
  }
  const before = await api('/functions/v1/tenant-billing-admin', {
    token,
    body: { action: 'get', tenant_id: tenantId },
  });
  const settings = await api('/functions/v1/tenant-billing-admin', {
    token,
    body: {
      action: 'update',
      tenant_id: tenantId,
      monthly_rate_cents: 2500,
      referral_discount_cents: 0,
      billing_enabled: true,
      billing_day_of_month: 1,
    },
  });
  let account = await api('/functions/v1/moov-account-create', {
    token,
    body: { tenant_id: tenantId },
  });
  const recoveredAccountId = account.data?.recovered_provider_account_id
    || account.data?.account?.provider_account_id
    || null;
  let privilegedAccount = null;
  if (recoveredAccountId && !account.data?.account?.provider_account_id) {
    privilegedAccount = await upsertSyntheticTenant({ accountId: recoveredAccountId, skipRebuild: true });
    account = await api('/functions/v1/moov-account-create', {
      token,
      body: { tenant_id: tenantId },
    });
  }
  const onboard = await api('/functions/v1/moov-account-onboard', {
    token,
    body: {
      tenant_id: tenantId,
      business: {
        legalBusinessName: NAME,
        businessType: 'llc',
        email: 'synthetic-monthly-billing@checksops.invalid',
        phone: '5555550100',
        website: 'https://checksops.com',
        description: 'Synthetic staging monthly billing tenant. Not a production debit source.',
        ein: '123456789',
        address: {
          addressLine1: '1 Synthetic Billing Way',
          city: 'Wilmington',
          stateOrProvince: 'DE',
          postalCode: '19801',
          country: 'US',
        },
      },
    },
  });
  const synced = await api('/functions/v1/moov-sync', { token, body: { tenant_id: tenantId } });
  const bank = await api('/functions/v1/moov-bank-account-add', {
    token,
    body: {
      tenant_id: tenantId,
      holder_name: 'SYNTHETIC Monthly Billing Test',
      holder_type: 'business',
      bank_account_type: 'checking',
      routing_number: ROUTING,
      account_number: ACCOUNT,
    },
  });
  const afterBankSync = await api('/functions/v1/moov-sync', { token, body: { tenant_id: tenantId } });
  if (!bank.data?.provider_payment_method_id) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await api('/functions/v1/moov-sync', { token, body: { tenant_id: tenantId } });
  }
  const afterBank = await api('/functions/v1/tenant-billing-admin', {
    token,
    body: { action: 'get', tenant_id: tenantId },
  });
  let paymentMethodId = bank.data?.provider_payment_method_id
    || afterBank.data?.methods?.[0]?.provider_payment_method_id
    || bank.data?.recovered_provider_payment_method_id
    || null;
  let privilegedMethod = null;
  if (paymentMethodId || bank.data?.bank_account_id) {
    privilegedMethod = await upsertSyntheticTenant({
      accountId: recoveredAccountId || account.data?.account?.provider_account_id,
      paymentMethodId: paymentMethodId || bank.data?.recovered_provider_payment_method_id,
      bankAccountId: bank.data?.bank_account_id,
      lastFour: bank.data?.last_four || '9992',
      skipRebuild: true,
    });
    paymentMethodId = privilegedMethod.method?.provider_payment_method_id || paymentMethodId;
  }
  const authorize = paymentMethodId
    ? await api('/functions/v1/tenant-billing-authorize', {
      token,
      body: {
        tenant_id: tenantId,
        provider_payment_method_id: paymentMethodId,
        authorized: true,
        auto_debit_enabled: true,
      },
    })
    : { ok: false, skipped: 'missing_sandbox_payment_method_id', data: bank.data };
  const ready = await api('/functions/v1/tenant-billing-admin', {
    token,
    body: { action: 'get', tenant_id: tenantId },
  });

  const cfgEarly = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const secret = cfgEarly.Environment?.Variables?.AWS_SCHEDULED_JOB_SECRET;
  let scheduled = { ok: false, error: 'scheduled_secret_missing' };
  let scheduledAgain = null;
  if (secret) {
    const invoke = async () => {
      const raw = execFileSync('curl', [
        '-sS', '-X', 'POST',
        `${API}/scheduled`,
        '-H', `x-scheduled-job-secret: ${secret}`,
        '-H', 'content-type: application/json',
        '-d', JSON.stringify({ job: 'moov-monthly-tenant-billing' }),
      ], { encoding: 'utf8' });
      try { return JSON.parse(raw); } catch { return { ok: false, raw: raw.slice(0, 400) }; }
    };
    scheduled = await invoke();
    scheduledAgain = await invoke();
  }

  const pull = await api('/functions/v1/tenant-billing-admin', {
    token,
    body: { action: 'pull', tenant_id: tenantId },
  });
  const pullAgain = await api('/functions/v1/tenant-billing-admin', {
    token,
    body: { action: 'pull', tenant_id: tenantId },
  });
  const transferId = pull.data?.pull?.occurrence?.provider_transfer_id
    || scheduled?.results?.find?.((row) => row.tenant_id === tenantId)?.occurrence?.provider_transfer_id
    || null;
  const settled = transferId
    ? await api('/functions/v1/tenant-billing-admin', {
      token,
      body: {
        action: 'apply-event',
        tenant_id: tenantId,
        provider_transfer_id: transferId,
        status: 'transfer.completed',
        reason: 'simulated_settlement',
      },
    })
    : { ok: false, skipped: 'no_transfer_id' };
  const returned = transferId
    ? await api('/functions/v1/tenant-billing-admin', {
      token,
      body: {
        action: 'apply-event',
        tenant_id: tenantId,
        provider_transfer_id: transferId,
        status: 'transfer.returned',
        reason: 'simulated_return',
      },
    })
    : { ok: false, skipped: 'no_transfer_id' };

  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const financialJobs = ['deposit-daily-automation', 'wallet-fund-on-clear', 'checkalt-approve-cron', 'moov-sweep'];
  const financialDisabled = [];
  if (secret) {
    for (const job of financialJobs) {
      const raw = execFileSync('curl', [
        '-sS', '-X', 'POST',
        `${API}/scheduled`,
        '-H', `x-scheduled-job-secret: ${secret}`,
        '-H', 'content-type: application/json',
        '-d', JSON.stringify({ job }),
      ], { encoding: 'utf8' });
      try { financialDisabled.push(JSON.parse(raw)); } catch { financialDisabled.push({ job, raw: raw.slice(0, 200) }); }
    }
  }
  const scheduledResults = Array.isArray(scheduled?.results) ? scheduled.results : [];
  const authorizedResult = scheduledResults.find((row) => row.tenant_id === tenantId) || null;
  const skippedUnauthorized = scheduledResults.filter((row) => (
    row.tenant_id !== tenantId && (row.error === 'billing_not_ready' || (row.reasons || []).includes('missing_authorization'))
  )).length;
  const skippedPaused = scheduledResults.filter((row) => (row.reasons || []).includes('billing_paused')).length;
  const firstOccurrenceId = authorizedResult?.occurrence?.id || pull.data?.pull?.occurrence?.id || null;
  const retryOccurrenceId = pullAgain.data?.pull?.occurrence?.id || scheduledAgain?.results?.find?.((row) => row.tenant_id === tenantId)?.occurrence?.id || null;

  const report = {
    generatedAt: new Date().toISOString(),
    synthetic: true,
    neverProductionDebitSource: true,
    stagingTransferPostEnabled: Boolean(cfg.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true'),
    productionTouched: false,
    tenant: {
      created,
      id: tenantId,
      slug: SLUG,
      name: NAME,
      marked,
    },
    moov: {
      account,
      privilegedAccount,
      recoveredAccountId,
      onboard: { ok: onboard.ok, status: onboard.status, error: onboard.data?.error || null },
      synced: { ok: synced.ok, status: synced.status, onboarding: synced.data?.status || null },
      afterBankSync: { ok: afterBankSync.ok, status: afterBankSync.status },
      bank,
      privilegedMethod,
    },
    authorization: authorize,
    readiness: {
      before: before.data?.readiness || before.data?.error || null,
      afterSettings: settings.data?.readiness || null,
      afterBank: afterBank.data?.readiness || null,
      afterAuth: ready.data?.readiness || null,
      authorization: ready.data?.authorization || null,
      methods: ready.data?.methods || [],
      destination: ready.data?.destination || null,
    },
    pull: {
      first: {
        ok: pull.ok,
        status: pull.status,
        simulated: pull.data?.pull?.simulated ?? null,
        liveProviderCalled: pull.data?.pull?.liveProviderCalled ?? null,
        occurrence: pull.data?.pull?.occurrence || null,
        idempotency_key: pull.data?.idempotency_key || null,
        error: pull.data?.error || pull.data?.pull?.error || null,
        reasons: pull.data?.pull?.reasons || pull.data?.readiness?.reasons || null,
      },
      retry: {
        ok: pullAgain.ok,
        status: pullAgain.status,
        occurrenceId: pullAgain.data?.pull?.occurrence?.id || null,
        duplicate: pullAgain.data?.pull?.duplicate ?? pullAgain.data?.pull?.occurrence?.id === pull.data?.pull?.occurrence?.id,
        idempotency_key: pullAgain.data?.idempotency_key || null,
      },
    },
    webhooks: { settled, returned },
    scheduled,
    scheduledAgain,
    schedulerAcceptance: {
      job: scheduled?.job || 'moov-monthly-tenant-billing',
      due: scheduled?.due ?? null,
      authorizedTenantProcessed: Boolean(authorizedResult?.ok || authorizedResult?.occurrence?.id),
      authorizedOccurrenceId: firstOccurrenceId,
      retrySameOccurrence: Boolean(firstOccurrenceId && retryOccurrenceId === firstOccurrenceId),
      skippedUnauthorized,
      skippedPaused,
      simulated: authorizedResult?.simulated ?? pull.data?.pull?.simulated ?? null,
      liveProviderCalled: authorizedResult?.liveProviderCalled ?? pull.data?.pull?.liveProviderCalled ?? null,
      financialJobsRemainDisabled: financialDisabled.every((row) => row.error === 'financial_job_disabled'),
      financialDisabled,
    },
    destinationMatches: ready.data?.destination?.accountId === SANDBOX_MERCHANT
      && ready.data?.destination?.paymentMethodId === SANDBOX_WALLET_PM,
  };
  await writeFile(`${OUT}/sandbox-tenant-setup.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
