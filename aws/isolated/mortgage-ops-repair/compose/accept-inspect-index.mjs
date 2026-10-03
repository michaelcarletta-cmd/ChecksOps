/**
 * Dedicated production Mortgage Ops acceptance inspect.
 * SET default_transaction_read_only=on. Refuses caller SQL and every
 * write action. Does not seed, Accept, Complete, or change SQL/RLS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  '/var/task/rds-global-bundle.pem',
].find((p) => fs.existsSync(p));

const AGENT_ID = 'b100f05d-9e81-4a7b-b9cc-9baf173131d9';
const AGENT_EMAIL = 'claims@freedomadj.com';
const PROD_SUB = '34c8a478-e0d1-70f3-3c49-02225e7404b6';
const HISTORICAL_SUB = '2498c4b8-f0a1-701b-da4b-a1f5c79f675a';
const BILLING_TENANT_ID = '41cbc4b4-c5cd-4020-a6aa-0905e79dafe9';
const MARKER = 'SYNTHETIC-PROD-MOPS-ACCEPT-20261003';
const ACCEPTED_CATALOG = '0d959621d34c99879dc9092cb925bfdb169273a21bea76c6a44242c2d64cd126';

async function connectAdmin() {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops-production/i.test(arn)) {
    throw new Error('inspect requires production admin secret');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('secret username is not checksops_admin');
  }
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
    query_timeout: 30000,
  });
  await client.connect();
  return client;
}

export const handler = async (event = {}) => {
  if (event.sql || event.statement || event.query || event.extra_sql) {
    return { ok: false, inspect_only: true, mutated: false, error: 'refuses_caller_sql' };
  }
  if ((event.action || 'inspect') !== 'inspect') {
    return { ok: false, inspect_only: true, mutated: false, error: `refuses_action:${event.action}` };
  }

  const client = await connectAdmin();
  try {
    await client.query('SET default_transaction_read_only = on');
    const identity = (await client.query(`
      SELECT current_database() AS database,
             current_user AS db_user,
             current_setting('transaction_read_only') AS read_only
    `)).rows[0];
    if (identity.database !== 'checksops') {
      return { ok: false, inspect_only: true, mutated: false, error: `connected_to_${identity.database}` };
    }
    if (identity.read_only !== 'on') {
      return { ok: false, inspect_only: true, mutated: false, error: 'read_only_not_on' };
    }

    const prodLock = (await client.query(
      `SELECT lock.application_user_id::text AS application_user_id,
              lock.cognito_sub,
              account.email,
              COALESCE(account.status, 'active') AS status
       FROM public.identity_production_cognito_locks lock
       LEFT JOIN public.identity_accounts account
         ON account.application_user_id = lock.application_user_id
       WHERE lock.application_user_id = $1::uuid
          OR lock.cognito_sub = ANY($2::text[])`,
      [AGENT_ID, [PROD_SUB, HISTORICAL_SUB]],
    )).rows;

    const stagingAccount = (await client.query(
      `SELECT application_user_id::text, cognito_sub, email, status
       FROM public.identity_accounts
       WHERE application_user_id = $1::uuid OR lower(email) = lower($2)`,
      [AGENT_ID, AGENT_EMAIL],
    )).rows;

    const roles = (await client.query(
      `SELECT role FROM public.user_roles WHERE user_id = $1::uuid ORDER BY role`,
      [AGENT_ID],
    )).rows.map((row) => row.role);

    const tenantUsers = (await client.query(
      `SELECT tenant_id::text, role FROM public.tenant_users WHERE user_id = $1::uuid`,
      [AGENT_ID],
    )).rows;

    const profileFlags = (await client.query(
      `SELECT id::text, email, full_name
       FROM public.profiles WHERE id = $1::uuid`,
      [AGENT_ID],
    )).rows[0] || null;

    const billingTenant = (await client.query(
      `SELECT id::text, name, slug,
              mortgage_ops_initial_rate_cents,
              mortgage_ops_additional_rate_cents
       FROM public.tenants WHERE id = $1::uuid`,
      [BILLING_TENANT_ID],
    )).rows[0] || null;

    const syntheticTenants = (await client.query(
      `SELECT id::text, name, slug,
              mortgage_ops_initial_rate_cents,
              mortgage_ops_additional_rate_cents
       FROM public.tenants
       WHERE slug ILIKE '%synthetic%'
          OR name ILIKE '%SYNTHETIC%'
          OR name ILIKE '%Mortgage Ops Billing%'
       ORDER BY name`,
    )).rows;

    const labeledRequests = (await client.query(
      `SELECT r.id::text, r.status, r.assigned_employee_id::text,
              r.accepted_at, r.completed_at, r.loan_number, r.mortgage_company,
              r.tenant_id::text, t.slug AS tenant_slug
       FROM public.mortgage_handling_requests r
       LEFT JOIN public.tenants t ON t.id = r.tenant_id
       WHERE r.loan_number ILIKE 'GATE%'
          OR r.loan_number ILIKE 'SYNTHETIC%'
          OR r.mortgage_company ILIKE '%SYNTHETIC%'
          OR r.mortgage_company ILIKE 'GATE%'
          OR coalesce(r.note,'') ILIKE '%SYNTHETIC%'
          OR coalesce(r.note,'') ILIKE '%PROD-MOPS-ACCEPT%'
          OR coalesce(r.claim_number,'') ILIKE 'SYNTHETIC%'
       ORDER BY r.created_at DESC
       LIMIT 50`,
    )).rows;

    const queueCounts = (await client.query(
      `SELECT
         count(*) FILTER (WHERE status = 'requested' AND assigned_employee_id IS NULL) AS requested_unassigned,
         count(*) FILTER (WHERE status = 'in_progress' AND assigned_employee_id = $1::uuid) AS mine_in_progress,
         count(*) FILTER (WHERE status = 'completed' AND assigned_employee_id = $1::uuid) AS mine_completed,
         count(*) FILTER (WHERE status = 'in_progress' AND assigned_employee_id IS DISTINCT FROM $1::uuid) AS others_in_progress
       FROM public.mortgage_handling_requests`,
      [AGENT_ID],
    )).rows[0];

    const unassignedClassification = (await client.query(
      `SELECT r.id::text,
              (r.loan_number ILIKE 'GATE%' OR r.loan_number ILIKE 'SYNTHETIC%'
               OR r.mortgage_company ILIKE '%SYNTHETIC%' OR r.mortgage_company ILIKE 'GATE%'
               OR coalesce(r.note,'') ILIKE '%SYNTHETIC%') AS labeled_synthetic,
              (t.slug ILIKE '%synthetic%' OR t.name ILIKE '%SYNTHETIC%') AS synthetic_tenant
       FROM public.mortgage_handling_requests r
       LEFT JOIN public.tenants t ON t.id = r.tenant_id
       WHERE r.status = 'requested' AND r.assigned_employee_id IS NULL
       ORDER BY r.created_at`,
    )).rows;

    const requiredCols = {};
    for (const table of ['tenants', 'claims', 'check_intake_items', 'mortgage_handling_requests', 'check_billing_events']) {
      requiredCols[table] = (await client.query(
        `SELECT column_name, data_type, is_nullable, column_default IS NOT NULL AS has_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [table],
      )).rows.filter((row) => row.is_nullable === 'NO' && !row.has_default).map((row) => `${row.column_name}:${row.data_type}`);
    }

    const SYNTH_TENANT = '6f2c1a90-0ad9-4c3e-9b71-2c8e6d4f1a20';
    const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
    const countOrNull = async (sql, params) => {
      try {
        return (await client.query(sql, params)).rows[0]?.n ?? 0;
      } catch (error) {
        return { error: error?.message || String(error) };
      }
    };
    const freedomMoney = {
      credit_balance: await (async () => {
        try {
          return (await client.query(
            `SELECT tenant_id::text,
                    (stripe_customer_id IS NOT NULL AND btrim(stripe_customer_id) <> '') AS has_stripe_customer
             FROM public.tenant_credit_balances
             WHERE tenant_id = $1::uuid`,
            [FREEDOM_TENANT],
          )).rows;
        } catch (error) {
          return [{ error: error?.message || String(error) }];
        }
      })(),
      platform_fee_line_items_since: await countOrNull(
        `SELECT count(*)::int AS n FROM public.platform_fee_line_items
         WHERE tenant_id = $1::uuid AND created_at >= '2026-10-03T11:40:00Z'`,
        [FREEDOM_TENANT],
      ),
    };
    const freedomRecentBilling = (await client.query(
      `SELECT id::text, event_type, status, unit_price_cents,
              tenant_id::text, claim_id::text, check_intake_item_id::text,
              mortgage_request_id::text, billed_at, created_at
       FROM public.check_billing_events
       WHERE tenant_id = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a'::uuid
         AND created_at >= '2026-10-03T11:40:00Z'
       ORDER BY created_at`,
    )).rows;
    const billingEvents = (await client.query(
      `SELECT id::text, event_type, status, unit_price_cents,
              tenant_id::text, claim_id::text, check_intake_item_id::text,
              mortgage_request_id::text, billed_at, created_at
       FROM public.check_billing_events
       WHERE tenant_id = $1::uuid
          OR event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
             AND (
               claim_id = '4278dd11-6d81-4f5d-9948-6239048fcc4d'::uuid
               OR mortgage_request_id IN (
                 '7a7ec1ce-de9a-4601-875c-4a67db635fd2'::uuid,
                 '71ea6822-df95-4aa9-a04c-4a00a5f6d043'::uuid
               )
             )
       ORDER BY created_at`,
      [SYNTH_TENANT],
    )).rows;

    const moneyMovement = {
      platform_fee_line_items: await countOrNull(
        `SELECT count(*)::int AS n FROM public.platform_fee_line_items WHERE tenant_id = $1::uuid`,
        [SYNTH_TENANT],
      ),
      tenant_credit_balances: await countOrNull(
        `SELECT count(*)::int AS n FROM public.tenant_credit_balances WHERE tenant_id = $1::uuid`,
        [SYNTH_TENANT],
      ),
      tenant_credit_balance_rows: await (async () => {
        try {
          return (await client.query(
            `SELECT tenant_id::text,
                    (stripe_customer_id IS NOT NULL AND btrim(stripe_customer_id) <> '') AS has_stripe_customer
             FROM public.tenant_credit_balances
             WHERE tenant_id = $1::uuid`,
            [SYNTH_TENANT],
          )).rows;
        } catch (error) {
          return [{ error: error?.message || String(error) }];
        }
      })(),
    };

    const launch = (await client.query(
      `SELECT launched_at, environment, note
       FROM public.mortgage_ops_billing_launch WHERE singleton IS TRUE LIMIT 1`,
    )).rows[0] || null;

    const tableUpdate = (await client.query(
      `SELECT grantee, privilege_type, is_grantable
       FROM information_schema.role_table_grants
       WHERE table_schema = 'public'
         AND table_name = 'mortgage_handling_requests'
         AND privilege_type = 'UPDATE'
         AND grantee IN ('checksops', 'authenticated')
       ORDER BY grantee`,
    )).rows;

    const columnUpdate = (await client.query(
      `SELECT grantee, column_name
       FROM information_schema.role_column_grants
       WHERE table_schema = 'public'
         AND table_name = 'mortgage_handling_requests'
         AND privilege_type = 'UPDATE'
         AND grantee = 'checksops'
       ORDER BY column_name`,
    )).rows;

    const mappedProd = prodLock.find((row) => row.cognito_sub === PROD_SUB);
    return {
      ok: true,
      inspect_only: true,
      mutated: false,
      read_only: identity.read_only,
      identity,
      marker: MARKER,
      accepted_catalog_expected: ACCEPTED_CATALOG,
      agent: {
        application_user_id: AGENT_ID,
        email: AGENT_EMAIL,
        production_sub_expected: PROD_SUB,
        production_lock_rows: prodLock,
        production_sub_mapped: Boolean(mappedProd && mappedProd.application_user_id === AGENT_ID),
        staging_account_rows: stagingAccount,
        profile: profileFlags,
        roles,
        tenant_users: tenantUsers,
        elevated: roles.some((role) => ['admin', 'staff'].includes(role)),
        isolated_mortgage_agent: roles.length === 1 && roles[0] === 'mortgage_agent' && tenantUsers.length === 0,
      },
      billing_tenant_41cbc4b4: billingTenant,
      synthetic_tenants: syntheticTenants,
      labeled_requests: labeledRequests,
      do_not_touch: (await client.query(
        `SELECT r.id::text, r.status, r.assigned_employee_id::text,
                r.accepted_at, r.completed_at, r.loan_number, r.mortgage_company,
                r.tenant_id::text, t.slug AS tenant_slug, t.name AS tenant_name
         FROM public.mortgage_handling_requests r
         LEFT JOIN public.tenants t ON t.id = r.tenant_id
         WHERE r.id = '5b20db20-13e1-4919-9528-06388d8661d2'::uuid`,
      )).rows,
      agent_assigned: (await client.query(
        `SELECT r.id::text, r.status, r.assigned_employee_id::text,
                r.accepted_at, r.completed_at, r.loan_number, r.mortgage_company,
                r.tenant_id::text, t.slug AS tenant_slug, t.name AS tenant_name
         FROM public.mortgage_handling_requests r
         LEFT JOIN public.tenants t ON t.id = r.tenant_id
         WHERE r.assigned_employee_id = $1::uuid
         ORDER BY r.updated_at DESC NULLS LAST, r.created_at DESC
         LIMIT 20`,
        [AGENT_ID],
      )).rows,
      billing_events: billingEvents,
      freedom_recent_billing: freedomRecentBilling,
      freedom_money_movement: freedomMoney,
      money_movement: moneyMovement,
      queue_counts: queueCounts,
      unassigned_classification: unassignedClassification,
      required_insert_columns: requiredCols,
      launch,
      privilege_sanity: {
        table_update: tableUpdate,
        checksops_column_update_count: columnUpdate.length,
        checksops_column_update: columnUpdate.map((row) => row.column_name),
      },
    };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
};
