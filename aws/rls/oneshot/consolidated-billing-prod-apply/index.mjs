/**
 * Production-only: apply SQL 44 consolidated monthly tenant billing.
 * Additive schema only. Does not post ACH, rewrite destinations, or create invoices.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const SQL = fs.readFileSync(path.join(ROOT, '44_consolidated_monthly_tenant_billing.sql'), 'utf8');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const LEGACY = '68041b0b-563e-4948-b19c-ce6c0c2e1a07';
const PROD_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const PROD_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';

const adminClient = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be checksops_admin');
  if (!/checksops-production/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be the production admin secret');
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  if (!/checksops-production/i.test(String(host || ''))) {
    throw new Error(`refusing_non_production_host:${host}`);
  }
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

export const handler = async () => {
  if (process.env.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST === 'true') {
    return { ok: false, error: 'refusing_apply_while_production_post_true' };
  }
  let client;
  let host;
  try {
    ({ client, host } = await adminClient());
  } catch (error) {
    return { ok: false, phase: 'connect', error: String(error.message || error).slice(0, 500) };
  }

  try {
    const dest = (await client.query(`
      SELECT environment, moov_account_id, moov_payment_method_id
      FROM public.platform_billing_destination WHERE environment = 'production'
    `)).rows[0] || null;
    if (!dest || dest.moov_account_id !== PROD_ACCOUNT || dest.moov_payment_method_id !== PROD_METHOD) {
      return { ok: false, phase: 'destination_guard', destination: dest, firstWalletFallback: false };
    }

    const before = (await client.query(`
      SELECT
        (SELECT count(*) FROM public.tenants) AS tenants,
        (SELECT count(*) FROM public.tenant_maintenance_payments) AS occurrences,
        (SELECT count(*) FROM public.check_billing_events) AS usage_events,
        (SELECT count(*) FROM public.check_billing_events
          WHERE tenant_id = $1::uuid) AS freedom_events,
        (SELECT count(*) FROM public.tenant_maintenance_payments
          WHERE id = $2::uuid) AS legacy_penny
    `, [FREEDOM, LEGACY])).rows[0];
    const legacyBefore = (await client.query(`
      SELECT id, amount_cents, billing_period, status, provider_transfer_id, created_at
      FROM public.tenant_maintenance_payments WHERE id = $1::uuid
    `, [LEGACY])).rows[0] || null;

    await client.query('BEGIN');
    await client.query(SQL);
    const tenantCols = (await client.query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants'
        AND column_name IN ('next_day_rate_cents', 'same_day_rate_cents')
      ORDER BY 1
    `)).rows;
    const eventCols = (await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'check_billing_events'
        AND column_name IN ('payment_transfer_id', 'billing_period', 'invoice_id', 'source_kind', 'source_id')
      ORDER BY 1
    `)).rows;
    const payCols = (await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenant_maintenance_payments'
        AND column_name IN (
          'maintenance_net_cents', 'check_usage_cents', 'next_day_usage_cents',
          'same_day_usage_cents', 'usage_total_cents', 'check_count', 'next_day_count', 'same_day_count'
        )
      ORDER BY 1
    `)).rows;
    const alloc = (await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'tenant_invoice_allocations'
    `)).rows;
    const indexes = (await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'check_billing_events_check_processing_uidx',
          'check_billing_events_transfer_fee_uidx',
          'check_billing_events_source_fee_uidx',
          'tenant_maintenance_payments_tenant_period_uidx'
        )
      ORDER BY 1
    `)).rows;
    const checks = (await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'tenants_next_day_rate_cents_check',
        'tenants_same_day_rate_cents_check',
        'tenant_invoice_allocations_unique_source'
      )
      ORDER BY 1
    `)).rows;
    const defaults = (await client.query(`
      SELECT
        (SELECT COUNT(*) FROM public.tenants WHERE next_day_rate_cents = 75) AS tenants_next_day_75,
        (SELECT COUNT(*) FROM public.tenants WHERE same_day_rate_cents = 100) AS tenants_same_day_100,
        (SELECT COUNT(*) FROM public.tenants) AS tenants_total
    `)).rows[0];
    const after = (await client.query(`
      SELECT
        (SELECT count(*) FROM public.tenants) AS tenants,
        (SELECT count(*) FROM public.tenant_maintenance_payments) AS occurrences,
        (SELECT count(*) FROM public.check_billing_events) AS usage_events,
        (SELECT count(*) FROM public.check_billing_events
          WHERE tenant_id = $1::uuid) AS freedom_events,
        (SELECT count(*) FROM public.tenant_maintenance_payments
          WHERE id = $2::uuid) AS legacy_penny,
        (SELECT count(*) FROM public.tenant_invoice_allocations) AS allocations,
        (SELECT count(*) FROM public.tenant_maintenance_payments
          WHERE tenant_id = $1::uuid AND billing_period IS NOT NULL) AS freedom_period_invoices
    `, [FREEDOM, LEGACY])).rows[0];
    const legacyAfter = (await client.query(`
      SELECT id, amount_cents, billing_period, status, provider_transfer_id, created_at
      FROM public.tenant_maintenance_payments WHERE id = $1::uuid
    `, [LEGACY])).rows[0] || null;
    const destAfter = (await client.query(`
      SELECT environment, moov_account_id, moov_payment_method_id
      FROM public.platform_billing_destination WHERE environment = 'production'
    `)).rows[0] || null;

    const countsPreserved = String(before.tenants) === String(after.tenants)
      && String(before.occurrences) === String(after.occurrences)
      && String(before.usage_events) === String(after.usage_events)
      && String(before.freedom_events) === String(after.freedom_events)
      && String(before.legacy_penny) === String(after.legacy_penny);
    const legacyUnchanged = legacyBefore
      && legacyAfter
      && String(legacyBefore.amount_cents) === String(legacyAfter.amount_cents)
      && String(legacyBefore.status) === String(legacyAfter.status)
      && String(legacyBefore.billing_period) === String(legacyAfter.billing_period)
      && String(legacyBefore.created_at) === String(legacyAfter.created_at);
    const destUnchanged = destAfter?.moov_account_id === PROD_ACCOUNT
      && destAfter?.moov_payment_method_id === PROD_METHOD;
    const noInvoiceCreated = Number(after.freedom_period_invoices) === 0
      && Number(after.allocations) === 0;

    if (!countsPreserved || !legacyUnchanged || !destUnchanged || !noInvoiceCreated
      || tenantCols.length !== 2 || eventCols.length !== 5 || payCols.length !== 8
      || alloc.length !== 1 || indexes.length < 4 || checks.length < 3) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        rolledBack: true,
        countsPreserved,
        legacyUnchanged,
        destUnchanged,
        noInvoiceCreated,
        before,
        after,
        tenantCols,
        eventCols,
        paymentCols: payCols.map((r) => r.column_name),
        indexes: indexes.map((r) => r.indexname),
        constraints: checks.map((r) => r.conname),
      };
    }

    await client.query('COMMIT');
    return {
      ok: true,
      host,
      database: process.env.DATABASE_NAME || 'checksops',
      tenantCols,
      eventCols: eventCols.map((r) => r.column_name),
      paymentCols: payCols.map((r) => r.column_name),
      allocationTable: true,
      indexes: indexes.map((r) => r.indexname),
      constraints: checks.map((r) => r.conname),
      defaults,
      before,
      after,
      countsPreserved,
      legacyPenny: legacyAfter,
      legacyUnchanged,
      destinationUnchanged: destUnchanged,
      freedomInvoiceCreated: false,
      liveDebitCreated: false,
      productionRecordsMutated: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: String(error.message || error).slice(0, 800) };
  } finally {
    await client.end();
  }
};
