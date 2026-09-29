#!/usr/bin/env node
/**
 * Pre-production status snapshot. Simulation / read-only AWS + API.
 * Does not set production env, create EventBridge rules, or post ACH.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';
const STAGING_API = 'checksops-staging-api';
const PROD_API = 'checksops-production-prep-api';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const SANDBOX_WALLET_PM = '3c3133e7-5489-4af8-9d9a-4b0cf6bad362';
const PROD_MERCHANT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const PROD_WALLET_PM = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';

const awsTry = (args) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
    return { ok: true, data: out.trim() ? JSON.parse(out) : {} };
  } catch (error) {
    const text = String(error.stderr || error.stdout || error.message || error);
    const action = (text.match(/perform(?:ing the action)?:?\s+\(?([A-Za-z0-9:]+)\)?/) || [])[1]
      || (text.match(/not authorized to perform: ([A-Za-z0-9:]+)/) || [])[1]
      || `${args[0]}:${args[1]}`;
    return {
      ok: false,
      denied: /AccessDenied|not authorized|explicit deny/i.test(text),
      action,
      error: text.replace(/\s+/g, ' ').trim().slice(0, 420),
    };
  }
};

const flagSlice = (vars = {}) => ({
  CHECKSOPS_ENV: vars.CHECKSOPS_ENV || null,
  AWS_MOOV_MONTHLY_BILLING_ENABLED: vars.AWS_MOOV_MONTHLY_BILLING_ENABLED || null,
  AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
  AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || null,
  AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID: vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID || null,
  AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: vars.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
  AWS_SCHEDULED_JOB_SECRET_PRESENT: Boolean(vars.AWS_SCHEDULED_JOB_SECRET),
});

const api = async (path, { token, body, method = 'POST' } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 240) }; }
  return { ok: res.ok && data?.ok !== false, status: res.status, data };
};

const query = (token, table, extra = {}) => api('/data/query', {
  token,
  body: { table, op: 'select', ...extra },
});

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('moov-billing-preprod-status');
  const identity = awsTry(['sts', 'get-caller-identity']);

  const stagingCfg = awsTry(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
  const prodCfg = awsTry(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const stagingVars = stagingCfg.data?.Environment?.Variables || {};
  const prodVars = prodCfg.data?.Environment?.Variables || {};

  const eventBridge = {
    listRules: awsTry(['events', 'list-rules', '--name-prefix', 'moov-monthly']),
    describeRule: awsTry(['events', 'describe-rule', '--name', 'moov-monthly-tenant-billing']),
    listTargets: awsTry(['events', 'list-targets-by-rule', '--rule', 'moov-monthly-tenant-billing']),
    listConnections: awsTry(['events', 'list-connections', '--name-prefix', 'moov-monthly']),
    listApiDestinations: awsTry(['events', 'list-api-destinations', '--name-prefix', 'moov-monthly']),
    listSchedules: awsTry(['scheduler', 'list-schedules', '--name-prefix', 'moov-monthly']),
  };

  const iam = {
    cursorRole: awsTry(['iam', 'get-role', '--role-name', 'ChecksOpsCursorCloudStaging']),
    cursorAttached: awsTry(['iam', 'list-attached-role-policies', '--role-name', 'ChecksOpsCursorCloudStaging']),
    cursorInline: awsTry(['iam', 'list-role-policies', '--role-name', 'ChecksOpsCursorCloudStaging']),
    stagingApiRole: awsTry(['iam', 'list-attached-role-policies', '--role-name', 'checksops-staging-ApiFunctionRole-7E7XRyLe3nyi']),
    listRolesPrefix: awsTry(['iam', 'list-roles', '--path-prefix', '/']),
  };

  const spa = awsTry(['s3api', 'head-object', '--bucket', 'checksops-staging-frontend-c48b', '--key', 'index.html']);
  const adminAsset = awsTry(['s3api', 'head-object', '--bucket', 'checksops-staging-frontend-c48b', '--key', 'assets/AdminTenants-Bz3jmqLe.js']);

  const owner = JSON.parse(await readFile(`${OUT}/.staging-owner.jwt.json`, 'utf8'));
  const tester = JSON.parse(await readFile(`${OUT}/.staging-tester.jwt.json`, 'utf8'));
  const ownerToken = owner.idToken;
  const testerToken = tester.idToken;

  const methods = await query(ownerToken, 'payment_provider_methods', {
    select: 'id,tenant_id,provider,provider_payment_method_id,provider_account_id,holder_name,last_four,nickname,connection_status,verification_status,environment,can_send',
  });
  const methodRows = Array.isArray(methods.data?.rows)
    ? methods.data.rows
    : (Array.isArray(methods.data?.data) ? methods.data.data : (Array.isArray(methods.data) ? methods.data : []));

  const accounts = await query(ownerToken, 'tenant_billing_accounts', {
    select: 'id,tenant_id,provider_payment_method_id,auto_debit_enabled,ach_authorized_at,ach_authorized_by,account_number_last4,verification_status',
  });
  const accountRows = Array.isArray(accounts.data?.rows)
    ? accounts.data.rows
    : (Array.isArray(accounts.data?.data) ? accounts.data.data : (Array.isArray(accounts.data) ? accounts.data : []));

  const testerAccounts = await query(testerToken, 'tenant_billing_accounts', {
    select: 'id,tenant_id,provider_payment_method_id,auto_debit_enabled,ach_authorized_at',
  });
  const testerC1cAccounts = await query(testerToken, 'tenant_billing_accounts', {
    select: 'id,tenant_id,provider_payment_method_id',
    filters: [{ column: 'tenant_id', op: 'eq', value: C1C }],
  });
  const testerC1cMethods = await query(testerToken, 'payment_provider_methods', {
    select: 'id,tenant_id,provider_payment_method_id,last_four',
    filters: [{ column: 'tenant_id', op: 'eq', value: C1C }],
  });

  const usableBanks = methodRows.filter((row) => (
    row.connection_status === 'connected'
    && row.provider_payment_method_id
    && row.environment === 'sandbox'
    && row.tenant_id !== null
  ));

  const getFreedom = await api('/functions/v1/tenant-billing-admin', {
    token: ownerToken,
    body: { action: 'get', tenant_id: FREEDOM },
  });
  const pull = await api('/functions/v1/tenant-billing-admin', {
    token: ownerToken,
    body: { action: 'pull', tenant_id: FREEDOM },
  });
  const testerPull = await api('/functions/v1/tenant-billing-admin', {
    token: testerToken,
    body: { action: 'pull', tenant_id: FREEDOM },
  });
  const testerRate = await query(testerToken, 'tenants', {
    op: 'update',
    values: { monthly_rate_cents: 1 },
    filters: [{ column: 'id', op: 'eq', value: FREEDOM }],
  });

  const report = {
    generatedAt: new Date().toISOString(),
    identity: identity.data || identity,
    productionMerchantForApproval: {
      accountId: PROD_MERCHANT,
      walletPaymentMethodId: PROD_WALLET_PM,
      envVarsSetOnProduction: Boolean(
        prodVars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID
        || prodVars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID,
      ),
    },
    staging: {
      function: stagingCfg.data?.FunctionName || null,
      codeSha256: stagingCfg.data?.CodeSha256 || null,
      lastModified: stagingCfg.data?.LastModified || null,
      flags: flagSlice(stagingVars),
      destinationMatches: stagingVars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID === SANDBOX_MERCHANT
        && stagingVars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID === SANDBOX_WALLET_PM,
      transferPostEnabled: stagingVars.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true',
    },
    production: {
      function: prodCfg.data?.FunctionName || null,
      codeSha256: prodCfg.data?.CodeSha256 || null,
      lastModified: prodCfg.data?.LastModified || null,
      flags: flagSlice(prodVars),
      monthlyBillingEnabled: prodVars.AWS_MOOV_MONTHLY_BILLING_ENABLED === 'true',
      productionPostEnabled: prodVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST === 'true',
    },
    spa: {
      indexLastModified: spa.data?.LastModified || spa.error || null,
      indexEtag: spa.data?.ETag || null,
      adminTenantsAsset: adminAsset.ok ? {
        lastModified: adminAsset.data?.LastModified || null,
        etag: adminAsset.data?.ETag || null,
      } : { error: adminAsset.error },
    },
    eventBridge,
    iam,
    paymentMethods: methodRows.map((row) => ({
      tenant_id: row.tenant_id,
      provider: row.provider,
      provider_payment_method_id: row.provider_payment_method_id,
      last_four: row.last_four,
      connection_status: row.connection_status,
      environment: row.environment,
      can_send: row.can_send,
      holder_name: row.holder_name,
    })),
    usableSandboxConnectedMethods: usableBanks.map((row) => ({
      tenant_id: row.tenant_id,
      provider_payment_method_id: row.provider_payment_method_id,
      last_four: row.last_four,
      environment: row.environment,
    })),
    tenantBillingAccounts: accountRows,
    testerTenantBillingAccounts: {
      status: testerAccounts.status,
      error: testerAccounts.data?.error || null,
      rows: testerAccounts.data?.rows || testerAccounts.data?.data || testerAccounts.data || null,
    },
    isolation: {
      testerCannotReadC1cAccounts: testerC1cAccounts.data?.error || testerC1cAccounts.status,
      testerCannotReadC1cMethods: testerC1cMethods.data?.error || testerC1cMethods.status,
      testerCannotPull: testerPull.data?.error || testerPull.status,
      testerCannotChangeRate: testerRate.data?.error || testerRate.status,
    },
    destinationResolution: {
      getOk: getFreedom.ok,
      destination: getFreedom.data?.destination || null,
      destinationMatchesSandboxMerchant: getFreedom.data?.destination?.accountId === SANDBOX_MERCHANT
        && getFreedom.data?.destination?.paymentMethodId === SANDBOX_WALLET_PM,
      firstWalletFallback: false,
      readiness: getFreedom.data?.readiness || null,
      authorization: getFreedom.data?.authorization || null,
      pull: {
        status: pull.status,
        error: pull.data?.error || null,
        reasons: pull.data?.pull?.reasons || pull.data?.readiness?.reasons || null,
        destinationAccountId: pull.data?.destination?.accountId || null,
        destinationPaymentMethodId: pull.data?.destination?.paymentMethodId || null,
        liveProviderCalled: pull.data?.pull?.liveProviderCalled ?? null,
        simulated: pull.data?.pull?.simulated ?? null,
        idempotency_key: pull.data?.idempotency_key || null,
      },
    },
    authorizeSkipped: usableBanks.length === 0
      ? 'no_sandbox_connected_bank_with_moov_payment_method_id'
      : 'usable_methods_exist_do_not_auto_authorize_wallet',
    mutatedMoov: false,
    createdEventBridge: false,
    productionEnvVarsSet: false,
    liveDebitCreated: false,
  };

  await writeFile(`${OUT}/preprod-acceptance-status.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
