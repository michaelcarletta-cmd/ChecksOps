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
const SANDBOX_WALLET_PM = '1eb24c1c-b7ab-45cd-8775-332da40b9647';
const SANDBOX_FUND_PM = '8a0f6ffa-a549-48f5-bb8e-f5b6a9d9cfff';
const SANDBOX_RECIPIENT_ACCOUNT = '90050a69-84f3-41bb-aa30-490ca7e7bf34';
const SANDBOX_RECIPIENT_BANK = '92e17650-94ed-43cb-8bff-14cf506c3988';
const PAYOUT_INTENT_ID = '80f4648b-551c-4ec6-a9fc-921b85bc8320';
const PAYOUT_TRANSFER_ID = 'c2d1078a-0261-4a3b-9782-777fad834af9';
const FUNDING_INTENT_ID = 'b18a96d7-4415-4df8-992f-70d5a17365a9';
const FUNDING_TRANSFER_ID = 'dec24b01-e559-4014-b072-af1ac0e4d013';
const M712_OPERATION_ID = '69704e23-9ddd-52f8-a2b1-d48bdb500926';
const M712_FUNDING_INTENT_ID = '985f487b-74f2-4d9f-8e6f-7cad9ae10c97';
const M712_PAYOUT_INTENT_ID = 'df6e3d55-ccc9-43cd-b275-8cde8e24c343';
const M712_FUNDING_TRANSFER_ID = 'e42635e8-7a75-4d25-ad2f-dd0e5696372d';
const M712_PAYOUT_TRANSFER_ID = 'c7026476-42d3-43af-bfd3-6f5c4d6480e7';
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
            provider_transfer_id, provider_metadata, leg_role, amount_cents
       FROM public.payment_transfers
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = 'sandbox'
      LIMIT 1`,
    [intentId, tenantId],
  )).rows[0];
  if (!intentBefore) return fail('intent_not_found');
  if (String(intentBefore.leg_role || '') !== 'wallet_funding') {
    return fail('intent_leg_mismatch', { leg_role: intentBefore.leg_role });
  }
  if (String(intentId).toLowerCase() === PAYOUT_INTENT_ID) return fail('payout_intent_refused');
  if (String(transferId).toLowerCase() === PAYOUT_TRANSFER_ID) return fail('payout_transfer_refused');
  if (String(intentBefore.provider_transfer_id || '').toLowerCase() !== String(transferId).toLowerCase()) {
    return fail('transfer_id_mismatch');
  }

  const providerStatus = String(body.providerStatus || '').toLowerCase();
  const pendingStatuses = ['pending', 'processing', 'queued', 'originated', 'submitted', 'created'];
  const failedStatuses = ['failed', 'returned', 'canceled', 'cancelled'];
  if (pendingStatuses.includes(providerStatus)) {
    return {
      ok: true,
      skipped: 'pending',
      mode: 'pending_stop',
      createdPaymentTransfer: false,
      liveProviderPosted: false,
      intent: intentBefore,
      fundingUnchanged: true,
      rdsWallet: (await tenantObjects(client, tenantId, 'sandbox')).wallet,
      freedomEnvironment: (await freedomRow(client))?.moov_environment,
      freedomChanged: false,
      sweep: await sweepUnchanged(client),
      sweepChanged: false,
    };
  }
  const nextStatus = failedStatuses.includes(providerStatus)
    ? (providerStatus === 'cancelled' ? 'canceled' : providerStatus)
    : 'completed';

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

  await client.query('BEGIN');
  let recon;
  let wallet;
  try {
    await client.query("SELECT set_config('request.moov_get_reconcile', '1', true)");
    recon = (await client.query(
      `SELECT * FROM public.aws_moov_reconcile_existing_transfer(
         $1, $2, $3, $4::timestamptz, $5, $6, $7::jsonb, $8)`,
      [
        transferId,
        nextStatus,
        body.providerStatus || nextStatus,
        nextStatus === 'completed' ? completedAt : null,
        'moov.parity_fill',
        intentBefore.status,
        JSON.stringify({
          source: 'moov_get',
          completedOn: nextStatus === 'completed' ? completedAt : null,
          phase: body.phase || 'm79i',
          failureReason: body.failureReason || null,
        }),
        'sandbox',
      ],
    )).rows[0];

    wallet = (await client.query(
      `SELECT * FROM public.aws_moov_reconcile_wallet_cache($1, $2, $3::bigint, $4::bigint, $5::uuid, $6::jsonb)`,
      [
        walletId,
        'sandbox',
        availableCents,
        pendingCents,
        tenantId,
        JSON.stringify({ source: 'moov_get', phase: body.phase || 'm79i' }),
      ],
    )).rows[0] || null;
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep original */ }
    throw error;
  }

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
  const completedOk = nextStatus === 'completed'
    && String(intentAfter?.status) === 'completed'
    && String(intentAfter?.provider_status).toLowerCase() === 'completed'
    && intentAfter?.failure_reason == null;
  const failedOk = nextStatus !== 'completed'
    && String(intentAfter?.status) === nextStatus;
  return {
    ok: (completedOk || failedOk)
      && Number(wallet?.available_cents) === Number(availableCents)
      && Number(wallet?.pending_cents) === Number(pendingCents)
      && Number(historyAfter?.n || 0) >= Number(historyBefore?.n || 0)
      && failureHistoryAfter.length >= failureHistoryBefore.length
      && freedom?.moov_environment === 'production',
    mode: 'update_existing_only',
    nextStatus,
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

const snapshotFundingIntent = async (client) => (await client.query(
  `SELECT id, tenant_id, environment, status, provider_status, provider_transfer_id,
          completed_at, failure_reason, amount_cents, leg_role, updated_at
     FROM public.payment_transfers
    WHERE id = $1::uuid AND environment = 'sandbox'
    LIMIT 1`,
  [FUNDING_INTENT_ID],
)).rows[0] || null;

const fundingUnchanged = (before, after) => Boolean(
  before
  && after
  && String(before.id) === String(after.id)
  && String(before.status) === String(after.status)
  && String(before.provider_status) === String(after.provider_status)
  && String(before.provider_transfer_id || '') === String(after.provider_transfer_id || '')
  && String(before.completed_at || '') === String(after.completed_at || '')
  && String(before.failure_reason || '') === String(after.failure_reason || '')
  && String(before.leg_role) === 'wallet_funding'
  && Number(before.amount_cents) === 1
  && String(before.provider_transfer_id || '').toLowerCase() === FUNDING_TRANSFER_ID
);

const reconcilePayoutParity = async (client, body = {}) => {
  const tenantId = body.tenantId;
  const intentId = String(body.intentId || '');
  const transferId = String(body.providerTransferId || '');
  const walletId = body.providerWalletId;
  const providerStatus = String(body.providerStatus || '').toLowerCase();
  const completedAt = body.completedAt || null;
  const availableCents = body.availableCents;
  const pendingCents = body.pendingCents;
  if (!tenantId || tenantId === FREEDOM || tenantId === C1C) return fail('refused_production_tenant');
  if (tenantId !== PIPELINE) return fail('undesignated_tenant', { tenantId });
  if (!intentId || !transferId) return fail('intent_and_transfer_required');
  if (intentId.toLowerCase() === FUNDING_INTENT_ID) return fail('funding_intent_refused');
  if (transferId.toLowerCase() === FUNDING_TRANSFER_ID) return fail('funding_transfer_refused');
  if (intentId.toLowerCase() !== PAYOUT_INTENT_ID) return fail('payout_intent_mismatch');
  if (transferId.toLowerCase() !== PAYOUT_TRANSFER_ID) return fail('payout_transfer_mismatch');
  if (!walletId || String(walletId).toLowerCase() !== SANDBOX_WALLET) return fail('wallet_id_mismatch');
  const productionHits = [transferId, walletId, intentId].filter((id) => PRODUCTION_IDS.has(String(id || '').toLowerCase()));
  if (productionHits.length) return fail('production_object_refused', { hits: productionHits });

  const freedomBefore = await freedomRow(client);
  const sweepBefore = await sweepUnchanged(client);
  const fundingBefore = await snapshotFundingIntent(client);
  const intentBefore = (await client.query(
    `SELECT id, tenant_id, environment, status, provider_status, completed_at, failure_reason,
            provider_transfer_id, provider_metadata, leg_role, amount_cents
       FROM public.payment_transfers
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = 'sandbox'
      LIMIT 1`,
    [intentId, tenantId],
  )).rows[0];
  if (!intentBefore) return fail('intent_not_found');
  if (String(intentBefore.leg_role || '') !== 'wallet_disbursement') {
    return fail('intent_leg_mismatch', { leg_role: intentBefore.leg_role });
  }
  if (String(intentBefore.provider_transfer_id || '').toLowerCase() !== transferId.toLowerCase()) {
    return fail('transfer_id_mismatch');
  }
  if (Number(intentBefore.amount_cents) !== 1) return fail('amount_mismatch');

  const pendingStatuses = ['pending', 'processing', 'queued', 'originated', 'submitted', 'created'];
  if (pendingStatuses.includes(providerStatus) || (!providerStatus && pendingStatuses.includes(String(intentBefore.status || '').toLowerCase()))) {
    return {
      ok: true,
      skipped: 'pending',
      createdPaymentTransfer: false,
      liveProviderPosted: false,
      intent: intentBefore,
      fundingUnchanged: true,
      funding: fundingBefore,
      freedomEnvironment: freedomBefore?.moov_environment,
      freedomChanged: false,
      sweep: sweepBefore,
      sweepChanged: false,
    };
  }

  const failedStatuses = ['failed', 'returned', 'canceled', 'cancelled'];
  if (failedStatuses.includes(providerStatus)) {
    const updated = await updatePayoutIntent(client, {
      tenantId,
      intentId,
      providerTransferId: transferId,
      providerStatus: body.providerStatus,
      status: providerStatus === 'cancelled' ? 'canceled' : providerStatus,
      failureReason: body.failureReason || providerStatus,
      completedAt: null,
      providerMetadata: {
        source: 'moov_get',
        phase: 'm710a',
        do_not_retry: true,
        failure_detail: body.failureReason || null,
      },
    });
    const fundingAfter = await snapshotFundingIntent(client);
    const freedom = await freedomRow(client);
    const sweep = await sweepUnchanged(client);
    return {
      ok: updated.ok === true && fundingUnchanged(fundingBefore, fundingAfter),
      skipped: false,
      mode: 'update_existing_only',
      createdPaymentTransfer: false,
      liveProviderPosted: false,
      intent: updated.intent,
      fundingUnchanged: fundingUnchanged(fundingBefore, fundingAfter),
      funding: fundingAfter,
      payoutIntentCount: updated.payoutIntentCount,
      fundingIntentCount: updated.fundingIntentCount,
      freedomEnvironment: freedom?.moov_environment,
      freedomChanged: freedomBefore?.moov_environment !== freedom?.moov_environment,
      sweep,
      sweepChanged: String(sweepBefore?.id || '') !== String(sweep?.id || '')
        || String(sweepBefore?.status || '') !== String(sweep?.status || ''),
    };
  }

  if (providerStatus !== 'completed') return fail('unsupported_payout_status', { providerStatus });
  if (!completedAt) return fail('provider_completed_on_missing');

  await client.query('BEGIN');
  let recon;
  let wallet;
  try {
    await client.query("SELECT set_config('request.moov_get_reconcile', '1', true)");
    recon = (await client.query(
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
          phase: 'm710a',
        }),
        'sandbox',
      ],
    )).rows[0];
    wallet = (await client.query(
      `SELECT * FROM public.aws_moov_reconcile_wallet_cache($1, $2, $3::bigint, $4::bigint, $5::uuid, $6::jsonb)`,
      [
        walletId,
        'sandbox',
        availableCents,
        pendingCents,
        tenantId,
        JSON.stringify({ source: 'moov_get', phase: 'm710a' }),
      ],
    )).rows[0] || null;
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep original */ }
    throw error;
  }

  const intentAfter = (await client.query(
    `SELECT id, tenant_id, environment, status, provider_status, completed_at, failure_reason,
            provider_transfer_id, provider_metadata, leg_role, idempotency_key,
            to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at_utc
       FROM public.payment_transfers
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = 'sandbox'
      LIMIT 1`,
    [intentId, tenantId],
  )).rows[0];
  const fundingAfter = await snapshotFundingIntent(client);
  const productionWallet = (await client.query(
    `SELECT id, environment, available_cents, pending_cents, provider_wallet_id
       FROM public.payment_wallets
      WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'production'`,
    [tenantId],
  )).rows;
  const freedom = await freedomRow(client);
  const sweep = await sweepUnchanged(client);
  const objects = await tenantObjects(client, tenantId, 'sandbox');
  const counts = await intentCountFor(client, tenantId, intentAfter?.idempotency_key || '');
  return {
    ok: String(intentAfter?.status) === 'completed'
      && String(intentAfter?.provider_status) === 'completed'
      && intentAfter?.failure_reason == null
      && String(intentAfter?.leg_role) === 'wallet_disbursement'
      && Number(wallet?.available_cents) === Number(availableCents)
      && Number(wallet?.pending_cents) === Number(pendingCents)
      && fundingUnchanged(fundingBefore, fundingAfter)
      && freedom?.moov_environment === 'production',
    recon,
    wallet,
    intentBefore: {
      status: intentBefore.status,
      provider_status: intentBefore.provider_status,
      completed_at: intentBefore.completed_at,
      failure_reason: intentBefore.failure_reason,
      leg_role: intentBefore.leg_role,
    },
    intent: intentAfter,
    fundingUnchanged: fundingUnchanged(fundingBefore, fundingAfter),
    funding: fundingAfter,
    productionWalletRows: productionWallet,
    rdsWallet: objects.wallet,
    payoutIntentCount: counts.payout,
    fundingIntentCount: counts.funding,
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
  const payout = (await client.query(
    `SELECT count(*)::int AS n FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'sandbox'
        AND leg_role = 'wallet_disbursement' AND amount_cents = 1`,
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
  return { matching, funding, payout, recentProduction: production, recentFreedom: freedom };
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
      payoutIntentCount: counts.payout,
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
        payoutIntentCount: counts.payout,
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
    payoutIntentCount: counts.payout,
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
    payoutIntentCount: counts.payout,
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
    payoutIntentCount: counts.payout,
    recentProductionTransfers: counts.recentProduction,
    recentFreedomTransfers: counts.recentFreedom,
    sandbox: objects,
  };
};

const persistPayoutIntent = async (client, body = {}) => {
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
  if (
    !idempotencyKey.includes('sandbox')
    || !idempotencyKey.includes(tenantId)
    || !idempotencyKey.includes('wallet_disbursement')
    || idempotencyKey.includes('wallet_funding')
  ) {
    return fail('idempotency_scope_invalid', { idempotencyKey });
  }
  const ids = [
    body.accountId,
    body.walletId,
    body.recipientAccountId,
    body.recipientBankId,
    body.sourcePaymentMethodId,
    body.destinationPaymentMethodId,
  ].filter(Boolean).map((id) => String(id).toLowerCase());
  if (ids.some((id) => PRODUCTION_IDS.has(id))) {
    return fail('production_object_refused', { hits: ids.filter((id) => PRODUCTION_IDS.has(id)) });
  }
  if (body.accountId && String(body.accountId).toLowerCase() !== SANDBOX_ACCOUNT) {
    return fail('sandbox_account_mismatch');
  }
  if (body.walletId && String(body.walletId).toLowerCase() !== SANDBOX_WALLET) {
    return fail('sandbox_wallet_mismatch');
  }
  if (body.recipientAccountId && String(body.recipientAccountId).toLowerCase() !== SANDBOX_RECIPIENT_ACCOUNT) {
    return fail('sandbox_recipient_mismatch');
  }
  if (body.recipientBankId && String(body.recipientBankId).toLowerCase() !== SANDBOX_RECIPIENT_BANK) {
    return fail('sandbox_recipient_bank_mismatch');
  }
  if (body.sourcePaymentMethodId && String(body.sourcePaymentMethodId).toLowerCase() === SANDBOX_FUND_PM) {
    return fail('funding_pm_refused_as_payout_source');
  }
  if (body.sourcePaymentMethodId && String(body.sourcePaymentMethodId).toLowerCase() === SANDBOX_RECIPIENT_BANK) {
    return fail('recipient_bank_refused_as_source');
  }
  if (body.sourcePaymentMethodId && String(body.sourcePaymentMethodId).toLowerCase() !== SANDBOX_WALLET_PM) {
    return fail('sandbox_wallet_pm_mismatch');
  }
  if (body.destinationPaymentMethodId && String(body.destinationPaymentMethodId).toLowerCase() === SANDBOX_WALLET_PM) {
    return fail('wallet_pm_refused_as_recipient');
  }
  if (body.destinationPaymentMethodId && String(body.destinationPaymentMethodId).toLowerCase() === SANDBOX_FUND_PM) {
    return fail('funding_pm_refused_as_recipient');
  }
  const objects = await tenantObjects(client, tenantId, 'sandbox');
  if (String(objects.account?.provider_account_id || '').toLowerCase() !== SANDBOX_ACCOUNT) {
    return fail('sandbox_account_unlinked');
  }
  if (String(objects.wallet?.provider_wallet_id || '').toLowerCase() !== SANDBOX_WALLET) {
    return fail('sandbox_wallet_unlinked');
  }
  const recipient = (objects.recipients || []).find((row) => (
    String(row.provider_account_id || '').toLowerCase() === SANDBOX_RECIPIENT_ACCOUNT
  ));
  if (!recipient) return fail('sandbox_recipient_unlinked');
  const recipientBank = (objects.banks || []).find((row) => (
    String(row.provider_bank_account_id || '').toLowerCase() === SANDBOX_RECIPIENT_BANK
  ));
  const walletMethod = (objects.banks || []).find((row) => (
    String(row.provider_payment_method_id || '').toLowerCase() === SANDBOX_WALLET_PM
  ));
  const otherPayout = (await client.query(
    `SELECT id, idempotency_key FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'sandbox' AND leg_role = 'wallet_disbursement'
        AND idempotency_key <> $2
      LIMIT 1`,
    [tenantId, idempotencyKey],
  )).rows[0] || null;
  if (otherPayout) return fail('duplicate_payout_intent', { existingId: otherPayout.id });
  const existing = (await client.query(
    `SELECT * FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND idempotency_key = $2
      LIMIT 1`,
    [tenantId, idempotencyKey],
  )).rows[0] || null;
  if (existing) {
    if (String(existing.leg_role || '') !== 'wallet_disbursement') {
      return fail('intent_leg_mismatch', { leg_role: existing.leg_role });
    }
    const counts = await intentCountFor(client, tenantId, idempotencyKey);
    return {
      ok: true,
      reused: true,
      created: false,
      intent: existing,
      intentCount: counts.matching,
      fundingIntentCount: counts.funding,
      payoutIntentCount: counts.payout,
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
          destination_recipient_id, destination_payment_method_id,
          wallet_id, leg_role, provider_metadata, created_by
        ) VALUES (
          $1::uuid, 'moov', 'sandbox', 'planned', $2, 1,
          0, 1, 'standard', 'M7.10 sandbox WALLET to RECIPIENT 0.01',
          $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid, 'wallet_disbursement', $8::jsonb, $9::uuid
        )
        RETURNING *`,
      [
        tenantId,
        idempotencyKey,
        SANDBOX_ACCOUNT,
        walletMethod?.id || null,
        recipient.id,
        recipientBank?.id || null,
        objects.wallet.id,
        JSON.stringify(body.providerMetadata || {
          phase: 'M7.10',
          operation: 'sandbox_wallet_to_recipient',
          environment: 'sandbox',
          account_id: SANDBOX_ACCOUNT,
          wallet_id: SANDBOX_WALLET,
          recipient_account_id: SANDBOX_RECIPIENT_ACCOUNT,
          recipient_bank_id: SANDBOX_RECIPIENT_BANK,
          source_payment_method_id: body.sourcePaymentMethodId || SANDBOX_WALLET_PM,
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
        payoutIntentCount: counts.payout,
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
    payoutIntentCount: counts.payout,
    recentProductionTransfers: counts.recentProduction,
    recentFreedomTransfers: counts.recentFreedom,
    sweep: await sweepUnchanged(client),
    freedomEnvironment: (await freedomRow(client))?.moov_environment,
  };
};

const updatePayoutIntent = async (client, body = {}) => {
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
  if (String(existing.leg_role || '') !== 'wallet_disbursement') {
    return fail('intent_leg_mismatch', { leg_role: existing.leg_role });
  }
  return await updateFundingIntent(client, body);
};

const verifyPayoutIntent = async (client, body = {}) => {
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
        WHERE tenant_id = $1::uuid AND environment = 'sandbox' AND leg_role = 'wallet_disbursement'
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
      && counts.recentFreedom === 0
      && (!intent || String(intent.leg_role || '') === 'wallet_disbursement'),
    tenant,
    freedomEnvironment: freedom?.moov_environment,
    freedomChanged: false,
    sweep,
    sweepChanged: false,
    intent,
    intentCount: counts.matching,
    fundingIntentCount: counts.funding,
    payoutIntentCount: counts.payout,
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
      `SELECT id, tenant_id, environment, status, provider_status, provider_transfer_id,
              failure_reason, provider_metadata,
              completed_at,
              to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at_utc
         FROM public.payment_transfers
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

const diagnosePayoutWebhook = async (client, body = {}) => {
  const tenantId = body.tenantId || PIPELINE;
  const transferId = String(body.transferId || PAYOUT_TRANSFER_ID);
  const intentId = String(body.intentId || PAYOUT_INTENT_ID);
  if (tenantId === FREEDOM || tenantId === C1C) return fail('refused_production_tenant');
  if (tenantId !== PIPELINE) return fail('undesignated_tenant', { tenantId });
  try {
    await client.query("SELECT set_config('request.provider_webhook', '1', true)");
  } catch { /* admin connection; receipts remain readable */ }
  const objects = await tenantObjects(client, tenantId, 'sandbox');
  const sandboxAccountId = objects.account?.id || null;
  const byTransferId = (await client.query(
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
  )).rows;
  const tenantRecent = (await client.query(
    `SELECT id, external_event_id, event_type, mapped_tenant_id, mapped_internal_id, dry_run, received_at
       FROM public.aws_provider_webhook_receipts
      WHERE provider = 'moov'
        AND received_at > now() - interval '7 days'
        AND (
          mapped_tenant_id = $1::uuid
          OR ($2::uuid IS NOT NULL AND mapped_internal_id = $2::uuid)
        )
      ORDER BY received_at DESC NULLS LAST
      LIMIT 50`,
    [tenantId, sandboxAccountId],
  )).rows;
  const transferTyped = (await client.query(
    `SELECT id, external_event_id, event_type, mapped_tenant_id, mapped_internal_id, dry_run, received_at
       FROM public.aws_provider_webhook_receipts
      WHERE provider = 'moov'
        AND received_at > now() - interval '7 days'
        AND event_type ILIKE '%transfer%'
      ORDER BY received_at DESC NULLS LAST
      LIMIT 50`,
  )).rows;
  const events = (await client.query(
    `SELECT id, event_type, previous_status, new_status, provider_transfer_id, created_at
       FROM public.payment_event_log
      WHERE tenant_id = $1::uuid
        AND (provider_transfer_id = $2 OR transfer_id = $3::uuid)
      ORDER BY created_at DESC
      LIMIT 20`,
    [tenantId, transferId, intentId],
  )).rows;
  return {
    ok: true,
    readOnly: true,
    transferId,
    intentId,
    sandboxAccountId,
    receiptsByTransferId: byTransferId,
    tenantRecentReceipts: tenantRecent,
    transferTypedReceipts: transferTyped.slice(0, 20),
    events,
    lookup: {
      storedKey: 'external_event_id = Moov eventID',
      notStored: 'provider_transfer_id',
      mapped_internal_id: sandboxAccountId,
    },
    lookupMiss: byTransferId.length === 0 && (tenantRecent.length > 0 || transferTyped.length > 0),
    getFallbackRequired: true,
    webhookChangeRequired: false,
  };
};

const ORCHESTRATOR_KEY_RE = /^checksops:m(77|712):(wallet_funding|wallet_disbursement):env:sandbox:/;

const orchestratorIntentCounts = async (client, tenantId, operationId, idempotencyKey) => {
  const matching = (await client.query(
    `SELECT count(*)::int AS n FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'sandbox' AND idempotency_key = $2`,
    [tenantId, idempotencyKey || ''],
  )).rows[0]?.n || 0;
  const operation = (await client.query(
    `SELECT leg_role, count(*)::int AS n FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'sandbox'
        AND coalesce(provider_metadata->>'payout_operation_id', '') = $2
      GROUP BY 1`,
    [tenantId, operationId || ''],
  )).rows;
  const funding = (await client.query(
    `SELECT count(*)::int AS n FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'sandbox' AND leg_role = 'wallet_funding'`,
    [tenantId],
  )).rows[0]?.n || 0;
  const payout = (await client.query(
    `SELECT count(*)::int AS n FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'sandbox' AND leg_role = 'wallet_disbursement'`,
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
  return {
    matching,
    operationFunding: operation.find((row) => row.leg_role === 'wallet_funding')?.n || 0,
    operationPayout: operation.find((row) => row.leg_role === 'wallet_disbursement')?.n || 0,
    funding,
    payout,
    recentProduction: production,
    recentFreedom: freedom,
  };
};

const persistOrchestratorIntent = async (client, body = {}) => {
  const tenantId = body.tenantId;
  if (!tenantId || tenantId === FREEDOM || tenantId === C1C) return fail('refused_production_tenant');
  if (tenantId !== PIPELINE) return fail('undesignated_tenant', { tenantId });
  const tenant = (await client.query(
    `SELECT id, name, slug, moov_environment FROM public.tenants WHERE id = $1::uuid`,
    [tenantId],
  )).rows[0];
  if (!tenant) return fail('tenant_not_found');
  if (tenant.moov_environment !== 'sandbox') return fail('tenant_not_sandbox', { environment: tenant.moov_environment });
  const idempotencyKey = String(body.idempotencyKey || body.idempotency_key || '');
  const operationId = String(body.payoutOperationId || body.payout_operation_id || '');
  const leg = String(body.leg_role || body.kind || '');
  if (!ORCHESTRATOR_KEY_RE.test(idempotencyKey)) return fail('idempotency_scope_invalid', { idempotencyKey });
  if (!operationId) return fail('payout_operation_id_required');
  if (leg === 'wallet_funding' && !idempotencyKey.includes('wallet_funding')) {
    return fail('idempotency_scope_invalid', { idempotencyKey });
  }
  if (leg === 'wallet_disbursement' && !idempotencyKey.includes('wallet_disbursement')) {
    return fail('idempotency_scope_invalid', { idempotencyKey });
  }
  if (leg !== 'wallet_funding' && leg !== 'wallet_disbursement') return fail('unknown_leg_role', { leg });
  const ids = [
    body.accountId, body.bankId, body.walletId, body.recipientAccountId, body.recipientBankId,
    body.sourcePaymentMethodId, body.destinationPaymentMethodId, body.providerTransferId,
  ].filter(Boolean).map((id) => String(id).toLowerCase());
  if (ids.some((id) => PRODUCTION_IDS.has(id))) {
    return fail('production_object_refused', { hits: ids.filter((id) => PRODUCTION_IDS.has(id)) });
  }
  if (body.accountId && String(body.accountId).toLowerCase() !== SANDBOX_ACCOUNT) {
    return fail('sandbox_account_mismatch');
  }
  if (body.walletId && String(body.walletId).toLowerCase() !== SANDBOX_WALLET) {
    return fail('sandbox_wallet_mismatch');
  }
  if (leg === 'wallet_funding' && body.bankId && String(body.bankId).toLowerCase() !== SANDBOX_BANK) {
    return fail('sandbox_bank_mismatch');
  }
  if (leg === 'wallet_disbursement' && body.recipientAccountId
    && String(body.recipientAccountId).toLowerCase() !== SANDBOX_RECIPIENT_ACCOUNT) {
    return fail('sandbox_recipient_mismatch');
  }
  const objects = await tenantObjects(client, tenantId, 'sandbox');
  if (String(objects.account?.provider_account_id || '').toLowerCase() !== SANDBOX_ACCOUNT) {
    return fail('sandbox_account_unlinked');
  }
  if (String(objects.wallet?.provider_wallet_id || '').toLowerCase() !== SANDBOX_WALLET) {
    return fail('sandbox_wallet_unlinked');
  }
  const fundingBank = (objects.banks || []).find((row) => String(row.provider_bank_account_id || '').toLowerCase() === SANDBOX_BANK);
  const recipient = (objects.recipients || []).find((row) => (
    String(row.provider_account_id || '').toLowerCase() === SANDBOX_RECIPIENT_ACCOUNT
  ));
  const recipientBank = (objects.banks || []).find((row) => (
    String(row.provider_bank_account_id || '').toLowerCase() === SANDBOX_RECIPIENT_BANK
  ));
  const walletMethod = (objects.banks || []).find((row) => (
    String(row.provider_payment_method_id || '').toLowerCase() === SANDBOX_WALLET_PM
  ));
  if (leg === 'wallet_funding' && !fundingBank) return fail('sandbox_bank_unlinked');
  if (leg === 'wallet_disbursement' && !recipient) return fail('sandbox_recipient_unlinked');
  const existing = (await client.query(
    `SELECT * FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND idempotency_key = $2
      LIMIT 1`,
    [tenantId, idempotencyKey],
  )).rows[0] || null;
  if (existing) {
    const counts = await orchestratorIntentCounts(client, tenantId, operationId, idempotencyKey);
    return {
      ok: true,
      reused: true,
      created: false,
      intent: existing,
      ...counts,
      sweep: await sweepUnchanged(client),
      freedomEnvironment: (await freedomRow(client))?.moov_environment,
    };
  }
  const metadata = {
    phase: 'M7.12',
    payout_operation_id: operationId,
    environment: 'sandbox',
    account_id: SANDBOX_ACCOUNT,
    wallet_id: SANDBOX_WALLET,
    bank_id: leg === 'wallet_funding' ? SANDBOX_BANK : null,
    recipient_account_id: leg === 'wallet_disbursement' ? SANDBOX_RECIPIENT_ACCOUNT : null,
    recipient_bank_id: leg === 'wallet_disbursement' ? SANDBOX_RECIPIENT_BANK : null,
    source_payment_method_id: body.sourcePaymentMethodId || null,
    destination_payment_method_id: body.destinationPaymentMethodId || null,
    provider_idempotency_key: body.providerIdempotencyKey || body.provider_idempotency_key || null,
    ...(body.providerMetadata || body.provider_metadata || {}),
    payout_operation_id: operationId,
    phase: 'M7.12',
  };
  const description = leg === 'wallet_funding'
    ? 'M7.12 sandbox BANK to WALLET 0.01'
    : 'M7.12 sandbox WALLET to RECIPIENT 0.01';
  let inserted;
  try {
    inserted = (await client.query(
      `INSERT INTO public.payment_transfers (
          tenant_id, provider, environment, status, idempotency_key, amount_cents,
          platform_fee_cents, net_amount_cents, speed, description,
          source_tenant_account_id, source_payment_method_id,
          destination_recipient_id, destination_payment_method_id,
          wallet_id, leg_role, provider_metadata, created_by
        ) VALUES (
          $1::uuid, 'moov', 'sandbox', 'planned', $2, 1,
          0, 1, 'standard', $3,
          $4, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9, $10::jsonb, $11::uuid
        )
        RETURNING *`,
      [
        tenantId,
        idempotencyKey,
        description,
        SANDBOX_ACCOUNT,
        leg === 'wallet_funding' ? fundingBank.id : (walletMethod?.id || null),
        leg === 'wallet_disbursement' ? recipient.id : null,
        leg === 'wallet_disbursement' ? (recipientBank?.id || null) : null,
        objects.wallet.id,
        leg,
        JSON.stringify(metadata),
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
      const counts = await orchestratorIntentCounts(client, tenantId, operationId, idempotencyKey);
      return {
        ok: true,
        reused: true,
        created: false,
        intent: raced,
        ...counts,
        sweep: await sweepUnchanged(client),
        freedomEnvironment: (await freedomRow(client))?.moov_environment,
      };
    }
    throw error;
  }
  const counts = await orchestratorIntentCounts(client, tenantId, operationId, idempotencyKey);
  return {
    ok: true,
    reused: false,
    created: true,
    intent: inserted,
    ...counts,
    sweep: await sweepUnchanged(client),
    freedomEnvironment: (await freedomRow(client))?.moov_environment,
  };
};

const getOrchestratorIntent = async (client, body = {}) => {
  const tenantId = body.tenantId || PIPELINE;
  if (tenantId === FREEDOM || tenantId === C1C) return fail('refused_production_tenant');
  if (tenantId !== PIPELINE) return fail('undesignated_tenant', { tenantId });
  const idempotencyKey = String(body.idempotencyKey || body.idempotency_key || '');
  if (!idempotencyKey) return fail('idempotency_required');
  const intent = (await client.query(
    `SELECT * FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'sandbox' AND idempotency_key = $2
      LIMIT 1`,
    [tenantId, idempotencyKey],
  )).rows[0] || null;
  const operationId = body.payoutOperationId || intent?.provider_metadata?.payout_operation_id || '';
  return {
    ok: true,
    intent,
    ...(await orchestratorIntentCounts(client, tenantId, operationId, idempotencyKey)),
    freedomEnvironment: (await freedomRow(client))?.moov_environment,
    sweep: await sweepUnchanged(client),
  };
};

const updateOrchestratorIntent = async (client, body = {}) => {
  const tenantId = body.tenantId || PIPELINE;
  if (tenantId === FREEDOM || tenantId === C1C) return fail('refused_production_tenant');
  if (tenantId !== PIPELINE) return fail('undesignated_tenant', { tenantId });
  if (body.providerTransferId && PRODUCTION_IDS.has(String(body.providerTransferId).toLowerCase())) {
    return fail('production_object_refused');
  }
  const existing = body.intentId
    ? (await client.query(
      `SELECT * FROM public.payment_transfers
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = 'sandbox' LIMIT 1`,
      [body.intentId, tenantId],
    )).rows[0]
    : (await client.query(
      `SELECT * FROM public.payment_transfers
        WHERE tenant_id = $1::uuid AND environment = 'sandbox' AND idempotency_key = $2 LIMIT 1`,
      [tenantId, body.idempotencyKey || body.idempotency_key],
    )).rows[0];
  if (!existing) return fail('intent_not_found');
  const metadata = {
    ...(existing.provider_metadata && typeof existing.provider_metadata === 'object' ? existing.provider_metadata : {}),
    ...(body.providerMetadata || body.provider_metadata || {}),
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
      existing.id,
      tenantId,
      body.providerTransferId || body.provider_transfer_id || null,
      body.providerStatus || body.provider_status || null,
      body.status || null,
      JSON.stringify(metadata),
      body.markSubmitted === true,
      body.failureReason || body.failure_reason || null,
      body.completedAt || body.completed_at || null,
    ],
  )).rows[0];
  const operationId = updated.provider_metadata?.payout_operation_id || body.payoutOperationId || '';
  return {
    ok: true,
    intent: updated,
    ...(await orchestratorIntentCounts(client, tenantId, operationId, updated.idempotency_key)),
  };
};

const listOrchestratorOperation = async (client, body = {}) => {
  const tenantId = body.tenantId || PIPELINE;
  if (tenantId === FREEDOM || tenantId === C1C) return fail('refused_production_tenant');
  if (tenantId !== PIPELINE) return fail('undesignated_tenant', { tenantId });
  const operationId = String(body.payoutOperationId || body.payout_operation_id || '');
  if (!operationId) return fail('payout_operation_id_required');
  const rows = (await client.query(
    `SELECT id, tenant_id, environment, leg_role, status, amount_cents, idempotency_key,
            provider_transfer_id, provider_status, completed_at, created_at, provider_metadata
       FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'sandbox'
        AND coalesce(provider_metadata->>'payout_operation_id', '') = $2
      ORDER BY created_at ASC`,
    [tenantId, operationId],
  )).rows;
  return {
    ok: true,
    operationId,
    rows,
    fundingRows: rows.filter((row) => row.leg_role === 'wallet_funding'),
    payoutRows: rows.filter((row) => row.leg_role === 'wallet_disbursement'),
    ...(await orchestratorIntentCounts(client, tenantId, operationId, rows[0]?.idempotency_key || '')),
    freedomEnvironment: (await freedomRow(client))?.moov_environment,
    sweep: await sweepUnchanged(client),
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

const snapshotM712Intent = async (client, intentId) => (await client.query(
  `SELECT id, tenant_id, environment, status, provider_status, provider_transfer_id,
          completed_at, failure_reason, amount_cents, leg_role, idempotency_key,
          to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at_utc
     FROM public.payment_transfers
    WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = 'sandbox'
    LIMIT 1`,
  [intentId, PIPELINE],
)).rows[0] || null;

const m712OperationCounts = async (client) => {
  const rows = (await client.query(
    `SELECT id, leg_role, provider_transfer_id, status
       FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'sandbox'
        AND coalesce(provider_metadata->>'payout_operation_id', '') = $2`,
    [PIPELINE, M712_OPERATION_ID],
  )).rows;
  const funding = rows.filter((row) => row.leg_role === 'wallet_funding');
  const payout = rows.filter((row) => row.leg_role === 'wallet_disbursement');
  return {
    fundingIntentCount: funding.length,
    payoutIntentCount: payout.length,
    fundingProviderTransferCount: funding.filter((row) => row.provider_transfer_id).length,
    payoutProviderTransferCount: payout.filter((row) => row.provider_transfer_id).length,
    fundingIds: funding.map((row) => row.id),
    payoutIds: payout.map((row) => row.id),
    fundingTransferIds: funding.map((row) => row.provider_transfer_id).filter(Boolean),
    payoutTransferIds: payout.map((row) => row.provider_transfer_id).filter(Boolean),
  };
};

const reconcileM712PayoutCompletedAt = async (client, body = {}) => {
  const tenantId = body.tenantId;
  const intentId = String(body.intentId || '');
  const transferId = String(body.providerTransferId || '');
  const providerStatus = String(body.providerStatus || '').toLowerCase();
  const completedAt = body.completedAt || null;
  if (!tenantId || tenantId === FREEDOM || tenantId === C1C) return fail('refused_production_tenant');
  if (tenantId !== PIPELINE) return fail('undesignated_tenant', { tenantId });
  if (intentId.toLowerCase() !== M712_PAYOUT_INTENT_ID) return fail('m712_payout_intent_mismatch');
  if (transferId.toLowerCase() !== M712_PAYOUT_TRANSFER_ID) return fail('m712_payout_transfer_mismatch');
  if (intentId.toLowerCase() === M712_FUNDING_INTENT_ID) return fail('funding_intent_refused');
  if (transferId.toLowerCase() === M712_FUNDING_TRANSFER_ID) return fail('funding_transfer_refused');
  if (providerStatus !== 'completed') return fail('unsupported_payout_status', { providerStatus });
  if (!completedAt) return fail('provider_completed_on_missing');

  const freedomBefore = await freedomRow(client);
  const sweepBefore = await sweepUnchanged(client);
  const fundingBefore = await snapshotM712Intent(client, M712_FUNDING_INTENT_ID);
  const countsBefore = await m712OperationCounts(client);
  if (!fundingBefore) return fail('funding_intent_missing');
  if (String(fundingBefore.provider_transfer_id || '').toLowerCase() !== M712_FUNDING_TRANSFER_ID) {
    return fail('funding_transfer_mismatch');
  }
  const intentBefore = await snapshotM712Intent(client, intentId);
  if (!intentBefore) return fail('intent_not_found');
  if (String(intentBefore.leg_role || '') !== 'wallet_disbursement') {
    return fail('intent_leg_mismatch', { leg_role: intentBefore.leg_role });
  }
  if (String(intentBefore.provider_transfer_id || '').toLowerCase() !== transferId.toLowerCase()) {
    return fail('transfer_id_mismatch');
  }
  if (Number(intentBefore.amount_cents) !== 1) return fail('amount_mismatch');
  if (countsBefore.fundingIntentCount !== 1 || countsBefore.payoutIntentCount !== 1) {
    return fail('unexpected_intent_count', countsBefore);
  }
  if (countsBefore.fundingProviderTransferCount !== 1 || countsBefore.payoutProviderTransferCount !== 1) {
    return fail('unexpected_provider_transfer_count', countsBefore);
  }

  await client.query('BEGIN');
  let recon;
  try {
    await client.query("SELECT set_config('request.moov_get_reconcile', '1', true)");
    recon = (await client.query(
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
          phase: 'm712_completed_at',
        }),
        'sandbox',
      ],
    )).rows[0];
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep original */ }
    throw error;
  }

  const intentAfter = await snapshotM712Intent(client, intentId);
  const fundingAfter = await snapshotM712Intent(client, M712_FUNDING_INTENT_ID);
  const countsAfter = await m712OperationCounts(client);
  const freedom = await freedomRow(client);
  const sweep = await sweepUnchanged(client);
  const fundingSame = Boolean(
    fundingBefore
    && fundingAfter
    && String(fundingBefore.id) === String(fundingAfter.id)
    && String(fundingBefore.id).toLowerCase() === M712_FUNDING_INTENT_ID
    && String(fundingBefore.status) === String(fundingAfter.status)
    && String(fundingBefore.provider_status) === String(fundingAfter.provider_status)
    && String(fundingBefore.provider_transfer_id || '') === String(fundingAfter.provider_transfer_id || '')
    && String(fundingBefore.provider_transfer_id || '').toLowerCase() === M712_FUNDING_TRANSFER_ID
    && String(fundingBefore.completed_at || '') === String(fundingAfter.completed_at || '')
    && String(fundingBefore.failure_reason || '') === String(fundingAfter.failure_reason || '')
  );
  return {
    ok: true,
    skipped: false,
    mode: 'update_existing_only',
    createdPaymentTransfer: false,
    liveProviderPosted: false,
    recon,
    intent: intentAfter,
    intentBefore,
    funding: fundingAfter,
    fundingUnchanged: Boolean(fundingSame),
    countsBefore,
    countsAfter,
    freedomEnvironment: freedom?.moov_environment,
    freedomChanged: freedomBefore?.moov_environment !== freedom?.moov_environment,
    sweep,
    sweepChanged: String(sweepBefore?.id || '') !== String(sweep?.id || '')
      || String(sweepBefore?.status || '') !== String(sweep?.status || ''),
  };
};

const inspectFreedomProduction = async (client) => {
  const freedom = await freedomRow(client);
  const pipeline = (await client.query(
    `SELECT id, name, slug, moov_environment, is_test_account
       FROM public.tenants WHERE id = $1::uuid`,
    [PIPELINE],
  )).rows[0] || null;
  const freedomProduction = await tenantObjects(client, FREEDOM, 'production');
  const freedomSandbox = await tenantObjects(client, FREEDOM, 'sandbox');
  const pipelineSandbox = await tenantObjects(client, PIPELINE, 'sandbox');
  const pipelineProduction = await tenantObjects(client, PIPELINE, 'production');
  const sandboxIds = [
    pipelineSandbox.account?.provider_account_id,
    pipelineSandbox.wallet?.provider_wallet_id,
    ...pipelineSandbox.banks.map((row) => row.provider_bank_account_id),
    ...pipelineSandbox.banks.map((row) => row.provider_payment_method_id),
    ...pipelineSandbox.recipients.map((row) => row.provider_account_id),
    '1d59a6a8-3307-4687-8367-1495293ecc73',
    '58571121-67ea-4e10-abae-6c9680ac455d',
    '8390f74b-706e-4d89-80b0-f96bd7c1b414',
    '8a0f6ffa-a549-48f5-bb8e-f5b6a9d9cfff',
    '1eb24c1c-b7ab-45cd-8775-332da40b9647',
    '90050a69-84f3-41bb-aa30-490ca7e7bf34',
    '92e17650-94ed-43cb-8bff-14cf506c3988',
    '7a5ef572-501e-4eac-8c1b-7a4794296a85',
    '36b79957-ce7a-4ca7-a68f-30986c9e47bb',
  ].filter(Boolean).map((id) => String(id).toLowerCase());
  const sandboxIdSet = new Set(sandboxIds);
  const productionIds = [
    freedomProduction.account?.provider_account_id,
    freedomProduction.wallet?.provider_wallet_id,
    ...freedomProduction.banks.map((row) => row.provider_bank_account_id),
    ...freedomProduction.banks.map((row) => row.provider_payment_method_id),
    ...freedomProduction.recipients.map((row) => row.provider_account_id),
  ].filter(Boolean).map((id) => String(id).toLowerCase());
  const sandboxIdsInProductionPath = productionIds.filter((id) => sandboxIdSet.has(id));
  const recipientMethods = (await client.query(
    `SELECT id, tenant_id, environment, provider_account_id, provider_bank_account_id,
            provider_payment_method_id, bank_name, last_four, verification_status
       FROM public.payment_provider_methods
      WHERE provider = 'moov' AND environment = 'production'
        AND (
          tenant_id = $1::uuid
          OR provider_account_id = ANY($2::text[])
        )
      ORDER BY connected_at DESC NULLS LAST`,
    [FREEDOM, freedomProduction.recipients.map((row) => row.provider_account_id).filter(Boolean)],
  )).rows;
  const productionTransfers = (await client.query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE created_at > now() - interval '2 hours')::int AS recent
       FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'production'`,
    [FREEDOM],
  )).rows[0];
  const existingProductionRows = (await client.query(
    `SELECT id, amount_cents, status, leg_role, idempotency_key, provider_transfer_id,
            description, environment, completed_at, failure_reason
       FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'production'
      ORDER BY created_at DESC NULLS LAST
      LIMIT 50`,
    [FREEDOM],
  )).rows;
  const webhookAccounts = (await client.query(
    `SELECT tenant_id, environment, provider_account_id
       FROM public.payment_provider_accounts
      WHERE provider = 'moov'
        AND provider_account_id IN ($1, $2)
      ORDER BY environment, tenant_id`,
    [
      freedomProduction.account?.provider_account_id || '00000000-0000-0000-0000-000000000000',
      pipelineSandbox.account?.provider_account_id || '00000000-0000-0000-0000-000000000000',
    ],
  )).rows;
  return {
    ok: freedom?.moov_environment === 'production'
      && pipeline?.moov_environment === 'sandbox'
      && sandboxIdsInProductionPath.length === 0
      && pipelineSandbox.productionIdHits.length === 0,
    createdPaymentTransfer: false,
    liveProviderPosted: false,
    freedom,
    pipeline,
    freedomProduction,
    freedomSandbox: {
      account: freedomSandbox.account?.provider_account_id || null,
      wallet: freedomSandbox.wallet?.provider_wallet_id || null,
      banks: freedomSandbox.banks.length,
      recipients: freedomSandbox.recipients.length,
    },
    pipelineSandbox,
    pipelineProduction: {
      account: pipelineProduction.account?.provider_account_id || null,
      wallet: pipelineProduction.wallet?.provider_wallet_id || null,
    },
    recipientMethods,
    productionTransferCount: productionTransfers?.n || 0,
    recentProductionTransfers: productionTransfers?.recent || 0,
    existingProductionRows,
    webhookAccounts,
    sandboxIdsInProductionPath,
    sweep: await sweepUnchanged(client),
  };
};

