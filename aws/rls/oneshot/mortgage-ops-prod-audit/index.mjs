/**
 * Read-only production audit of accepted Mortgage Ops work.
 * Does not create billing events, apply SQL, post ACH, or mutate data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');

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
    return { ok: false, error: 'audit requires production admin secret' };
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

    const totals = await q(client, `
      SELECT
        count(*) FILTER (
          WHERE accepted_at IS NOT NULL AND status IN ('in_progress', 'completed')
        ) AS accepted_work,
        count(*) FILTER (WHERE status = 'requested') AS requested_only,
        count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        count(*) FILTER (WHERE status = 'completed') AS completed,
        count(DISTINCT tenant_id) FILTER (
          WHERE accepted_at IS NOT NULL AND status IN ('in_progress', 'completed')
        ) AS accepted_tenants,
        count(DISTINCT claim_id) FILTER (
          WHERE accepted_at IS NOT NULL AND status IN ('in_progress', 'completed') AND claim_id IS NOT NULL
        ) AS distinct_claims,
        count(DISTINCT check_intake_item_id) FILTER (
          WHERE accepted_at IS NOT NULL AND status IN ('in_progress', 'completed')
        ) AS distinct_checks,
        min(accepted_at) FILTER (
          WHERE accepted_at IS NOT NULL AND status IN ('in_progress', 'completed')
        ) AS earliest_accepted_at,
        max(accepted_at) FILTER (
          WHERE accepted_at IS NOT NULL AND status IN ('in_progress', 'completed')
        ) AS latest_accepted_at
      FROM public.mortgage_handling_requests
    `);

    const byMonth = await q(client, `
      SELECT to_char(timezone('UTC', accepted_at), 'YYYY-MM') AS month,
             count(*) AS accepted_checks,
             count(DISTINCT tenant_id) AS tenants,
             count(DISTINCT claim_id) AS claims
      FROM public.mortgage_handling_requests
      WHERE accepted_at IS NOT NULL
        AND status IN ('in_progress', 'completed')
      GROUP BY 1
      ORDER BY 1
    `);

    const byTenant = await q(client, `
      SELECT r.tenant_id, t.slug, t.name,
             count(*) AS accepted_checks,
             count(DISTINCT r.claim_id) AS claims,
             count(*) FILTER (
               WHERE r.claim_id IN (
                 SELECT claim_id
                 FROM public.mortgage_handling_requests
                 WHERE tenant_id = r.tenant_id
                   AND accepted_at IS NOT NULL
                   AND status IN ('in_progress', 'completed')
                   AND claim_id IS NOT NULL
                 GROUP BY claim_id
                 HAVING count(DISTINCT check_intake_item_id) > 1
               )
             ) AS checks_on_multi_check_claims
      FROM public.mortgage_handling_requests r
      LEFT JOIN public.tenants t ON t.id = r.tenant_id
      WHERE r.accepted_at IS NOT NULL
        AND r.status IN ('in_progress', 'completed')
      GROUP BY r.tenant_id, t.slug, t.name
      ORDER BY accepted_checks DESC
      LIMIT 25
    `);

    const multiCheckClaims = await q(client, `
      SELECT count(*) AS claims_with_multiple_checks
      FROM (
        SELECT tenant_id, claim_id
        FROM public.mortgage_handling_requests
        WHERE accepted_at IS NOT NULL
          AND status IN ('in_progress', 'completed')
          AND claim_id IS NOT NULL
        GROUP BY tenant_id, claim_id
        HAVING count(DISTINCT check_intake_item_id) > 1
      ) s
    `);

    const identityReady = await q(client, `
      SELECT
        count(*) FILTER (WHERE tenant_id IS NULL) AS missing_tenant,
        count(*) FILTER (WHERE check_intake_item_id IS NULL) AS missing_check,
        count(*) FILTER (
          WHERE claim_id IS NULL AND accepted_at IS NOT NULL AND status IN ('in_progress', 'completed')
        ) AS accepted_missing_claim,
        count(*) FILTER (WHERE id IS NULL) AS missing_request
      FROM public.mortgage_handling_requests
      WHERE accepted_at IS NOT NULL
        AND status IN ('in_progress', 'completed')
    `);

    const alreadyBilled = await q(client, `
      SELECT
        count(*) FILTER (WHERE event_type = 'mortgage_ops_initial') AS mortgage_ops_initial,
        count(*) FILTER (WHERE event_type = 'mortgage_ops_additional_check') AS mortgage_ops_additional_check,
        count(*) FILTER (
          WHERE event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
        ) AS mortgage_ops_events
      FROM public.check_billing_events
    `);

    const acceptedItems = await q(client, `
      SELECT r.id AS request_id, r.tenant_id, t.slug, r.claim_id, r.check_intake_item_id,
             r.status, r.accepted_at, r.assigned_employee_id
      FROM public.mortgage_handling_requests r
      LEFT JOIN public.tenants t ON t.id = r.tenant_id
      WHERE r.accepted_at IS NOT NULL
        AND r.status IN ('in_progress', 'completed')
      ORDER BY r.accepted_at ASC
      LIMIT 50
    `);

    const counts = await q(client, `
      SELECT
        (SELECT count(*) FROM public.tenants) AS tenants,
        (SELECT count(*) FROM public.check_billing_events) AS check_billing_events,
        (SELECT count(*) FROM public.tenant_maintenance_payments) AS tenant_maintenance_payments,
        (SELECT count(*) FROM public.tenant_invoice_allocations) AS tenant_invoice_allocations,
        (SELECT count(*) FROM public.mortgage_handling_requests) AS mortgage_handling_requests
    `);

    const sql44 = await q(client, `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants'
        AND column_name IN ('next_day_rate_cents', 'same_day_rate_cents')
    `);
    const sql44Alloc = await q(client, `
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'tenant_invoice_allocations'
    `);
    const sql45 = await q(client, `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants'
        AND column_name IN ('mortgage_ops_initial_rate_cents', 'mortgage_ops_additional_rate_cents')
    `);
    const sql45EventCols = await q(client, `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'check_billing_events'
        AND column_name IN ('claim_id', 'mortgage_request_id')
    `);
    const sql46 = await q(client, `
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'mortgage_ops_billing_launch'
    `);
    const launch = await q(client, `
      SELECT launched_at, environment, note, created_at
      FROM public.mortgage_ops_billing_launch
      WHERE singleton IS TRUE
    `);

    return {
      ok: true,
      readOnly: identity?.read_only === 'on',
      identity,
      counts: counts[0] || counts,
      totals: totals[0] || totals,
      byMonth,
      byTenant,
      acceptedItems,
      multiCheckClaims: multiCheckClaims[0] || multiCheckClaims,
      identityReady: identityReady[0] || identityReady,
      alreadyBilled: alreadyBilled[0] || alreadyBilled,
      sql44Present: Array.isArray(sql44) && sql44.length === 2 && Array.isArray(sql44Alloc) && sql44Alloc.length === 1,
      sql45Present: Array.isArray(sql45) && sql45.length === 2,
      sql45EventColsPresent: Array.isArray(sql45EventCols) && sql45EventCols.length === 2,
      sql46Present: Array.isArray(sql46) && sql46.length === 1,
      launch: Array.isArray(launch) ? launch[0] || null : null,
      billingEventsCreated: false,
      historicalBackfill: false,
      productionRecordsMutated: false,
      liveDebitCreated: false,
    };
  } finally {
    await client.end();
  }
};
