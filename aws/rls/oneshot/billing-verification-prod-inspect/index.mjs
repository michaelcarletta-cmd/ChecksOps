/**
 * Read-only production pre-$1 readiness inspect.
 * Does not apply SQL, create occurrences, post ACH, or enable gates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { buildConsolidatedInvoice } from './tenant-billing-engine.mjs';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const LEGACY = '68041b0b-563e-4948-b19c-ce6c0c2e1a07';
const PROD_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const PROD_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const EXPECTED_LAST4 = '4573';
const EXPECTED_PM = '7a78a544-340d-46fd-a4a4-228661374da7';
const EXPECTED_ACCT = '60922058-7eca-4889-81dd-5720d7b9de96';

const q = async (client, sql, params = []) => {
  try {
    return (await client.query(sql, params)).rows;
  } catch (error) {
    return { error: String(error.message || error).slice(0, 400) };
  }
};

export const handler = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops-production/i.test(arn)) {
    return { ok: false, error: 'inspect requires production admin secret' };
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  if (!/checksops-production/i.test(String(host || ''))) {
    return { ok: false, error: `refusing_non_production_host:${host}` };
  }
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 60000,
  });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const identity = (await q(client, `
      SELECT current_database() AS database, current_user AS db_user,
             inet_server_addr()::text AS server_addr,
             current_setting('transaction_read_only') AS read_only
    `))[0];
    const kindCol = await q(client, `
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tenant_maintenance_payments'
        AND column_name='occurrence_kind'
    `);
    const dest = (await q(client, `
      SELECT environment, moov_account_id, moov_payment_method_id, label
      FROM public.platform_billing_destination WHERE environment = 'production'
    `))[0] || null;
    const funding = (await q(client, `
      SELECT tenant_id, account_number_last4, verification_status, auto_debit_enabled,
             ach_authorized_at, provider_payment_method_id, provider_account_id,
             provider_environment, nickname
      FROM public.tenant_billing_accounts WHERE tenant_id = $1::uuid
    `, [FREEDOM]))[0] || null;
    const tenant = (await q(client, `
      SELECT id, name, slug, subscription_status, monthly_rate_cents, referral_discount_cents
      FROM public.tenants WHERE id = $1::uuid
    `, [FREEDOM]))[0] || null;
    const settings = (await q(client, `
      SELECT billing_enabled, billing_day_of_month FROM public.tenant_billing_settings
      WHERE tenant_id = $1::uuid
    `, [FREEDOM]))[0] || null;
    const occurrences = await q(client, `
      SELECT id, occurrence_kind, amount_cents, billing_period, status, provider_transfer_id,
             idempotence_key, submitted_at, created_at
      FROM public.tenant_maintenance_payments
      WHERE tenant_id = $1::uuid
      ORDER BY created_at
    `, [FREEDOM]);
    const legacy = (await q(client, `
      SELECT id, occurrence_kind, amount_cents, billing_period, status, provider_transfer_id,
             failure_reason, return_reason, created_at, updated_at
      FROM public.tenant_maintenance_payments WHERE id = $1::uuid
    `, [LEGACY]))[0] || null;
    const septemberAllocations = await q(client, `
      SELECT count(*)::int AS count, coalesce(sum(amount_cents),0)::int AS amount_cents
      FROM public.tenant_invoice_allocations
      WHERE tenant_id = $1::uuid AND billing_period = '2026-09'
    `, [FREEDOM]);
    const septemberEvents = await q(client, `
      SELECT event_type, count(*)::int AS count, coalesce(sum(unit_price_cents),0)::int AS amount_cents
      FROM public.check_billing_events
      WHERE tenant_id = $1::uuid
        AND to_char(billed_at AT TIME ZONE 'UTC', 'YYYY-MM') = '2026-09'
      GROUP BY 1 ORDER BY 1
    `, [FREEDOM]);
    const invoice = await buildConsolidatedInvoice(client, {
      tenantId: FREEDOM, period: '2026-09', persist: false,
    });
    const verificationCount = Array.isArray(occurrences)
      ? occurrences.filter((row) => row.occurrence_kind === 'billing_verification').length
      : null;
    const septemberOccurrence = Array.isArray(occurrences)
      ? occurrences.filter((row) => row.billing_period === '2026-09')
      : [];

    return {
      ok: identity?.read_only === 'on',
      mutated: false,
      liveDebitCreated: false,
      host,
      identity,
      schema: { occurrence_kind: Array.isArray(kindCol) && kindCol.length === 1, kindCol },
      destination: {
        row: dest,
        matchesExpected: dest?.moov_account_id === PROD_ACCOUNT
          && dest?.moov_payment_method_id === PROD_METHOD,
      },
      freedom: {
        tenant,
        settings,
        funding: funding && {
          last4: funding.account_number_last4,
          last4Matches: funding.account_number_last4 === EXPECTED_LAST4,
          verification_status: funding.verification_status,
          auto_debit_enabled: funding.auto_debit_enabled,
          provider_environment: funding.provider_environment,
          provider_account_id: funding.provider_account_id,
          provider_account_matches: funding.provider_account_id === EXPECTED_ACCT,
          provider_payment_method_id: funding.provider_payment_method_id,
          provider_payment_method_matches: funding.provider_payment_method_id === EXPECTED_PM,
        },
      },
      septemberInvoice: invoice.ok ? {
        amount_cents: invoice.amount_cents,
        maintenance_net_cents: invoice.maintenance_net_cents,
        check_usage_cents: invoice.check_usage_cents,
        next_day_usage_cents: invoice.next_day_usage_cents,
        same_day_usage_cents: invoice.same_day_usage_cents,
        mortgage_ops_usage_cents: invoice.mortgage_ops_usage_cents,
        usage_total_cents: invoice.usage_total_cents,
        check_count: invoice.check_count,
        next_day_count: invoice.next_day_count,
        same_day_count: invoice.same_day_count,
        mortgage_ops_initial_count: invoice.mortgage_ops_initial_count,
        mortgage_ops_additional_count: invoice.mortgage_ops_additional_count,
      } : { ok: false, error: invoice.error || invoice },
      septemberAllocations: septemberAllocations[0] || septemberAllocations,
      septemberEvents,
      septemberOccurrences: septemberOccurrence,
      occurrences,
      verificationOccurrenceCount: verificationCount,
      legacyPenny: legacy,
      webhookGap: {
        productionAutomaticApply: false,
        documented: true,
        laterInspection: 'platform-owner apply-event after the authorized $1',
      },
    };
  } finally {
    await client.end();
  }
};