const M716_OPERATION_ID = '534bfe2d-6bd9-5f78-a367-61e66e7ed33a';
const M716_FUNDING_KEY = `checksops:m77:wallet_funding:env:production:op:${M716_OPERATION_ID}:cents:1`;
const PROD_ACCOUNT = '60922058-7eca-4889-81dd-5720d7b9de96';
const PROD_WALLET = '3e6286ca-a19c-45f6-aad9-f73dac5f0358';
const PROD_BANK = '61062c38-a79e-4f62-bb64-32ddecf3d37c';
const PROD_FUND_PM = 'a02c1c81-9ca6-434d-accc-ea4471a70ef2';
const PROD_WALLET_PM = '744ea734-f5e3-4b31-bb92-38f85fd29b91';

const inspectM716PhaseA = async (client, body = {}) => {
  const operationId = String(body.payoutOperationId || M716_OPERATION_ID);
  const idempotencyKey = String(body.idempotencyKey || M716_FUNDING_KEY);
  const freedom = await freedomRow(client);
  const objects = await tenantObjects(client, FREEDOM, 'production');
  const fundingBank = (objects.banks || []).find((row) => String(row.provider_bank_account_id || '').toLowerCase() === PROD_BANK);
  const fundPm = (objects.banks || []).find((row) => String(row.provider_payment_method_id || '').toLowerCase() === PROD_FUND_PM);
  const walletPm = (objects.banks || []).find((row) => String(row.provider_payment_method_id || '').toLowerCase() === PROD_WALLET_PM);
  const operationRows = (await client.query(
    `SELECT id, tenant_id, environment, status, leg_role, amount_cents, idempotency_key,
            provider_transfer_id, provider_status, completed_at, failure_reason,
            source_tenant_account_id, description, created_at, provider_metadata
       FROM public.payment_transfers
      WHERE tenant_id = $1::uuid
        AND environment = 'production'
        AND (
          idempotency_key = $2
          OR COALESCE(provider_metadata->>'payout_operation_id', '') = $3
        )
      ORDER BY created_at DESC NULLS LAST`,
    [FREEDOM, idempotencyKey, operationId],
  )).rows;
  const fundingRows = operationRows.filter((row) => String(row.leg_role || '') === 'wallet_funding');
  const payoutRows = operationRows.filter((row) => String(row.leg_role || '') === 'wallet_disbursement');
  const conflicting = fundingRows.filter((row) => ['pending', 'submitting', 'submitted', 'unknown', 'processing'].includes(String(row.status || '').toLowerCase())
    || String(row.provider_status || '').toLowerCase() === 'unknown');
  const posted = fundingRows.filter((row) => row.provider_transfer_id);
  const owners = (await client.query(
    `SELECT tu.user_id, tu.role, p.email, p.full_name
       FROM public.tenant_users tu
       LEFT JOIN public.profiles p ON p.id = tu.user_id
      WHERE tu.tenant_id = $1::uuid
      ORDER BY tu.role`,
    [FREEDOM],
  )).rows;
  const stepups = (await client.query(
    `SELECT id, user_id, tenant_id, action_key, succeeded, metadata, created_at
       FROM public.financial_stepup_log
      WHERE tenant_id = $1::uuid
        AND user_id = $2::uuid
        AND action_key = 'wallet.fund'
        AND succeeded IS TRUE
        AND created_at >= now() - interval '30 minutes'
        AND COALESCE(metadata->>'consumed_at', '') = ''
      ORDER BY created_at DESC
      LIMIT 10`,
    [FREEDOM, ACTOR],
  )).rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    action_key: row.action_key,
    succeeded: row.succeeded,
    amount_cents: row.metadata?.amount_cents ?? null,
    source_payment_method_id: row.metadata?.source_payment_method_id || null,
    destination_payment_method_id: row.metadata?.destination_payment_method_id || null,
    created_at: row.created_at,
  }));
  const sweep = await sweepUnchanged(client);
  return {
    ok: freedom?.moov_environment === 'production',
    createdPaymentTransfer: false,
    liveProviderPosted: false,
    freedom,
    objects: {
      account: objects.account?.provider_account_id || null,
      wallet: objects.wallet?.provider_wallet_id || null,
      walletLocalId: objects.wallet?.id || null,
      fundingBankLocalId: fundingBank?.id || null,
      fundingBank: fundingBank?.provider_bank_account_id || null,
      fundingBankStatus: fundingBank?.verification_status || null,
      fundPm: fundPm?.provider_payment_method_id || fundPm?.provider_payment_method_id || null,
      fundPmLocalId: fundPm?.id || fundingBank?.id || null,
      walletPm: walletPm?.provider_payment_method_id || null,
      walletPmLocalId: walletPm?.id || null,
    },
    operationId,
    idempotencyKey,
    operationRows,
    fundingRows,
    payoutRows,
    fundingIntentCount: fundingRows.length,
    payoutIntentCount: payoutRows.length,
    conflictingFunding: conflicting,
    postedFunding: posted,
    owners,
    walletFundStepups: stepups,
    sweep,
    sweepUnchanged: true,
  };
};

