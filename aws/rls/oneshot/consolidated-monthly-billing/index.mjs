/**
 * Staging-only: apply SQL 44 consolidated monthly tenant billing.
 * Additive schema only. Does not post ACH, mutate production, or change destinations.
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

const adminClient = async () => {
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
  return client;
};

export const handler = async () => {
  let client;
  try {
    client = await adminClient();
  } catch (error) {
    return { ok: false, phase: 'connect', error: String(error.message || error).slice(0, 500) };
  }
  try {
    await client.query('BEGIN');
    await client.query(SQL);
    const tenantCols = (await client.query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants'
        AND column_name IN ('next_day_rate_cents', 'same_day_rate_cents', 'per_check_rate_cents')
      ORDER BY 1
    `)).rows;
    const eventCols = (await client.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'check_billing_events'
        AND column_name IN ('payment_transfer_id', 'billing_period', 'invoice_id', 'source_kind', 'source_id', 'check_intake_item_id')
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
    const counts = (await client.query(`
      SELECT
        (SELECT count(*) FROM public.tenants) AS tenants,
        (SELECT count(*) FROM public.tenant_maintenance_payments) AS occurrences,
        (SELECT count(*) FROM public.check_billing_events) AS usage_events
    `)).rows[0];
    await client.query('COMMIT');
    return {
      ok: tenantCols.filter((r) => r.column_name !== 'per_check_rate_cents').length >= 2
        && eventCols.filter((r) => r.column_name !== 'check_intake_item_id').length === 5
        && payCols.length === 8
        && alloc.length === 1 && indexes.length >= 3 && checks.length >= 3,
      database: process.env.DATABASE_NAME || 'checksops',
      host: process.env.RDS_HOST,
      tenantCols,
      eventCols,
      paymentCols: payCols.map((r) => r.column_name),
      allocationTable: alloc.length === 1,
      indexes: indexes.map((r) => r.indexname),
      constraints: checks.map((r) => r.conname),
      defaults,
      preservedCounts: counts,
      productionRecordsMutated: false,
      liveDebitCreated: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: String(error.message || error).slice(0, 800) };
  } finally {
    await client.end();
  }
};
