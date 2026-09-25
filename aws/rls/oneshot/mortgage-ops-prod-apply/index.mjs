/**
 * Production-only: apply SQL 45 + SQL 46 Mortgage Ops billing (safe mode).
 * Additive schema + auditable launch cutoff. Does not post ACH, backfill, or
 * bill the July 15 historical Freedom acceptance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const SQL45 = fs.readFileSync(path.join(ROOT, '45_mortgage_ops_tenant_billing.sql'), 'utf8');
const SQL46 = fs.readFileSync(path.join(ROOT, '46_mortgage_ops_billing_launch.sql'), 'utf8');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const LEGACY = '68041b0b-563e-4948-b19c-ce6c0c2e1a07';
const PROD_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const PROD_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const JULY_ACCEPTED_AT = '2026-07-15T19:47:15.958Z';

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

const snapshot = async (client) => ({
  counts: (await client.query(`
    SELECT
      (SELECT count(*) FROM public.tenants) AS tenants,
      (SELECT count(*) FROM public.check_billing_events) AS usage_events,
      (SELECT count(*) FROM public.tenant_maintenance_payments) AS occurrences,
      (SELECT count(*) FROM public.tenant_invoice_allocations) AS allocations,
      (SELECT count(*) FROM public.mortgage_handling_requests) AS mortgage_requests,
      (SELECT count(*) FROM public.check_billing_events
        WHERE event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')) AS mortgage_events,
      (SELECT count(*) FROM public.tenant_maintenance_payments WHERE id = $1::uuid) AS legacy_penny
  `, [LEGACY])).rows[0],
  legacy: (await client.query(`
    SELECT id, amount_cents, billing_period, status, provider_transfer_id, created_at
    FROM public.tenant_maintenance_payments WHERE id = $1::uuid
  `, [LEGACY])).rows[0] || null,
  destination: (await client.query(`
    SELECT environment, moov_account_id, moov_payment_method_id
    FROM public.platform_billing_destination WHERE environment = 'production'
  `)).rows[0] || null,
  july: (await client.query(`
    SELECT r.id, r.tenant_id, r.claim_id, r.check_intake_item_id, r.accepted_at, r.status
    FROM public.mortgage_handling_requests r
    WHERE r.tenant_id = $1::uuid
      AND r.accepted_at = $2::timestamptz
    ORDER BY r.accepted_at
    LIMIT 5
  `, [FREEDOM, JULY_ACCEPTED_AT])).rows,
});

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
    const before = await snapshot(client);
    if (!before.destination
      || before.destination.moov_account_id !== PROD_ACCOUNT
      || before.destination.moov_payment_method_id !== PROD_METHOD) {
      return { ok: false, phase: 'destination_guard', destination: before.destination };
    }
    if (Number(before.counts.mortgage_events) !== 0) {
      return { ok: false, phase: 'existing_mortgage_events', counts: before.counts };
    }

    await client.query('BEGIN');
    await client.query(SQL45);
    await client.query(SQL46);
    const launch = (await client.query(`
      INSERT INTO public.mortgage_ops_billing_launch (singleton, launched_at, environment, note)
      VALUES (
        true,
        clock_timestamp(),
        'production',
        'Production Mortgage Ops usage billing launch. Acceptances before launched_at are never accrued. No historical backfill.'
      )
      ON CONFLICT (singleton) DO NOTHING
      RETURNING launched_at, environment, note, created_at
    `)).rows[0] || (await client.query(`
      SELECT launched_at, environment, note, created_at
      FROM public.mortgage_ops_billing_launch
      WHERE singleton IS TRUE
    `)).rows[0];

    const tenantCols = (await client.query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants'
        AND column_name IN ('mortgage_ops_initial_rate_cents', 'mortgage_ops_additional_rate_cents')
      ORDER BY 1
    `)).rows;
    const eventCols = (await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'check_billing_events'
        AND column_name IN ('claim_id', 'mortgage_request_id')
      ORDER BY 1
    `)).rows;
    const indexes = (await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'check_billing_events_mortgage_ops_check_uidx',
          'check_billing_events_mortgage_ops_initial_claim_uidx'
        )
      ORDER BY 1
    `)).rows;
    const trigger = (await client.query(`
      SELECT tgname FROM pg_trigger WHERE tgname = 'tr_accrue_mortgage_ops_billing'
    `)).rows;
    const defaults = (await client.query(`
      SELECT
        (SELECT COUNT(*) FROM public.tenants WHERE mortgage_ops_initial_rate_cents = 1000) AS tenants_initial_1000,
        (SELECT COUNT(*) FROM public.tenants WHERE mortgage_ops_additional_rate_cents = 500) AS tenants_additional_500,
        (SELECT COUNT(*) FROM public.tenants) AS tenants_total,
        (SELECT COUNT(*) FROM public.tenants WHERE mortgage_ops_initial_rate_cents = 0) AS explicit_zero_initial,
        (SELECT COUNT(*) FROM public.tenants WHERE mortgage_ops_additional_rate_cents = 0) AS explicit_zero_additional
    `)).rows[0];
    const after = await snapshot(client);
    const julyEvents = (await client.query(`
      SELECT count(*)::int AS events
      FROM public.check_billing_events e
      WHERE e.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
        AND (
          e.mortgage_request_id = ANY($1::uuid[])
          OR e.check_intake_item_id = ANY($2::uuid[])
        )
    `, [
      after.july.map((row) => row.id),
      after.july.map((row) => row.check_intake_item_id),
    ])).rows[0];

    const countsPreserved = String(before.counts.tenants) === String(after.counts.tenants)
      && String(before.counts.usage_events) === String(after.counts.usage_events)
      && String(before.counts.occurrences) === String(after.counts.occurrences)
      && String(before.counts.allocations) === String(after.counts.allocations)
      && String(before.counts.mortgage_requests) === String(after.counts.mortgage_requests)
      && Number(after.counts.mortgage_events) === 0;
    const legacyUnchanged = before.legacy && after.legacy
      && String(before.legacy.amount_cents) === String(after.legacy.amount_cents)
      && String(before.legacy.status) === String(after.legacy.status)
      && String(before.legacy.billing_period) === String(after.legacy.billing_period)
      && String(before.legacy.created_at) === String(after.legacy.created_at);
    const destUnchanged = after.destination?.moov_account_id === PROD_ACCOUNT
      && after.destination?.moov_payment_method_id === PROD_METHOD;
    const julyUnbilled = Number(julyEvents.events) === 0;
    const schemaOk = tenantCols.length === 2
      && eventCols.length === 2
      && indexes.length === 2
      && trigger.length === 1
      && Boolean(launch?.launched_at)
      && Number(defaults.tenants_initial_1000) === Number(defaults.tenants_total)
      && Number(defaults.tenants_additional_500) === Number(defaults.tenants_total);

    if (!countsPreserved || !legacyUnchanged || !destUnchanged || !julyUnbilled || !schemaOk) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        rolledBack: true,
        countsPreserved,
        legacyUnchanged,
        destUnchanged,
        julyUnbilled,
        schemaOk,
        before,
        after,
        launch,
        tenantCols,
        eventCols: eventCols.map((row) => row.column_name),
        indexes: indexes.map((row) => row.indexname),
        trigger: trigger.map((row) => row.tgname),
        defaults,
      };
    }

    await client.query('COMMIT');
    return {
      ok: true,
      host,
      database: process.env.DATABASE_NAME || 'checksops',
      launch,
      tenantCols,
      eventCols: eventCols.map((row) => row.column_name),
      indexes: indexes.map((row) => row.indexname),
      trigger: trigger.map((row) => row.tgname),
      defaults,
      before,
      after,
      countsPreserved,
      legacyPenny: after.legacy,
      legacyUnchanged,
      destinationUnchanged: destUnchanged,
      julyHistorical: after.july,
      julyUnbilled,
      mortgageEventsCreated: 0,
      historicalBackfill: false,
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