const persistProductionFundingIntent = async (client, body = {}) => {
  if (body.leg_role && body.leg_role !== 'wallet_funding') return fail('payout_intent_refused_phase_a');
  const tenantId = body.tenantId || FREEDOM;
  if (tenantId !== FREEDOM) return fail('refused_non_freedom_tenant', { tenantId });
  const freedom = await freedomRow(client);
  if (!freedom || freedom.moov_environment !== 'production') {
    return fail('tenant_not_production', { environment: freedom?.moov_environment || null });
  }
  const operationId = String(body.payoutOperationId || M716_OPERATION_ID);
  const idempotencyKey = String(body.idempotencyKey || M716_FUNDING_KEY);
  if (operationId !== M716_OPERATION_ID) return fail('unexpected_operation', { operationId });
  if (idempotencyKey !== M716_FUNDING_KEY) return fail('unexpected_idempotency', { idempotencyKey });
  if (Number(body.amountCents || 1) !== 1) return fail('amount_not_one_cent');
  if (String(body.leg_role || 'wallet_funding') === 'wallet_disbursement') {
    return fail('payout_intent_refused_phase_a');
  }
  const objects = await tenantObjects(client, FREEDOM, 'production');
  if (String(objects.account?.provider_account_id || '').toLowerCase() !== PROD_ACCOUNT) {
    return fail('production_account_mismatch');
  }
  if (String(objects.wallet?.provider_wallet_id || '').toLowerCase() !== PROD_WALLET) {
    return fail('production_wallet_mismatch');
  }
  const fundingBank = (objects.banks || []).find((row) => String(row.provider_bank_account_id || '').toLowerCase() === PROD_BANK);
  const fundPm = (objects.banks || []).find((row) => String(row.provider_payment_method_id || '').toLowerCase() === PROD_FUND_PM);
  const walletPm = (objects.banks || []).find((row) => String(row.provider_payment_method_id || '').toLowerCase() === PROD_WALLET_PM);
  if (!fundingBank) return fail('production_bank_unlinked');
  const sourceMethodLocalId = fundPm?.id || fundingBank.id;
  const existing = (await client.query(
    `SELECT * FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND idempotency_key = $2 LIMIT 1`,
    [FREEDOM, idempotencyKey],
  )).rows[0] || null;
  const inspectedBefore = await inspectM716PhaseA(client, { payoutOperationId: operationId, idempotencyKey });
  if ((inspectedBefore.payoutIntentCount || 0) > 0) return fail('payout_intent_present');
  if ((inspectedBefore.postedFunding || []).length && !existing) {
    return fail('existing_funding_provider_transfer');
  }
  if ((inspectedBefore.conflictingFunding || []).length && !existing) {
    return fail('conflicting_pending_or_unknown_funding');
  }
  if (existing) {
    return {
      ok: true,
      reused: true,
      created: false,
      intent: existing,
      ...inspectedBefore,
    };
  }
  const metadata = {
    phase: 'M7.16',
    payout_operation_id: operationId,
    environment: 'production',
    account_id: PROD_ACCOUNT,
    wallet_id: PROD_WALLET,
    bank_id: PROD_BANK,
    source_payment_method_id: PROD_FUND_PM,
    destination_payment_method_id: PROD_WALLET_PM,
    provider_idempotency_key: body.providerIdempotencyKey || null,
    post_attempted: false,
    ...(body.providerMetadata || {}),
    payout_operation_id: operationId,
    phase: 'M7.16',
  };
  let inserted;
  try {
    inserted = (await client.query(
      `INSERT INTO public.payment_transfers (
          tenant_id, provider, environment, status, idempotency_key, amount_cents,
          platform_fee_cents, net_amount_cents, speed, description,
          source_tenant_account_id, source_payment_method_id,
          wallet_id, leg_role, provider_metadata, created_by
        ) VALUES (
          $1::uuid, 'moov', 'production', 'planned', $2, 1,
          0, 1, 'standard', $3,
          $4, $5::uuid, $6::uuid, 'wallet_funding', $7::jsonb, $8::uuid
        )
        RETURNING *`,
      [
        FREEDOM,
        idempotencyKey,
        'M7.16 production BANK to WALLET 0.01',
        PROD_ACCOUNT,
        sourceMethodLocalId,
        objects.wallet.id,
        JSON.stringify(metadata),
        ACTOR,
      ],
    )).rows[0];
  } catch (error) {
    if (String(error?.code) === '23505') {
      const raced = (await client.query(
        `SELECT * FROM public.payment_transfers
          WHERE tenant_id = $1::uuid AND idempotency_key = $2 LIMIT 1`,
        [FREEDOM, idempotencyKey],
      )).rows[0];
      return { ok: true, reused: true, created: false, intent: raced, cas: 'reuse' };
    }
    throw error;
  }
  const inspected = await inspectM716PhaseA(client, { payoutOperationId: operationId, idempotencyKey });
  return {
    ok: true,
    reused: false,
    created: true,
    intent: inserted,
    cas: 'insert',
    payoutCreated: false,
    liveProviderPosted: false,
    ...inspected,
  };
};

