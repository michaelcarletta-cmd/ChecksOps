/**
 * Read-only production inspect for SQL 44 safety + Freedom usage audit.
 * Does not apply SQL, create invoices, post ACH, or mutate data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const LEGACY = '68041b0b-563e-4948-b19c-ce6c0c2e1a07';
const PROD_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const PROD_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';

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
             inet_server_addr()::text AS server_addr, current_setting('transaction_read_only') AS read_only
    `))[0];

    const tables = await q(client, `
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'tenant_billing_settings','tenant_billing_accounts','tenant_maintenance_payments',
        'platform_billing_destination','tenant_invoice_allocations','check_billing_events',
        'payment_transfers','check_billing_config'
      )
      ORDER BY 1
    `);
    const tenantCols = await q(client, `
      SELECT column_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tenants'
        AND column_name IN (
          'monthly_rate_cents','referral_discount_cents','per_check_rate_cents',
          'per_check_billing_enabled','next_day_rate_cents','same_day_rate_cents'
        )
      ORDER BY 1
    `);
    const eventCols = await q(client, `
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='check_billing_events'
        AND column_name IN (
          'payment_transfer_id','billing_period','invoice_id','source_kind','source_id',
          'check_intake_item_id','event_type','unit_price_cents','status'
        )
      ORDER BY 1
    `);
    const payCols = await q(client, `
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tenant_maintenance_payments'
        AND column_name IN (
          'maintenance_net_cents','check_usage_cents','next_day_usage_cents','same_day_usage_cents',
          'usage_total_cents','check_count','next_day_count','same_day_count','billing_period'
        )
      ORDER BY 1
    `);
    const indexes = await q(client, `
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname='public' AND (
        indexname IN (
          'check_billing_events_check_processing_uidx',
          'check_billing_events_transfer_fee_uidx',
          'check_billing_events_source_fee_uidx',
          'tenant_maintenance_payments_tenant_period_uidx',
          'idx_unique_processing_event'
        )
        OR tablename IN ('check_billing_events','tenant_maintenance_payments','tenant_invoice_allocations')
      )
      ORDER BY 1
    `);
    const dest = await q(client, `
      SELECT environment, moov_account_id, moov_payment_method_id, label, verified_at
      FROM public.platform_billing_destination ORDER BY environment
    `);

    const counts = (await q(client, `
      SELECT
        (SELECT count(*) FROM public.tenants) AS tenants,
        (SELECT count(*) FROM public.tenant_billing_settings) AS billing_settings,
        (SELECT count(*) FROM public.tenant_billing_accounts) AS billing_accounts,
        (SELECT count(*) FROM public.tenant_maintenance_payments) AS occurrences,
        (SELECT count(*) FROM public.check_billing_events) AS usage_events,
        (SELECT count(*) FROM public.payment_transfers) AS transfers
    `))[0];

    const freedom = (await q(client, `
      SELECT t.id, t.slug, t.name, t.subscription_status,
             t.monthly_rate_cents, t.referral_discount_cents,
             t.per_check_rate_cents, t.per_check_billing_enabled,
             t.next_day_rate_cents, t.same_day_rate_cents,
             s.billing_enabled, s.billing_day_of_month, s.next_period_start,
             a.auto_debit_enabled, a.ach_authorized_at IS NOT NULL AS ach_authorized,
             a.account_number_last4, a.provider_account_id, a.provider_payment_method_id,
             a.provider_environment, a.verification_status
      FROM public.tenants t
      LEFT JOIN public.tenant_billing_settings s ON s.tenant_id = t.id
      LEFT JOIN public.tenant_billing_accounts a ON a.tenant_id = t.id
      WHERE t.id = $1::uuid
    `, [FREEDOM]))[0] || null;

    const config = (await q(client, `
      SELECT id, price_per_check_cents, currency, active
      FROM public.check_billing_config
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `))[0] || null;

    const eventsByStatus = await q(client, `
      SELECT status, count(*)::int AS n
      FROM public.check_billing_events
      WHERE tenant_id = $1::uuid AND event_type = 'check_processing'
      GROUP BY 1 ORDER BY 1
    `, [FREEDOM]);
    const eventsByMonth = await q(client, `
      SELECT to_char(billed_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
             count(*)::int AS n,
             sum(unit_price_cents)::int AS cents,
             count(DISTINCT unit_price_cents)::int AS distinct_prices
      FROM public.check_billing_events
      WHERE tenant_id = $1::uuid AND event_type = 'check_processing'
      GROUP BY 1 ORDER BY 1
    `, [FREEDOM]);
    const septEvents = await q(client, `
      SELECT count(*)::int AS n,
             sum(unit_price_cents)::int AS cents,
             array_agg(DISTINCT unit_price_cents) AS unit_prices,
             count(DISTINCT check_intake_item_id)::int AS distinct_checks
      FROM public.check_billing_events
      WHERE tenant_id = $1::uuid
        AND event_type = 'check_processing'
        AND billed_at >= '2026-09-01T00:00:00.000Z'
        AND billed_at < '2026-10-01T00:00:00.000Z'
    `, [FREEDOM]);
    const eventTypes = await q(client, `
      SELECT event_type, count(*)::int AS n
      FROM public.check_billing_events
      WHERE tenant_id = $1::uuid
      GROUP BY 1 ORDER BY 1
    `, [FREEDOM]);

    const transferCols = await q(client, `
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='payment_transfers'
        AND column_name IN ('requested_speed','selected_rail','speed','status','completed_at')
    `);
    const hasRequested = Array.isArray(transferCols) && transferCols.some((r) => r.column_name === 'requested_speed');
    const hasRail = Array.isArray(transferCols) && transferCols.some((r) => r.column_name === 'selected_rail');
    const septTransfers = await q(client, `
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE lower(status) IN ('completed','settled','succeeded') OR completed_at IS NOT NULL)::int AS qualifying,
             count(*) FILTER (WHERE lower(COALESCE(${hasRequested ? 'requested_speed' : 'speed'}, speed, '')) IN ('same_day','moov_same_day'))::int AS same_day,
             count(*) FILTER (WHERE lower(COALESCE(${hasRequested ? 'requested_speed' : 'speed'}, speed, '')) IN ('standard','next_day','moov_next_day','ach'))::int AS next_day,
             count(*) FILTER (WHERE lower(COALESCE(${hasRequested ? 'requested_speed' : 'speed'}, speed, '')) IN ('instant','rtp','instant_ach','moov_instant'))::int AS instant,
             count(*) FILTER (WHERE lower(status) IN ('failed','canceled','cancelled'))::int AS failed,
             count(*) FILTER (WHERE lower(status) IN ('pending','ready','created','draft'))::int AS pending_ready
      FROM public.payment_transfers
      WHERE tenant_id = $1::uuid
        AND provider = 'moov'
        AND COALESCE(completed_at, created_at) >= '2026-09-01T00:00:00.000Z'
        AND COALESCE(completed_at, created_at) < '2026-10-01T00:00:00.000Z'
    `, [FREEDOM]);
    const septTransferBreakdown = await q(client, `
      SELECT status,
             speed,
             ${hasRequested ? 'requested_speed' : 'NULL::text AS requested_speed'},
             ${hasRail ? 'selected_rail' : 'NULL::text AS selected_rail'},
             count(*)::int AS n
      FROM public.payment_transfers
      WHERE tenant_id = $1::uuid
        AND provider = 'moov'
        AND COALESCE(completed_at, created_at) >= '2026-09-01T00:00:00.000Z'
        AND COALESCE(completed_at, created_at) < '2026-10-01T00:00:00.000Z'
      GROUP BY 1,2,3,4
      ORDER BY 5 DESC
    `, [FREEDOM]);

    const legacy = (await q(client, `
      SELECT id, tenant_id, amount_cents, billing_period, status, provider_transfer_id,
             monthly_rate_cents, discount_cents, created_at
      FROM public.tenant_maintenance_payments
      WHERE id = $1::uuid
    `, [LEGACY]))[0] || null;

    const dupCheckProcessing = await q(client, `
      SELECT check_intake_item_id, count(*)::int AS n
      FROM public.check_billing_events
      WHERE event_type = 'check_processing' AND check_intake_item_id IS NOT NULL
      GROUP BY 1
      HAVING count(*) > 1
      LIMIT 20
    `);
    const dupTransferFee = await q(client, `
      SELECT payment_transfer_id, event_type, count(*)::int AS n
      FROM public.check_billing_events
      WHERE payment_transfer_id IS NOT NULL
        AND event_type IN ('moov_next_day','moov_same_day','moov_instant')
      GROUP BY 1,2
      HAVING count(*) > 1
      LIMIT 20
    `);
    const dupSourceFee = await q(client, `
      SELECT source_kind, source_id, event_type, count(*)::int AS n
      FROM public.check_billing_events
      WHERE source_id IS NOT NULL AND source_kind IS NOT NULL
      GROUP BY 1,2,3
      HAVING count(*) > 1
      LIMIT 20
    `);

    const sql44Present = {
      nextDayRate: Array.isArray(tenantCols) && tenantCols.some((r) => r.column_name === 'next_day_rate_cents'),
      sameDayRate: Array.isArray(tenantCols) && tenantCols.some((r) => r.column_name === 'same_day_rate_cents'),
      eventSourceCols: Array.isArray(eventCols) && eventCols.filter((r) => [
        'payment_transfer_id','billing_period','invoice_id','source_kind','source_id',
      ].includes(r.column_name)).length,
      invoiceUsageCols: Array.isArray(payCols) && payCols.length,
      allocationTable: Array.isArray(tables) && tables.some((r) => r.table_name === 'tenant_invoice_allocations'),
    };

    return {
      ok: true,
      mutated: false,
      liveDebitCreated: false,
      host,
      identity,
      tables: Array.isArray(tables) ? tables.map((r) => r.table_name) : tables,
      tenantCols,
      eventCols,
      paymentCols: Array.isArray(payCols) ? payCols.map((r) => r.column_name) : payCols,
      indexes: Array.isArray(indexes) ? indexes.map((r) => ({ name: r.indexname, def: r.indexdef })) : indexes,
      destination: dest,
      destinationMatches: Array.isArray(dest) && dest.some((row) => (
        row.environment === 'production'
        && row.moov_account_id === PROD_ACCOUNT
        && row.moov_payment_method_id === PROD_METHOD
      )),
      counts,
      freedom,
      checkBillingConfig: config,
      freedomEvents: {
        byStatus: eventsByStatus,
        byMonth: eventsByMonth,
        september: Array.isArray(septEvents) ? septEvents[0] : septEvents,
        byType: eventTypes,
      },
      freedomTransfersSeptember: {
        summary: Array.isArray(septTransfers) ? septTransfers[0] : septTransfers,
        breakdown: septTransferBreakdown,
        hasRequestedSpeed: hasRequested,
        hasSelectedRail: hasRail,
      },
      legacyPenny: legacy,
      uniqueIndexSafety: {
        duplicateCheckProcessing: Array.isArray(dupCheckProcessing) ? dupCheckProcessing.length : dupCheckProcessing,
        duplicateTransferFee: Array.isArray(dupTransferFee) ? dupTransferFee.length : dupTransferFee,
        duplicateSourceFee: Array.isArray(dupSourceFee) ? dupSourceFee.length : dupSourceFee,
        duplicateCheckProcessingRows: Array.isArray(dupCheckProcessing) ? dupCheckProcessing.slice(0, 5) : null,
        safe: Array.isArray(dupCheckProcessing) && dupCheckProcessing.length === 0
          && Array.isArray(dupTransferFee) && dupTransferFee.length === 0
          && Array.isArray(dupSourceFee) && dupSourceFee.length === 0,
      },
      sql44Present,
    };
  } finally {
    await client.end();
  }
};
