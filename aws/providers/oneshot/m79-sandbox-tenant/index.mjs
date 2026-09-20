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
          'aws_moov_set_tenant_environment'
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
  if (!Array.isArray(eventIds) || !eventIds.length) return { ok: true, rows: [] };
  const rows = (await client.query(
    `SELECT id, provider, external_event_id, event_type, mapped_tenant_id, mapped_internal_id,
            dry_run, received_at
       FROM public.aws_provider_webhook_receipts
      WHERE provider = 'moov' AND external_event_id = ANY($1::text[])
      ORDER BY received_at DESC NULLS LAST`,
    [eventIds.map(String)],
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
          $1::uuid, 'moov', 'sandbox', $2, $3, $4, $5, $6, 'verified'
        )
        ON CONFLICT DO NOTHING`,
      [tenantId, body.accountId, body.bankId, body.bankPmId || null, body.bankName || 'Moov Test Bank', body.lastFour || '0000'],
    );
    if (body.bankPmId) {
      await client.query(
        `UPDATE public.payment_provider_methods
            SET provider_payment_method_id = COALESCE(provider_payment_method_id, $4),
                verification_status = 'verified',
                bank_name = COALESCE($5, bank_name),
                last_four = COALESCE($6, last_four)
          WHERE tenant_id = $1::uuid
            AND provider = 'moov'
            AND environment = 'sandbox'
            AND provider_bank_account_id = $3`,
        [tenantId, body.accountId, body.bankId, body.bankPmId, body.bankName || null, body.lastFour || null],
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
    if (step === 'create_tenant') return await createDedicatedTenant(client);
    if (step === 'switch') return await switchTenant(client, event.tenantId);
    if (step === 'link_objects') return await linkObjects(client, event);
    if (step === 'verify') return await verify(client, event.tenantId);
    if (step === 'object_proof') return await objectProof(client, event.tenantId);
    if (step === 'webhook_receipts') return await webhookReceipts(client, event.eventIds || []);
    return fail('unknown_step', { step });
  } catch (error) {
    return fail(String(error?.message || error).slice(0, 400), { step });
  } finally {
    try { await client?.end(); } catch { /* ignore */ }
  }
};