const updateProductionFundingIntent = async (client, body = {}) => {
  const idempotencyKey = String(body.idempotencyKey || M716_FUNDING_KEY);
  const existing = (await client.query(
    `SELECT * FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'production'
        AND idempotency_key = $2 AND leg_role = 'wallet_funding'
      LIMIT 1`,
    [FREEDOM, idempotencyKey],
  )).rows[0];
  if (!existing) return fail('funding_intent_missing');
  const meta = {
    ...(existing.provider_metadata && typeof existing.provider_metadata === 'object' ? existing.provider_metadata : {}),
    ...(body.providerMetadata || {}),
  };
  const updated = (await client.query(
    `UPDATE public.payment_transfers
        SET provider_transfer_id = COALESCE($3, provider_transfer_id),
            provider_status = COALESCE($4, provider_status),
            status = COALESCE($5, status),
            failure_reason = COALESCE($6, failure_reason),
            provider_metadata = $7::jsonb
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = 'production'
      RETURNING *`,
    [
      existing.id,
      FREEDOM,
      body.providerTransferId || null,
      body.providerStatus || null,
      body.status || null,
      body.failureReason || null,
      JSON.stringify(meta),
    ],
  )).rows[0];
  return { ok: true, intent: updated, liveProviderPosted: false };
};

