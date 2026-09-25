/**
 * Staging-only: apply SQL 47 and accept isolated billing-verification simulation.
 * Synthetic tenant only. No Freedom. No production. No real Moov POST.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  applyBillingProviderEvent,
  BILLING_VERIFICATION_AMOUNT_CENTS,
  billingVerificationIdempotencyKey,
  buildConsolidatedInvoice,
  OCCURRENCE_KIND_VERIFICATION,
  verifyTenantBillingDebit,
} from './tenant-billing-engine.mjs';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const SQL47 = fs.readFileSync(path.join(ROOT, '47_billing_verification_occurrence.sql'), 'utf8');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SLUG = 'synthetic-billing-verification';
const NAME = 'SYNTHETIC Billing Verification';
const OWNER = process.env.OWNER_USER_ID || '233c588f-dc33-4307-8c3f-3da49c9fd2b3';
const VERIFY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEST = {
  ok: true,
  accountId: '36b79957-ce7a-4ca7-a68f-30986c9e47bb',
  paymentMethodId: 'pm-checksops-wallet-staging',
  source: 'explicit',
};

const connect = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be checksops_admin');
  if (/production/i.test(arn) || /prod/i.test(process.env.RDS_HOST || '')) {
    throw new Error('refusing_production_sql');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  if (!String(host).includes('checksops-staging')) throw new Error(`refusing_non_staging_host:${host}`);
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
  return { client, host };
};

const counts = async (client, tenantId) => (await client.query(`
  SELECT
    (SELECT count(*) FROM public.tenant_maintenance_payments WHERE tenant_id = $1::uuid) AS occurrences,
    (SELECT count(*) FROM public.tenant_maintenance_payments
      WHERE tenant_id = $1::uuid AND occurrence_kind = 'billing_verification') AS verifications,
    (SELECT count(*) FROM public.tenant_maintenance_payments
      WHERE tenant_id = $1::uuid AND billing_period = '2026-09') AS september_occurrences,
    (SELECT count(*) FROM public.tenant_invoice_allocations WHERE tenant_id = $1::uuid) AS allocations,
    (SELECT count(*) FROM public.check_billing_events WHERE tenant_id = $1::uuid) AS events
`, [tenantId])).rows[0];

const ensureTenant = async (client) => {
  const existing = (await client.query('SELECT id FROM public.tenants WHERE slug = $1', [SLUG])).rows[0];
  const tenantId = existing?.id || (await client.query(
    'INSERT INTO public.tenants (name, slug) VALUES ($1, $2) RETURNING id',
    [NAME, SLUG],
  )).rows[0].id;
  if (tenantId === FREEDOM) throw new Error('refusing_freedom_tenant');
  await client.query(
    `UPDATE public.tenants SET
       name = $2, subscription_status = 'active',
       monthly_rate_cents = 10000, referral_discount_cents = 500,
       per_check_rate_cents = 400, next_day_rate_cents = 75, same_day_rate_cents = 100,
       mortgage_ops_initial_rate_cents = 1000, mortgage_ops_additional_rate_cents = 500
     WHERE id = $1::uuid`,
    [tenantId, NAME],
  );
  await client.query(
    `INSERT INTO public.tenant_billing_settings (tenant_id, billing_enabled, billing_day_of_month, updated_by)
     VALUES ($1::uuid, true, 1, $2::uuid)
     ON CONFLICT (tenant_id) DO UPDATE SET billing_enabled = true, billing_day_of_month = 1`,
    [tenantId, OWNER],
  ).catch(() => {});
  const accountId = `synth-acct-${String(tenantId).slice(0, 8)}`;
  const methodId = `synth-pm-${String(tenantId).slice(0, 8)}`;
  await client.query(
    `INSERT INTO public.payment_provider_accounts
       (tenant_id, provider, environment, provider_account_id, onboarding_status,
        verification_status, can_ach_debit, can_send_payments)
     VALUES ($1::uuid, 'moov', 'sandbox', $2, 'active', 'verified', true, true)
     ON CONFLICT DO NOTHING`,
    [tenantId, accountId],
  ).catch(() => {});
  await client.query(
    `UPDATE public.payment_provider_accounts SET
       can_ach_debit = true, can_send_payments = true,
       onboarding_status = 'active', verification_status = 'verified'
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'sandbox'`,
    [tenantId],
  ).catch(() => {});
  await client.query(
    `INSERT INTO public.payment_provider_methods
       (tenant_id, provider, environment, provider_account_id, provider_bank_account_id,
        provider_payment_method_id, holder_name, last_four, verification_status,
        connection_status, can_send)
     VALUES ($1::uuid, 'moov', 'sandbox', $2, $3, $3, $4, '0001', 'verified', 'connected', true)`,
    [tenantId, accountId, methodId, NAME],
  ).catch(() => {});
  const auth = (await client.query(
    'SELECT id FROM public.tenant_billing_accounts WHERE tenant_id = $1::uuid',
    [tenantId],
  )).rows[0];
  if (auth) {
    await client.query(
      `UPDATE public.tenant_billing_accounts SET
         auto_debit_enabled = true,
         ach_authorized_at = COALESCE(ach_authorized_at, now()),
         provider_payment_method_id = $2,
         provider_account_id = $3,
         provider_environment = 'sandbox',
         account_number_last4 = '0001',
         verification_status = 'verified'
       WHERE tenant_id = $1::uuid`,
      [tenantId, methodId, accountId],
    );
  } else {
    await client.query(
      `INSERT INTO public.tenant_billing_accounts (
         tenant_id, account_holder_name, account_number_last4, account_type, entity_type,
         auto_debit_enabled, ach_authorized_at, ach_authorized_by, verification_status,
         provider_payment_method_id, provider_bank_account_id, provider_account_id,
         provider_environment, nickname
       ) VALUES (
         $1::uuid, $2, '0001', 'checking', 'business',
         true, now(), $3::uuid, 'verified',
         $4, $4, $5, 'sandbox', 'SYNTHETIC verification funding'
       )`,
      [tenantId, NAME, OWNER, methodId, accountId],
    );
  }
  return tenantId;
};

export const handler = async () => {
  const { client, host } = await connect();
  try {
    await client.query(SQL47);
    const kindCol = (await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='tenant_maintenance_payments'
         AND column_name='occurrence_kind'`,
    )).rows[0];
    const tenantId = await ensureTenant(client);
    const beforeInvoice = await buildConsolidatedInvoice(client, {
      tenantId, period: '2026-09', persist: false,
    });
    const beforeCounts = await counts(client, tenantId);

    const first = await verifyTenantBillingDebit(client, {
      tenantId,
      verificationId: VERIFY_ID,
      recordedBy: OWNER,
      deps: { destination: DEST, simulate: true },
    });
    const replay = await verifyTenantBillingDebit(client, {
      tenantId,
      verificationId: VERIFY_ID,
      recordedBy: OWNER,
      deps: { destination: DEST, simulate: true },
    });

    const afterInvoice = await buildConsolidatedInvoice(client, {
      tenantId, period: '2026-09', persist: false,
    });
    const afterCounts = await counts(client, tenantId);
    const row = (await client.query(
      `SELECT id, occurrence_kind, amount_cents, billing_period, status, provider_transfer_id,
              idempotence_key, failure_reason, return_reason
       FROM public.tenant_maintenance_payments
       WHERE idempotence_key = $1`,
      [billingVerificationIdempotencyKey(tenantId, VERIFY_ID)],
    )).rows[0] || null;

    const transferId = row?.provider_transfer_id;
    const settled = transferId
      ? await applyBillingProviderEvent(client, { providerTransferId: transferId, status: 'transfer.completed' })
      : null;
    if (row) {
      await client.query(
        `UPDATE public.tenant_maintenance_payments SET status='submitted', settled_at=NULL WHERE id=$1::uuid`,
        [row.id],
      );
    }
    const failed = transferId
      ? await applyBillingProviderEvent(client, {
        providerTransferId: transferId, status: 'transfer.failed', reason: 'staging-sim-fail',
      })
      : null;
    if (row) {
      await client.query(
        `UPDATE public.tenant_maintenance_payments SET status='submitted', failure_reason=NULL WHERE id=$1::uuid`,
        [row.id],
      );
    }
    const returned = transferId
      ? await applyBillingProviderEvent(client, {
        providerTransferId: transferId, status: 'transfer.returned', reason: 'R10',
      })
      : null;

    const invoiceUnchanged = beforeInvoice.ok && afterInvoice.ok
      && beforeInvoice.amount_cents === afterInvoice.amount_cents
      && beforeInvoice.check_usage_cents === afterInvoice.check_usage_cents
      && beforeInvoice.next_day_usage_cents === afterInvoice.next_day_usage_cents
      && beforeInvoice.same_day_usage_cents === afterInvoice.same_day_usage_cents
      && beforeInvoice.mortgage_ops_usage_cents === afterInvoice.mortgage_ops_usage_cents
      && beforeInvoice.maintenance_net_cents === afterInvoice.maintenance_net_cents;

    return {
      ok: Boolean(kindCol)
        && first.ok === true
        && first.simulated === true
        && first.liveProviderCalled === false
        && replay.duplicate === true
        && row?.occurrence_kind === OCCURRENCE_KIND_VERIFICATION
        && Number(row?.amount_cents) === BILLING_VERIFICATION_AMOUNT_CENTS
        && row?.billing_period == null
        && Number(afterCounts.verifications) >= 1
        && Number(afterCounts.september_occurrences) === Number(beforeCounts.september_occurrences)
        && Number(afterCounts.allocations) === Number(beforeCounts.allocations)
        && Number(afterCounts.events) === Number(beforeCounts.events)
        && invoiceUnchanged
        && settled?.occurrence?.status === 'settled'
        && failed?.occurrence?.status === 'failed'
        && returned?.occurrence?.status === 'returned'
        && returned?.occurrence?.return_reason === 'R10',
      host,
      mutatedProduction: false,
      freedomUsed: false,
      liveDebitCreated: false,
      schema: { occurrence_kind: Boolean(kindCol) },
      tenantId,
      first: {
        ok: first.ok,
        error: first.error || null,
        simulated: first.simulated,
        liveProviderCalled: first.liveProviderCalled,
        amount: first.occurrence?.amount_cents,
        kind: first.occurrence?.occurrence_kind,
        period: first.occurrence?.billing_period ?? null,
        transferId: first.occurrence?.provider_transfer_id,
      },
      replay: { ok: replay.ok, duplicate: replay.duplicate === true },
      row,
      invoice: {
        before: beforeInvoice.amount_cents,
        after: afterInvoice.amount_cents,
        unchanged: invoiceUnchanged,
      },
      counts: { before: beforeCounts, after: afterCounts },
      status: {
        settled: settled?.occurrence?.status,
        failed: failed?.occurrence?.status,
        returned: returned?.occurrence?.status,
        returnReason: returned?.occurrence?.return_reason,
      },
    };
  } finally {
    await client.end();
  }
};
