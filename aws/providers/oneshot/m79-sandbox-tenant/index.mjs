/**
 * M7.9 VPC oneshot: inspect/apply SQL 77, switch one designated sandbox tenant.
 * Never updates Freedom. Never copies production provider IDs. Never POSTs to Moov.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
const SANDBOX_ACCOUNT = '1d59a6a8-3307-4687-8367-1495293ecc73';
const SANDBOX_WALLET = '58571121-67ea-4e10-abae-6c9680ac455d';
const SANDBOX_BANK = '8390f74b-706e-4d89-80b0-f96bd7c1b414';
const ACTOR = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const PRODUCTION_IDS = new Set([
  '60922058-7eca-4889-81dd-5720d7b9de96',
  '3e6286ca-a19c-45f6-aad9-f73dac5f0358',
  '61062c38-a79e-4f62-bb64-32ddecf3d37c',
  'a02c1c81-9ca6-434d-accc-ea4471a70ef2',
  '744ea734-f5e3-4b31-bb92-38f85fd29b91',
  '7a78a544-340d-46fd-a4a4-228661374da7',
  '817e1bf0-e1f7-4e9e-95a8-ce15bfa31708',
  '41cb5d67-4911-4bef-aad5-d8ee9c582208',
  'ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f',
  '72eb66c1-d9a9-4f85-ab50-8871db9ceeea',
  '15b6185b-ec16-4e9d-97b4-555a54d326b9',
  '1c58bbea-8f55-42b2-b794-25c30eecdadc',
  '62a858ff-ee6a-49d7-9898-1c8e4a44227b',
].map((id) => id.toLowerCase()));

const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  '/var/task/rds-global-bundle.pem',
].find((p) => fs.existsSync(p));

const fail = (error, extra = {}) => ({
  ok: false,
  error,
  productionMoneyMoved: false,
  freedomChanged: false,
  sweepChanged: false,
  ...extra,
});

const connect = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be checksops_admin');
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) throw new Error('secret username is not checksops_admin');
  const host = parsed.host && parsed.host !== 'localhost' && parsed.host !== '127.0.0.1'
    ? parsed.host
    : process.env.RDS_HOST;
  if (!host || host === 'localhost') throw new Error('admin secret host is missing or loopback');
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 120000,
  });
  await client.connect();
  const who = (await client.query('SELECT current_database() AS db, current_user AS usr')).rows[0];
  if (who.db !== 'checksops') {
    await client.end();
    throw new Error(`connected to ${who.db}, expected checksops`);
  }
  return client;
};

const envValues = async (client) => {
  const rows = (await client.query(
    `SELECT moov_environment, count(*)::int AS n
       FROM public.tenants
      GROUP BY 1
      ORDER BY 1`,
  )).rows;
  const invalid = rows.filter((row) => !['sandbox', 'production'].includes(String(row.moov_environment || '')));
  return { values: rows, invalid };
};

const freedomRow = async (client) => (await client.query(
  `SELECT id, name, slug, moov_environment, moov_allowlisted, is_test_account, is_system_tenant, subscription_status
     FROM public.tenants WHERE id = $1::uuid`,
  [FREEDOM],
)).rows[0] || null;

const tenantObjects = async (client, tenantId, environment) => {
  const account = (await client.query(
    `SELECT id, environment, provider_account_id, onboarding_status, verification_status, can_send_payments, can_receive_payments
       FROM public.payment_provider_accounts
      WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
      ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [tenantId, environment],
  )).rows[0] || null;
  const wallet = (await client.query(
    `SELECT id, environment, provider_wallet_id, available_cents, pending_cents, status
       FROM public.payment_wallets
      WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
      ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [tenantId, environment],
  )).rows[0] || null;
  const banks = (await client.query(
    `SELECT id, environment, provider_bank_account_id, provider_payment_method_id, bank_name, last_four, verification_status
       FROM public.payment_provider_methods
      WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
      ORDER BY connected_at DESC NULLS LAST`,
    [tenantId, environment],
  )).rows;
  const recipients = (await client.query(
    `SELECT id, environment, provider_account_id, display_name, onboarding_status
       FROM public.external_payment_recipients
      WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
      ORDER BY created_at DESC NULLS LAST`,
    [tenantId, environment],
  )).rows;
  const ids = [
    account?.provider_account_id,
    wallet?.provider_wallet_id,
    ...banks.map((row) => row.provider_bank_account_id),
    ...banks.map((row) => row.provider_payment_method_id),
    ...recipients.map((row) => row.provider_account_id),
  ].filter(Boolean).map((id) => String(id).toLowerCase());
  return {
    account,
    wallet,
    banks,
    recipients,
    productionIdHits: ids.filter((id) => PRODUCTION_IDS.has(id)),
  };
};

const uniqueness = async (client) => {
  const activity = (await client.query(
    `SELECT provider, environment, provider_transfer_id, count(*)::int AS n
       FROM public.payment_provider_activity
      WHERE provider_transfer_id IS NOT NULL
      GROUP BY 1, 2, 3
     HAVING count(*) > 1`,
  )).rows;
  const events = (await client.query(
    `SELECT provider, environment, external_event_id, count(*)::int AS n
       FROM public.payment_webhook_events
      WHERE external_event_id IS NOT NULL
      GROUP BY 1, 2, 3
     HAVING count(*) > 1`,
  )).rows;
  const oldActivity = (await client.query(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'public.payment_provider_activity'::regclass
        AND contype = 'u'`,
  )).rows;
  const lookupArgs = (await client.query(
    `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'aws_lookup_provider_account',
          'aws_moov_lookup_transfer',
          'aws_moov_reconcile_existing_transfer',
          'aws_moov_observe_provider_activity',
          'aws_moov_set_tenant_environment',
          'aws_moov_reconcile_wallet_cache'
        )
      ORDER BY 1, 2`,
  )).rows;
  return {
    activityDupes: activity.length,
    webhookDupes: events.length,
    activityConstraints: oldActivity.map((row) => row.conname),
    functions: lookupArgs,
    safeForSql77: activity.length === 0 && events.length === 0,
  };
};

const sweepUnchanged = async (client) => {
  const row = (await client.query(
    `SELECT id, status, minimum_balance_cents, provider_wallet_id, environment
       FROM public.payment_sweep_configs
      WHERE tenant_id = $1::uuid
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`,
    [FREEDOM],
  )).rows[0] || null;
  return row;
};

const inspect = async (client) => {
  const tenants = (await client.query(
    `SELECT id, name, slug, moov_environment, moov_allowlisted, is_test_account,
            is_system_tenant, subscription_status, payment_status
       FROM public.tenants
      ORDER BY is_test_account DESC, name`,
  )).rows;
  const freedom = await freedomRow(client);
  const env = await envValues(client);
  const uniq = await uniqueness(client);
  const candidates = [];
  for (const tenant of tenants) {
    if (tenant.id === FREEDOM || tenant.id === C1C) continue;
    const sandbox = await tenantObjects(client, tenant.id, 'sandbox');
    const production = await tenantObjects(client, tenant.id, 'production');
    candidates.push({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      moov_environment: tenant.moov_environment,
      is_test_account: tenant.is_test_account,
      is_system_tenant: tenant.is_system_tenant,
      subscription_status: tenant.subscription_status,
      sandboxObjects: {
        account: Boolean(sandbox.account?.provider_account_id),
        wallet: Boolean(sandbox.wallet?.provider_wallet_id),
        banks: sandbox.banks.length,
        recipients: sandbox.recipients.length,
        productionIdHits: sandbox.productionIdHits.length,
      },
      productionObjects: {
        account: Boolean(production.account?.provider_account_id),
        wallet: Boolean(production.wallet?.provider_wallet_id),
      },
    });
  }
  const designated = candidates.find((row) => row.is_test_account)
    || candidates.find((row) => String(row.slug || '').includes('sandbox') || String(row.slug || '').includes('uat'))
    || null;
  return {
    ok: true,
    freedom,
    freedomIsProduction: freedom?.moov_environment === 'production',
    envValues: env.values,
    invalidEnvironments: env.invalid,
    uniqueness: uniq,
    sql77Safe: uniq.safeForSql77 && env.invalid.length === 0 && freedom?.moov_environment === 'production',
    designated,
    candidates,
    sweep: await sweepUnchanged(client),
    tenantCount: tenants.length,
  };
};

const applySql77 = async (client) => {
  const pre = await inspect(client);
  if (!pre.sql77Safe) return fail('sql77_preflight_failed', { inspect: pre });
  if (String(fs.readFileSync(path.join(ROOT, '77_moov_tenant_environment.sql'), 'utf8')).includes(FREEDOM)) {
    return fail('sql77_mentions_freedom');
  }
  await client.query(fs.readFileSync(path.join(ROOT, '77_moov_tenant_environment.sql'), 'utf8'));
  const post = await uniqueness(client);
  const freedom = await freedomRow(client);
  return {
    ok: true,
    applied: true,
    freedomEnvironment: freedom?.moov_environment,
    freedomChanged: false,
    uniqueness: post,
    setFn: post.functions.some((row) => row.proname === 'aws_moov_set_tenant_environment'),
  };
};

const applySql78 = async (client) => {
  const sqlPath = path.join(ROOT, '78_moov_recon_parity.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  if (sql.includes(FREEDOM)) return fail('sql78_mentions_freedom');
  if (/DELETE\s+FROM\s+public\.payment_event_log/i.test(sql)) return fail('sql78_deletes_event_log');
  if (/INSERT\s+INTO\s+public\.payment_transfers/i.test(sql)) return fail('sql78_inserts_transfers');
  const freedomBefore = await freedomRow(client);
  const sweepBefore = await sweepUnchanged(client);
  await client.query(sql);
  const post = await uniqueness(client);
  const freedom = await freedomRow(client);
  const sweep = await sweepUnchanged(client);
  return {
    ok: true,
    applied: true,
    freedomEnvironment: freedom?.moov_environment,
    freedomChanged: freedomBefore?.moov_environment !== freedom?.moov_environment,
    sweepChanged: String(sweepBefore?.id || '') !== String(sweep?.id || '')
      || String(sweepBefore?.status || '') !== String(sweep?.status || ''),
    uniqueness: post,
    hasWalletCache: post.functions.some((row) => row.proname === 'aws_moov_reconcile_wallet_cache'),
    hasFailureReasonLookup: post.functions.some((row) => (
      row.proname === 'aws_moov_lookup_transfer' && String(row.args || '').includes('text')
    )),
  };
};

const reconcileFundingParity = async (client, body = {}) => {
  const tenantId = body.tenantId;
  const intentId = body.intentId;
  const transferId = body.providerTransferId;
  const walletId = body.providerWalletId;
  const completedAt = body.completedAt || null;
  const availableCents = body.availableCents;
  const pendingCents = body.pendingCents;
  if (!tenantId || tenantId === FREEDOM || tenantId === C1C) return fail('refused_production_tenant');
  if (tenantId !== PIPELINE) return fail('undesignated_tenant', { tenantId });
  if (!intentId || !transferId) return fail('intent_and_transfer_required');
  if (!walletId || String(walletId).toLowerCase() !== SANDBOX_WALLET) return fail('wallet_id_mismatch');
  const productionHits = [transferId, walletId].filter((id) => PRODUCTION_IDS.has(String(id || '').toLowerCase()));
  if (productionHits.length) return fail('production_object_refused', { hits: productionHits });

  const freedomBefore = await freedomRow(client);
  const sweepBefore = await sweepUnchanged(client);
  const intentBefore = (await client.query(
    `SELECT id, tenant_id, environment, status, provider_status, completed_at, failure_reason,
            provider_transfer_id, provider_metadata
       FROM public.payment_transfers
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = 'sandbox'
      LIMIT 1`,
    [intentId, tenantId],
  )).rows[0];
  if (!intentBefore) return fail('intent_not_found');
  if (String(intentBefore.provider_transfer_id || '').toLowerCase() !== String(transferId).toLowerCase()) {
    return fail('transfer_id_mismatch');
  }

  const historyBefore = (await client.query(
    `SELECT count(*)::int AS n
       FROM public.payment_event_log
      WHERE tenant_id = $1::uuid
        AND (
          provider_transfer_id = $2
          OR transfer_id = $3::uuid
          OR COALESCE(provider_metadata->>'failure_reason', '') = 'moov_sandbox_http_failed'
          OR COALESCE(provider_metadata->>'code', '') IN ('403', 'http_403')
        )`,
    [tenantId, transferId, intentId],
  )).rows[0];
  const failureHistoryBefore = (await client.query(
    `SELECT id, event_type, previous_status, new_status, created_at
       FROM public.payment_event_log
      WHERE tenant_id = $1::uuid
        AND (
          COALESCE(provider_metadata->>'failure_reason', '') = 'moov_sandbox_http_failed'
          OR event_type ILIKE '%fail%'
          OR new_status IN ('failed', 'http_failed')
        )
      ORDER BY created_at ASC
      LIMIT 20`,
    [tenantId],
  )).rows;

  await client.query("SELECT set_config('request.moov_get_reconcile', '1', true)");
  const recon = (await client.query(
    `SELECT * FROM public.aws_moov_reconcile_existing_transfer(
       $1, $2, $3, $4::timestamptz, $5, $6, $7::jsonb, $8)`,
    [
      transferId,
      'completed',
      body.providerStatus || 'completed',
      completedAt,
      'moov.parity_fill',
      intentBefore.status,
      JSON.stringify({
        source: 'moov_get',
        completedOn: completedAt,
        phase: 'm79i',
      }),
      'sandbox',
    ],
  )).rows[0];

  const wallet = (await client.query(
    `SELECT * FROM public.aws_moov_reconcile_wallet_cache($1, $2, $3::bigint, $4::bigint, $5::uuid, $6::jsonb)`,
    [
      walletId,
      'sandbox',
      availableCents,
      pendingCents,
      tenantId,
      JSON.stringify({ source: 'moov_get', phase: 'm79i' }),
    ],
  )).rows[0] || null;

  const intentAfter = (await client.query(
    `SELECT id, tenant_id, environment, status, provider_status, completed_at, failure_reason,
            provider_transfer_id, provider_metadata
       FROM public.payment_transfers
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = 'sandbox'
      LIMIT 1`,
    [intentId, tenantId],
  )).rows[0];
  const historyAfter = (await client.query(
    `SELECT count(*)::int AS n
       FROM public.payment_event_log
      WHERE tenant_id = $1::uuid
        AND (
          provider_transfer_id = $2
          OR transfer_id = $3::uuid
          OR COALESCE(provider_metadata->>'failure_reason', '') = 'moov_sandbox_http_failed'
          OR COALESCE(provider_metadata->>'code', '') IN ('403', 'http_403')
        )`,
    [tenantId, transferId, intentId],
  )).rows[0];
  const failureHistoryAfter = (await client.query(
    `SELECT id
       FROM public.payment_event_log
      WHERE tenant_id = $1::uuid
        AND (
          COALESCE(provider_metadata->>'failure_reason', '') = 'moov_sandbox_http_failed'
          OR event_type ILIKE '%fail%'
          OR new_status IN ('failed', 'http_failed')
        )`,
    [tenantId],
  )).rows;
  const productionWallet = (await client.query(
    `SELECT id, environment, available_cents, pending_cents, provider_wallet_id
       FROM public.payment_wallets
      WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'production'`,
    [tenantId],
  )).rows;
  const freedomWallet = (await client.query(
    `SELECT id, environment, available_cents, pending_cents, last_synced_at
       FROM public.payment_wallets
      WHERE tenant_id = $1::uuid AND provider = 'moov'`,
    [FREEDOM],
  )).rows;
  const freedom = await freedomRow(client);
  const sweep = await sweepUnchanged(client);
  const objects = await tenantObjects(client, tenantId, 'sandbox');
  return {
    ok: String(intentAfter?.status) === 'completed'
      && String(intentAfter?.provider_status) === 'completed'
      && intentAfter?.failure_reason == null
      && Number(wallet?.available_cents) === Number(availableCents)
      && Number(wallet?.pending_cents) === Number(pendingCents)
      && Number(historyAfter?.n || 0) >= Number(historyBefore?.n || 0)
      && failureHistoryAfter.length >= failureHistoryBefore.length
      && freedom?.moov_environment === 'production',
    recon,
    wallet,
    intentBefore: {
      status: intentBefore.status,
      provider_status: intentBefore.provider_status,
      completed_at: intentBefore.completed_at,
      failure_reason: intentBefore.failure_reason,
    },
    intent: intentAfter,
    historyBefore: historyBefore?.n || 0,
    historyAfter: historyAfter?.n || 0,
    failureHistoryPreserved: failureHistoryAfter.length >= failureHistoryBefore.length,
    failureHistoryCount: failureHistoryAfter.length,
    productionWalletRows: productionWallet,
    freedomWalletRows: freedomWallet,
    rdsWallet: objects.wallet,
    freedomEnvironment: freedom?.moov_environment,
    freedomChanged: freedomBefore?.moov_environment !== freedom?.moov_environment,
    sweep,
    sweepChanged: String(sweepBefore?.id || '') !== String(sweep?.id || '')
      || String(sweepBefore?.status || '') !== String(sweep?.status || ''),
    createdPaymentTransfer: false,
    liveProviderPosted: false,
  };
};

const createDedicatedTenant = async (client) => {
  const existing = (await client.query(
    `SELECT id, name, slug, moov_environment, is_test_account
       FROM public.tenants WHERE slug = 'checksops-sandbox-uat'`,
  )).rows[0];
  if (existing) return { ok: true, created: false, tenant: existing };
  const billing = (await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants'
        AND column_name IN ('stripe_customer_id', 'monthly_rate_cents', 'per_check_billing_enabled')`,
  )).rows;
  const row = (await client.query(
    `INSERT INTO public.tenants (
        name, slug, is_test_account, moov_environment, moov_allowlisted,
        subscription_status, monthly_rate_cents, per_check_billing_enabled
      ) VALUES (
        'ChecksOps Sandbox UAT',
        'checksops-sandbox-uat',
        true,
        'sandbox',
        true,
        'inactive',
        0,
        false
      )
      RETURNING id, name, slug, moov_environment, is_test_account, subscription_status, monthly_rate_cents`,
  )).rows[0];
  await client.query(
    `INSERT INTO public.tenant_users (tenant_id, user_id, role)
     VALUES ($1::uuid, $2::uuid, 'owner')
     ON CONFLICT DO NOTHING`,
    [row.id, ACTOR],
  );
  return {
    ok: true,
    created: true,
    tenant: row,
    billingColumnsPresent: billing.map((item) => item.column_name),
    billingArmed: false,
  };
};

const switchTenant = async (client, tenantId) => {
  if (!tenantId || tenantId === FREEDOM || tenantId === C1C) {
    return fail('refused_production_tenant', { tenantId });
  }
  const before = (await client.query(
    `SELECT id, name, slug, moov_environment FROM public.tenants WHERE id = $1::uuid`,
    [tenantId],
  )).rows[0];
  if (!before) return fail('tenant_not_found', { tenantId });
  const expected = before.moov_environment === 'sandbox' ? 'sandbox' : before.moov_environment;
  const row = (await client.query(
    `SELECT * FROM public.aws_moov_set_tenant_environment($1::uuid, $2, 'sandbox', $3::uuid)`,
    [tenantId, expected, ACTOR],
  )).rows[0];
  const audit = (await client.query(
    `SELECT tenant_id, event_type, previous_status, new_status, provider_metadata, created_at
       FROM public.payment_event_log
      WHERE tenant_id = $1::uuid AND event_type = 'moov_environment.changed'
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  )).rows[0] || null;
  const freedom = await freedomRow(client);
  return {
    ok: true,
    tenant: before,
    switch: row,
    audit,
    freedomEnvironment: freedom?.moov_environment,
    freedomChanged: false,
    objects_migrated: false,
  };
};

const unusedProductionAccount = async (client, tenantId) => (await client.query(
  `SELECT id, environment, provider_account_id, display_name, onboarding_status
     FROM public.payment_provider_accounts
    WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'production'
    ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
  [tenantId],
)).rows[0] || null;

const lookupAccount = async (client, providerAccountId, environment) => {
  const row = (await client.query(
    `SELECT id, tenant_id, environment, provider_account_id
       FROM public.aws_lookup_provider_account($1, $2, $3)`,
    ['moov', String(providerAccountId), environment],
  )).rows[0] || null;
  return row;
};

const objectProof = async (client, tenantId) => {
  const tenant = (await client.query(
    `SELECT id, name, slug, moov_environment, is_test_account FROM public.tenants WHERE id = $1::uuid`,
    [tenantId],
  )).rows[0] || null;
  const freedom = await freedomRow(client);
  const sandbox = await tenantObjects(client, tenantId, 'sandbox');
  const production = await tenantObjects(client, tenantId, 'production');
  const freedomSandbox = await tenantObjects(client, FREEDOM, 'sandbox');
  const freedomProduction = await tenantObjects(client, FREEDOM, 'production');
  const unused = await unusedProductionAccount(client, tenantId);
  const sandboxLookupOfFreedom = freedomProduction.account?.provider_account_id
    ? await lookupAccount(client, freedomProduction.account.provider_account_id, 'sandbox')
    : null;
  const productionLookupOfSandbox = sandbox.account?.provider_account_id
    ? await lookupAccount(client, sandbox.account.provider_account_id, 'production')
    : null;
  const sandboxLookupOfSandbox = sandbox.account?.provider_account_id
    ? await lookupAccount(client, sandbox.account.provider_account_id, 'sandbox')
    : null;
  const productionLookupOfFreedom = freedomProduction.account?.provider_account_id
    ? await lookupAccount(client, freedomProduction.account.provider_account_id, 'production')
    : null;
  return {
    ok: tenant?.moov_environment === 'sandbox'
      && freedom?.moov_environment === 'production'
      && sandbox.productionIdHits.length === 0
      && !sandboxLookupOfFreedom
      && !productionLookupOfSandbox,
    tenant,
    freedom: {
      id: freedom?.id,
      name: freedom?.name,
      moov_environment: freedom?.moov_environment,
      sandboxAccount: Boolean(freedomSandbox.account?.provider_account_id),
      productionAccount: Boolean(freedomProduction.account?.provider_account_id),
      productionWallet: Boolean(freedomProduction.wallet?.provider_wallet_id),
      productionBanks: freedomProduction.banks.length,
      productionRecipients: freedomProduction.recipients.length,
    },
    pipeline: {
      sandbox,
      unusedProductionAccount: unused ? {
        id: unused.id,
        environment: unused.environment,
        provider_account_id: unused.provider_account_id,
        reused: sandbox.account?.provider_account_id
          && String(sandbox.account.provider_account_id).toLowerCase()
            === String(unused.provider_account_id || '').toLowerCase(),
      } : null,
      productionIgnored: {
        account: Boolean(production.account?.provider_account_id),
        wallet: Boolean(production.wallet?.provider_wallet_id),
      },
    },
    lookups: {
      sandboxLookupOfFreedomAccount: sandboxLookupOfFreedom,
      productionLookupOfSandboxAccount: productionLookupOfSandbox,
      sandboxLookupOfSandboxAccount: sandboxLookupOfSandbox ? {
        tenant_id: sandboxLookupOfSandbox.tenant_id,
        environment: sandboxLookupOfSandbox.environment,
      } : null,
      productionLookupOfFreedomAccount: productionLookupOfFreedom ? {
        tenant_id: productionLookupOfFreedom.tenant_id,
        environment: productionLookupOfFreedom.environment,
      } : null,
      fallbackUsed: false,
    },
    sweep: await sweepUnchanged(client),
  };
};

const webhookReceipts = async (client, eventIds = []) => {
  const ids = Array.isArray(eventIds) ? eventIds.map(String).filter(Boolean) : [];
  if (!ids.length) return { ok: true, rows: [] };
  const rows = (await client.query(
    `SELECT id, provider, external_event_id, event_type, mapped_tenant_id, mapped_internal_id,
            dry_run, received_at
       FROM public.aws_provider_webhook_receipts
      WHERE provider = 'moov'
        AND (
          external_event_id = ANY($1::text[])
          OR mapped_internal_id::text = ANY($1::text[])
        )
      ORDER BY received_at DESC NULLS LAST`,
    [ids],
  )).rows;
  let recentProductionAccountWebhookMutations = 0;
  let recentSandboxAccountWebhookMutations = [];
  try {
    recentProductionAccountWebhookMutations = (await client.query(
      `SELECT count(*)::int AS n
         FROM public.payment_provider_accounts
        WHERE provider = 'moov' AND environment = 'production'
          AND last_webhook_event_at > now() - interval '15 minutes'`,
    )).rows[0]?.n || 0;
    recentSandboxAccountWebhookMutations = (await client.query(
      `SELECT id, tenant_id, environment, provider_account_id, last_webhook_event_type, last_webhook_event_at
         FROM public.payment_provider_accounts
        WHERE provider = 'moov' AND environment = 'sandbox'
          AND last_webhook_event_at > now() - interval '15 minutes'
        ORDER BY last_webhook_event_at DESC NULLS LAST
        LIMIT 5`,
    )).rows;
  } catch {
    recentProductionAccountWebhookMutations = null;
  }
  const intents = (await client.query(
    `SELECT count(*)::int AS n FROM public.payment_transfers
      WHERE created_at > now() - interval '15 minutes'`,
  )).rows[0];
  return {
    ok: true,
    rows,
    recentProductionAccountWebhookMutations,
    recentSandboxAccountWebhookMutations,
    recentPaymentTransfersCreated: intents?.n || 0,
  };
};

const linkObjects = async (client, body = {}) => {
  const tenantId = body.tenantId;
  if (!tenantId || tenantId === FREEDOM || tenantId === C1C) return fail('refused_production_tenant');
  const unused = await unusedProductionAccount(client, tenantId);
  const ids = [
    body.accountId,
    body.walletId,
    body.bankId,
    body.bankPmId,
    body.recipientAccountId,
    body.recipientBankId,
    body.recipientPmId,
  ].filter(Boolean).map((id) => String(id).toLowerCase());
  if (ids.some((id) => PRODUCTION_IDS.has(id))) {
    return fail('production_object_refused', { hits: ids.filter((id) => PRODUCTION_IDS.has(id)) });
  }
  if (unused?.provider_account_id && ids.includes(String(unused.provider_account_id).toLowerCase())) {
    return fail('unused_production_row_refused', { unusedProductionAccountId: unused.provider_account_id });
  }
  const displayName = body.displayName || 'ChecksOps Pipeline Test';
  if (body.accountId) {
    await client.query(
      `INSERT INTO public.payment_provider_accounts (
          tenant_id, provider, environment, provider_account_id, account_type, display_name,
          onboarding_status, verification_status, can_send_payments, can_receive_payments
        ) VALUES (
          $1::uuid, 'moov', 'sandbox', $2, 'business', $3,
          'completed', 'verified', true, true
        )
        ON CONFLICT (tenant_id, provider, environment) DO UPDATE SET
          provider_account_id = EXCLUDED.provider_account_id,
          display_name = EXCLUDED.display_name,
          onboarding_status = EXCLUDED.onboarding_status,
          verification_status = EXCLUDED.verification_status,
          can_send_payments = true,
          can_receive_payments = true,
          updated_at = now()`,
      [tenantId, body.accountId, displayName],
    );
  }
  if (body.walletId) {
    const available = Number.isFinite(Number(body.availableCents)) ? Number(body.availableCents) : 0;
    const pending = Number.isFinite(Number(body.pendingCents)) ? Number(body.pendingCents) : 0;
    await client.query(
      `INSERT INTO public.payment_wallets (
          tenant_id, provider, environment, wallet_type, provider_wallet_id, status, available_cents, pending_cents
        ) VALUES (
          $1::uuid, 'moov', 'sandbox', 'operating', $2, 'active', $3, $4
        )
        ON CONFLICT (tenant_id, provider, environment, wallet_type) DO UPDATE SET
          provider_wallet_id = EXCLUDED.provider_wallet_id,
          status = 'active',
          available_cents = EXCLUDED.available_cents,
          pending_cents = EXCLUDED.pending_cents,
          updated_at = now()`,
      [tenantId, body.walletId, available, pending],
    );
  }
  if (body.bankId) {
    await client.query(
      `INSERT INTO public.payment_provider_methods (
          tenant_id, provider, environment, provider_account_id, provider_bank_account_id,
          provider_payment_method_id, bank_name, last_four, verification_status
        ) VALUES (
          $1::uuid, 'moov', 'sandbox', $2, $3, $4, $5, $6, $7
        )
        ON CONFLICT DO NOTHING`,
      [
        tenantId,
        body.accountId,
        body.bankId,
        body.bankPmId || null,
        body.bankName || 'Moov Test Bank',
        body.lastFour || '0000',
        body.bankVerified === false ? 'unverified' : 'verified',
      ],
    );
    if (body.bankPmId) {
      await client.query(
        `UPDATE public.payment_provider_methods
            SET provider_payment_method_id = COALESCE(provider_payment_method_id, $3),
                verification_status = $4,
                bank_name = COALESCE($5, bank_name),
                last_four = COALESCE($6, last_four)
          WHERE tenant_id = $1::uuid
            AND provider = 'moov'
            AND environment = 'sandbox'
            AND provider_bank_account_id = $2`,
        [
          tenantId,
          body.bankId,
          body.bankPmId,
          body.bankVerified === false ? 'unverified' : 'verified',
          body.bankName || null,
          body.lastFour || null,
        ],
      );
    }
  }
  if (body.recipientAccountId) {
    const existing = (await client.query(
      `SELECT id FROM public.external_payment_recipients
        WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'sandbox'
          AND provider_account_id = $2
        ORDER BY created_at DESC NULLS LAST LIMIT 1`,
      [tenantId, body.recipientAccountId],
    )).rows[0];
    const recipient = existing || (await client.query(
      `INSERT INTO public.external_payment_recipients (
          tenant_id, provider, environment, provider_account_id, display_name, onboarding_status
        ) VALUES (
          $1::uuid, 'moov', 'sandbox', $2, $3, 'completed'
        )
        RETURNING id`,
      [tenantId, body.recipientAccountId, body.recipientName || 'Sandbox Recipient'],
    )).rows[0];
    if (body.recipientBankId) {
      await client.query(
        `INSERT INTO public.payment_provider_methods (
            tenant_id, provider, environment, provider_account_id, provider_bank_account_id,
            provider_payment_method_id, external_recipient_id, bank_name, last_four, verification_status
          ) VALUES (
            $1::uuid, 'moov', 'sandbox', $2, $3, $4, $5::uuid, $6, $7, 'verified'
          )
          ON CONFLICT DO NOTHING`,
        [
          tenantId,
          body.recipientAccountId,
          body.recipientBankId,
          body.recipientPmId || null,
          recipient.id,
          body.recipientBankName || 'Moov Test Bank',
          body.recipientLastFour || '0000',
        ],
      );
    }
  }
  const objects = await tenantObjects(client, tenantId, 'sandbox');
  return {
    ok: objects.productionIdHits.length === 0,
    error: objects.productionIdHits.length ? 'production_object_linked' : null,
    objects,
    environment: 'sandbox',
    unusedProductionReused: false,
  };
};

const intentCountFor = async (client, tenantId, idempotencyKey) => {
  const matching = (await client.query(
    `SELECT count(*)::int AS n FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'sandbox' AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  )).rows[0]?.n || 0;
  const funding = (await client.query(
    `SELECT count(*)::int AS n FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'sandbox'
        AND leg_role = 'wallet_funding' AND amount_cents = 1`,
    [tenantId],
  )).rows[0]?.n || 0;
  const production = (await client.query(
    `SELECT count(*)::int AS n FROM public.payment_transfers
      WHERE environment = 'production' AND created_at > now() - interval '2 hours'`,
  )).rows[0]?.n || 0;
  const freedom = (await client.query(
    `SELECT count(*)::int AS n FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND created_at > now() - interval '2 hours'`,
    [FREEDOM],
  )).rows[0]?.n || 0;
  return { matching, funding, recentProduction: production, recentFreedom: freedom };
};

const persistFundingIntent = async (client, body = {}) => {
  const tenantId = body.tenantId;
  if (!tenantId || tenantId === FREEDOM || tenantId === C1C) return fail('refused_production_tenant');
  if (tenantId !== PIPELINE) return fail('undesignated_tenant', { tenantId });
  const tenant = (await client.query(
    `SELECT id, name, slug, moov_environment FROM public.tenants WHERE id = $1::uuid`,
    [tenantId],
  )).rows[0];
  if (!tenant) return fail('tenant_not_found');
  if (tenant.moov_environment !== 'sandbox') return fail('tenant_not_sandbox', { environment: tenant.moov_environment });
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!idempotencyKey) return fail('idempotency_required');
  if (!idempotencyKey.includes('sandbox') || !idempotencyKey.includes(tenantId) || !idempotencyKey.includes('wallet_funding')) {
    return fail('idempotency_scope_invalid', { idempotencyKey });
  }
  const ids = [body.accountId, body.bankId, body.walletId, body.sourcePaymentMethodId, body.destinationPaymentMethodId]
    .filter(Boolean)
    .map((id) => String(id).toLowerCase());
  if (ids.some((id) => PRODUCTION_IDS.has(id))) {
    return fail('production_object_refused', { hits: ids.filter((id) => PRODUCTION_IDS.has(id)) });
  }
  if (body.accountId && String(body.accountId).toLowerCase() !== SANDBOX_ACCOUNT) {
    return fail('sandbox_account_mismatch');
  }
  if (body.bankId && String(body.bankId).toLowerCase() !== SANDBOX_BANK) {
    return fail('sandbox_bank_mismatch');
  }
  if (body.walletId && String(body.walletId).toLowerCase() !== SANDBOX_WALLET) {
    return fail('sandbox_wallet_mismatch');
  }
  const objects = await tenantObjects(client, tenantId, 'sandbox');
  if (String(objects.account?.provider_account_id || '').toLowerCase() !== SANDBOX_ACCOUNT) {
    return fail('sandbox_account_unlinked');
  }
  if (String(objects.wallet?.provider_wallet_id || '').toLowerCase() !== SANDBOX_WALLET) {
    return fail('sandbox_wallet_unlinked');
  }
  const fundingBank = (objects.banks || []).find((row) => String(row.provider_bank_account_id || '').toLowerCase() === SANDBOX_BANK);
  if (!fundingBank) return fail('sandbox_bank_unlinked');
  const existing = (await client.query(
    `SELECT * FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND idempotency_key = $2
      LIMIT 1`,
    [tenantId, idempotencyKey],
  )).rows[0] || null;
  if (existing) {
    const counts = await intentCountFor(client, tenantId, idempotencyKey);
    return {
      ok: true,
      reused: true,
      created: false,
      intent: existing,
      intentCount: counts.matching,
      fundingIntentCount: counts.funding,
      recentProductionTransfers: counts.recentProduction,
      recentFreedomTransfers: counts.recentFreedom,
      sweep: await sweepUnchanged(client),
      freedomEnvironment: (await freedomRow(client))?.moov_environment,
    };
  }
  let inserted;
  try {
    inserted = (await client.query(
      `INSERT INTO public.payment_transfers (
          tenant_id, provider, environment, status, idempotency_key, amount_cents,
          platform_fee_cents, net_amount_cents, speed, description,
          source_tenant_account_id, source_payment_method_id,
          wallet_id, leg_role, provider_metadata, created_by
        ) VALUES (
          $1::uuid, 'moov', 'sandbox', 'planned', $2, 1,
          0, 1, 'standard', 'M7.9E sandbox BANK to WALLET 0.01',
          $3, $4::uuid, $5::uuid, 'wallet_funding', $6::jsonb, $7::uuid
        )
        RETURNING *`,
      [
        tenantId,
        idempotencyKey,
        SANDBOX_ACCOUNT,
        fundingBank.id,
        objects.wallet.id,
        JSON.stringify(body.providerMetadata || {
          phase: 'M7.9E',
          operation: 'sandbox_bank_to_wallet',
          environment: 'sandbox',
          account_id: SANDBOX_ACCOUNT,
          bank_id: SANDBOX_BANK,
          wallet_id: SANDBOX_WALLET,
          source_payment_method_id: body.sourcePaymentMethodId || null,
          destination_payment_method_id: body.destinationPaymentMethodId || null,
          provider_idempotency_key: body.providerIdempotencyKey || null,
        }),
        ACTOR,
      ],
    )).rows[0];
  } catch (error) {
    if (String(error?.code) === '23505') {
      const raced = (await client.query(
        `SELECT * FROM public.payment_transfers
          WHERE tenant_id = $1::uuid AND idempotency_key = $2 LIMIT 1`,
        [tenantId, idempotencyKey],
      )).rows[0];
      const counts = await intentCountFor(client, tenantId, idempotencyKey);
      return {
        ok: true,
        reused: true,
        created: false,
        intent: raced,
        intentCount: counts.matching,
        fundingIntentCount: counts.funding,
        recentProductionTransfers: counts.recentProduction,
        recentFreedomTransfers: counts.recentFreedom,
        sweep: await sweepUnchanged(client),
        freedomEnvironment: (await freedomRow(client))?.moov_environment,
      };
    }
    throw error;
  }
  const counts = await intentCountFor(client, tenantId, idempotencyKey);
  return {
    ok: true,
    reused: false,
    created: true,
    intent: inserted,
    intentCount: counts.matching,
    fundingIntentCount: counts.funding,
    recentProductionTransfers: counts.recentProduction,
    recentFreedomTransfers: counts.recentFreedom,
    sweep: await sweepUnchanged(client),
    freedomEnvironment: (await freedomRow(client))?.moov_environment,
  };
};

const updateFundingIntent = async (client, body = {}) => {
  const tenantId = body.tenantId;
  const intentId = body.intentId;
  if (!tenantId || tenantId === FREEDOM || tenantId === C1C) return fail('refused_production_tenant');
  if (tenantId !== PIPELINE) return fail('undesignated_tenant', { tenantId });
  if (!intentId) return fail('intent_id_required');
  const productionHits = [body.providerTransferId].filter((id) => PRODUCTION_IDS.has(String(id || '').toLowerCase()));
  if (productionHits.length) return fail('production_object_refused', { hits: productionHits });
  const existing = (await client.query(
    `SELECT * FROM public.payment_transfers
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = 'sandbox'
      LIMIT 1`,
    [intentId, tenantId],
  )).rows[0];
  if (!existing) return fail('intent_not_found');
  const metadata = {
    ...(existing.provider_metadata && typeof existing.provider_metadata === 'object' ? existing.provider_metadata : {}),
    ...(body.providerMetadata || {}),
  };
  const updated = (await client.query(
    `UPDATE public.payment_transfers SET
        provider_transfer_id = COALESCE($3, provider_transfer_id),
        provider_status = COALESCE($4, provider_status),
        status = COALESCE($5, status),
        provider_metadata = $6::jsonb,
        submitted_at = CASE WHEN $7::boolean THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
        failure_reason = COALESCE($8, failure_reason),
        completed_at = CASE
          WHEN $9::timestamptz IS NOT NULL THEN COALESCE(completed_at, $9::timestamptz)
          ELSE completed_at
        END,
        updated_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = 'sandbox'
      RETURNING *`,
    [
      intentId,
      tenantId,
      body.providerTransferId || null,
      body.providerStatus || null,
      body.status || null,
      JSON.stringify(metadata),
      body.markSubmitted === true,
      body.failureReason || null,
      body.completedAt || null,
    ],
  )).rows[0];
  const counts = await intentCountFor(client, tenantId, existing.idempotency_key);
  return {
    ok: true,
    intent: updated,
    intentCount: counts.matching,
    fundingIntentCount: counts.funding,
    recentProductionTransfers: counts.recentProduction,
    recentFreedomTransfers: counts.recentFreedom,
  };
};

const verifyFundingIntent = async (client, body = {}) => {
  const tenantId = body.tenantId || PIPELINE;
  const idempotencyKey = body.idempotencyKey || null;
  const tenant = (await client.query(
    `SELECT id, name, slug, moov_environment FROM public.tenants WHERE id = $1::uuid`,
    [tenantId],
  )).rows[0];
  const freedom = await freedomRow(client);
  const sweep = await sweepUnchanged(client);
  const intent = idempotencyKey
    ? (await client.query(
      `SELECT * FROM public.payment_transfers
        WHERE tenant_id = $1::uuid AND idempotency_key = $2
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, idempotencyKey],
    )).rows[0] || null
    : (await client.query(
      `SELECT * FROM public.payment_transfers
        WHERE tenant_id = $1::uuid AND environment = 'sandbox' AND leg_role = 'wallet_funding'
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    )).rows[0] || null;
  const counts = await intentCountFor(client, tenantId, intent?.idempotency_key || idempotencyKey || '');
  const objects = await tenantObjects(client, tenantId, 'sandbox');
  return {
    ok: tenant?.moov_environment === 'sandbox'
      && freedom?.moov_environment === 'production'
      && objects.productionIdHits.length === 0
      && counts.recentProduction === 0
      && counts.recentFreedom === 0,
    tenant,
    freedomEnvironment: freedom?.moov_environment,
    freedomChanged: false,
    sweep,
    sweepChanged: false,
    intent,
    intentCount: counts.matching,
    fundingIntentCount: counts.funding,
    recentProductionTransfers: counts.recentProduction,
    recentFreedomTransfers: counts.recentFreedom,
    sandbox: objects,
  };
};

const listSandboxHistory = async (client) => {
  const freedom = await freedomRow(client);
  const sweep = await sweepUnchanged(client);
  const sandboxTransfers = (await client.query(
    `SELECT t.id, t.tenant_id, tn.name AS tenant_name, tn.slug,
            t.status, t.amount_cents, t.provider_transfer_id, t.provider_status,
            t.source_tenant_account_id, t.source_payment_method_id,
            t.destination_payment_method_id, t.wallet_id, t.leg_role, t.speed,
            t.selected_rail, t.description, t.created_at, t.submitted_at,
            t.completed_at, t.failure_reason
       FROM public.payment_transfers t
       JOIN public.tenants tn ON tn.id = t.tenant_id
      WHERE t.provider = 'moov' AND t.environment = 'sandbox'
      ORDER BY t.created_at DESC
      LIMIT 50`,
  )).rows;
  const fundingRequests = (await client.query(
    `SELECT r.id, r.tenant_id, r.status, r.requested_amount_cents, r.moov_transfer_id,
            r.moov_account_id, r.moov_wallet_id, r.source_payment_method_id,
            r.transfer_id, r.created_at, r.completed_at, r.funds_available_at,
            t.environment AS transfer_environment
       FROM public.wallet_funding_requests r
       LEFT JOIN public.payment_transfers t ON t.id = r.transfer_id
      WHERE t.environment = 'sandbox'
         OR (
           t.id IS NULL
           AND r.moov_account_id IS NOT NULL
           AND lower(r.moov_account_id::text) = $1
         )
      ORDER BY r.created_at DESC
      LIMIT 50`,
    [SANDBOX_ACCOUNT],
  )).rows;
  const sandboxAccounts = (await client.query(
    `SELECT a.tenant_id, tn.name AS tenant_name, tn.slug, a.provider_account_id,
            a.environment, a.onboarding_status, a.created_at
       FROM public.payment_provider_accounts a
       JOIN public.tenants tn ON tn.id = a.tenant_id
      WHERE a.provider = 'moov' AND a.environment = 'sandbox'
      ORDER BY a.created_at DESC NULLS LAST
      LIMIT 20`,
  )).rows;
  const productionHits = sandboxTransfers.filter((row) => PRODUCTION_IDS.has(String(row.provider_transfer_id || '').toLowerCase())
    || PRODUCTION_IDS.has(String(row.source_tenant_account_id || '').toLowerCase()));
  return {
    ok: freedom?.moov_environment === 'production' && productionHits.length === 0,
    readOnly: true,
    freedomEnvironment: freedom?.moov_environment,
    freedomChanged: false,
    sweep,
    sweepChanged: false,
    sandboxTransfers,
    fundingRequests,
    sandboxAccounts,
    productionObjectHits: productionHits.length,
  };
};

const diagnoseFundingReconcile = async (client, body = {}) => {
  const tenantId = body.tenantId || PIPELINE;
  const transferId = String(body.transferId || '');
  const intentId = String(body.intentId || '');
  if (tenantId === FREEDOM || tenantId === C1C) return fail('refused_production_tenant');
  if (tenantId !== PIPELINE) return fail('undesignated_tenant', { tenantId });
  const freedom = await freedomRow(client);
  const sweep = await sweepUnchanged(client);
  const objects = await tenantObjects(client, tenantId, 'sandbox');
  const intent = intentId
    ? (await client.query(
      `SELECT * FROM public.payment_transfers
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = 'sandbox'
        LIMIT 1`,
      [intentId, tenantId],
    )).rows[0] || null
    : null;
  const events = (await client.query(
    `SELECT id, provider, environment, tenant_id, transfer_id, provider_transfer_id,
            event_type, previous_status, new_status, created_at
       FROM public.payment_event_log
      WHERE tenant_id = $1::uuid
        AND (
          provider_transfer_id = $2
          OR transfer_id = $3::uuid
        )
      ORDER BY created_at DESC
      LIMIT 20`,
    [tenantId, transferId, intentId || '00000000-0000-0000-0000-000000000000'],
  )).rows;
  const sandboxAccountId = objects.account?.id || null;
  const tenantReceipts = (await client.query(
    `SELECT id, provider, external_event_id, event_type, mapped_tenant_id,
            mapped_internal_id, dry_run, received_at
       FROM public.aws_provider_webhook_receipts
      WHERE provider = 'moov'
        AND received_at > now() - interval '48 hours'
        AND (
          mapped_tenant_id = $1::uuid
          OR ($2::uuid IS NOT NULL AND mapped_internal_id = $2::uuid)
        )
      ORDER BY received_at DESC NULLS LAST
      LIMIT 50`,
    [tenantId, sandboxAccountId],
  )).rows;
  const receiptSummary = (await client.query(
    `SELECT mapped_tenant_id, event_type, dry_run, count(*)::int AS n
       FROM public.aws_provider_webhook_receipts
      WHERE provider = 'moov' AND received_at > now() - interval '48 hours'
      GROUP BY 1, 2, 3
      ORDER BY n DESC
      LIMIT 30`,
  )).rows;
  const transferIdReceipts = transferId
    ? (await client.query(
      `SELECT id, external_event_id, event_type, mapped_tenant_id, mapped_internal_id, dry_run, received_at
         FROM public.aws_provider_webhook_receipts
        WHERE provider = 'moov'
          AND (
            external_event_id = $1
            OR mapped_internal_id::text = $1
          )
        ORDER BY received_at DESC NULLS LAST
        LIMIT 20`,
      [transferId],
    )).rows
    : [];
  return {
    ok: freedom?.moov_environment === 'production',
    readOnly: true,
    freedomEnvironment: freedom?.moov_environment,
    freedomChanged: false,
    sweep,
    sweepChanged: false,
    intent,
    events,
    tenantReceipts,
    transferIdReceipts,
    receiptSummary,
    sandboxAccountId,
    rdsWallet: objects.wallet || null,
  };
};

const verify = async (client, tenantId) => {
  const freedom = await freedomRow(client);
  const tenant = (await client.query(
    `SELECT id, name, slug, moov_environment, is_test_account FROM public.tenants WHERE id = $1::uuid`,
    [tenantId],
  )).rows[0];
  const sandbox = await tenantObjects(client, tenantId, 'sandbox');
  const production = await tenantObjects(client, tenantId, 'production');
  const audit = (await client.query(
    `SELECT tenant_id, event_type, previous_status, new_status, provider_metadata
       FROM public.payment_event_log
      WHERE tenant_id = $1::uuid AND event_type = 'moov_environment.changed'
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  )).rows[0] || null;
  const uniq = await uniqueness(client);
  return {
    ok: tenant?.moov_environment === 'sandbox'
      && freedom?.moov_environment === 'production'
      && sandbox.productionIdHits.length === 0,
    tenant,
    freedomEnvironment: freedom?.moov_environment,
    sandbox,
    productionIgnored: {
      account: Boolean(production.account?.provider_account_id),
      wallet: Boolean(production.wallet?.provider_wallet_id),
    },
    audit,
    uniqueness: uniq,
    sweep: await sweepUnchanged(client),
  };
};

export const handler = async (event = {}) => {
  const step = event.step || 'inspect';
  let client;
  try {
    client = await connect();
    if (step === 'inspect') return await inspect(client);
    if (step === 'apply_sql77') return await applySql77(client);
    if (step === 'apply_sql78') return await applySql78(client);
    if (step === 'create_tenant') return await createDedicatedTenant(client);
    if (step === 'switch') return await switchTenant(client, event.tenantId);
    if (step === 'link_objects') return await linkObjects(client, event);
    if (step === 'verify') return await verify(client, event.tenantId);
    if (step === 'object_proof') return await objectProof(client, event.tenantId);
    if (step === 'webhook_receipts') return await webhookReceipts(client, event.eventIds || []);
    if (step === 'persist_funding_intent') return await persistFundingIntent(client, event);
    if (step === 'update_funding_intent') return await updateFundingIntent(client, event);
    if (step === 'verify_funding_intent') return await verifyFundingIntent(client, event);
    if (step === 'list_sandbox_history') return await listSandboxHistory(client);
    if (step === 'diagnose_funding_reconcile') return await diagnoseFundingReconcile(client, event);
    if (step === 'reconcile_funding_parity') return await reconcileFundingParity(client, event);
    return fail('unknown_step', { step });
  } catch (error) {
    return fail(String(error?.message || error).slice(0, 400), { step });
  } finally {
    try { await client?.end(); } catch { /* ignore */ }
  }
};