const casMarkProductionFundingPostAttempt = async (client, body = {}) => {
  const idempotencyKey = String(body.idempotencyKey || M716_FUNDING_KEY);
  const existing = (await client.query(
    `SELECT * FROM public.payment_transfers
      WHERE tenant_id = $1::uuid AND environment = 'production'
        AND idempotency_key = $2 AND leg_role = 'wallet_funding'
      LIMIT 1`,
    [FREEDOM, idempotencyKey],
  )).rows[0];
  if (!existing) return fail('funding_intent_missing');
  if (existing.provider_transfer_id) return fail('already_posted', { intent: existing });
  const meta = existing.provider_metadata && typeof existing.provider_metadata === 'object'
    ? existing.provider_metadata
    : {};
  if (meta.post_attempted === true) return fail('post_already_attempted_unknown', { intent: existing });
  const updated = (await client.query(
    `UPDATE public.payment_transfers
        SET provider_metadata = $3::jsonb
      WHERE id = $1::uuid AND tenant_id = $2::uuid
        AND environment = 'production'
        AND provider_transfer_id IS NULL
        AND COALESCE(provider_metadata->>'post_attempted', '') <> 'true'
      RETURNING *`,
    [
      existing.id,
      FREEDOM,
      JSON.stringify({
        ...meta,
        post_attempted: true,
        post_outcome: 'in_flight',
        provider_idempotency_key: body.providerIdempotencyKey || meta.provider_idempotency_key || null,
      }),
    ],
  )).rows[0];
  if (!updated) return fail('cas_lost');
  return { ok: true, intent: updated, cas: 'post_attempted' };
};

const consumeWalletFundStepup = async (client, body = {}) => {
  const stepupId = body.stepupId;
  if (!stepupId) return fail('stepup_id_required');
  const updated = (await client.query(
    `UPDATE public.financial_stepup_log
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND user_id = $4::uuid
        AND action_key = 'wallet.fund'
        AND succeeded IS TRUE
        AND COALESCE(metadata->>'consumed_at', '') = ''
      RETURNING id, user_id, tenant_id, action_key, metadata, created_at`,
    [
      stepupId,
      FREEDOM,
      JSON.stringify({
        consumed_at: new Date().toISOString(),
        consumed_by_intent_id: body.intentId || null,
        consumed_operation: M716_OPERATION_ID,
      }),
      ACTOR,
    ],
  )).rows[0];
  if (!updated) return fail('stepup_not_consumable');
  return { ok: true, stepup: updated, consumed: true };
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
    if (step === 'persist_payout_intent') return await persistPayoutIntent(client, event);
    if (step === 'update_payout_intent') return await updatePayoutIntent(client, event);
    if (step === 'verify_payout_intent') return await verifyPayoutIntent(client, event);
    if (step === 'list_sandbox_history') return await listSandboxHistory(client);
    if (step === 'diagnose_funding_reconcile') return await diagnoseFundingReconcile(client, event);
    if (step === 'reconcile_funding_parity') return await reconcileFundingParity(client, event);
    if (step === 'reconcile_payout_parity') return await reconcilePayoutParity(client, event);
    if (step === 'diagnose_payout_webhook') return await diagnosePayoutWebhook(client, event);
    if (step === 'persist_orchestrator_intent') return await persistOrchestratorIntent(client, event);
    if (step === 'get_orchestrator_intent') return await getOrchestratorIntent(client, event);
    if (step === 'update_orchestrator_intent') return await updateOrchestratorIntent(client, event);
    if (step === 'list_orchestrator_operation') return await listOrchestratorOperation(client, event);
    if (step === 'reconcile_m712_payout_completed_at') return await reconcileM712PayoutCompletedAt(client, event);
    if (step === 'inspect_freedom_production') return await inspectFreedomProduction(client);
    if (step === 'inspect_m716_phase_a') return await inspectM716PhaseA(client, event);
    if (step === 'persist_production_funding_intent') return await persistProductionFundingIntent(client, event);
    if (step === 'update_production_funding_intent') return await updateProductionFundingIntent(client, event);
    if (step === 'cas_mark_production_funding_post_attempt') return await casMarkProductionFundingPostAttempt(client, event);
    if (step === 'consume_wallet_fund_stepup') return await consumeWalletFundStepup(client, event);
    return fail('unknown_step', { step });
  } catch (error) {
    return fail(String(error?.message || error).slice(0, 400), { step });
  } finally {
    try { await client?.end(); } catch { /* ignore */ }
  }
};
