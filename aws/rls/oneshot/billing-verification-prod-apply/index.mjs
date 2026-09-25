/**
 * Production-only: apply SQL 47 typed occurrence_kind.
 * Additive schema only. Does not post ACH, create verification rows, or enable gates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const SQL = fs.readFileSync(path.join(ROOT, '47_billing_verification_occurrence.sql'), 'utf8');
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
  if (process.env.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED === 'true') {
    return { ok: false, error: 'refusing_apply_while_verification_post_true' };
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
      return { ok: false, phase: 'destination_guard', destination: dest };
    }

    const kindExistsBefore = Boolean((await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tenant_maintenance_payments'
        AND column_name='occurrence_kind'
    `)).rows[0]);
    const before = (await client.query(`
      SELECT
        (SELECT count(*) FROM public.tenant_maintenance_payments) AS occurrences,
        (SELECT count(*) FROM public.tenant_invoice_allocations) AS allocations,
        (SELECT count(*) FROM public.check_billing_events) AS usage_events,
        (SELECT count(*) FROM public.tenant_maintenance_payments
          WHERE tenant_id = $1::uuid AND billing_period = '2026-09') AS september_occurrences
    `, [FREEDOM])).rows[0];
    before.verifications = kindExistsBefore
      ? Number((await client.query(`
          SELECT count(*) FROM public.tenant_maintenance_payments
          WHERE occurrence_kind = 'billing_verification'
        `)).rows[0].count)
      : 0;
    const legacyBefore = (await client.query(`
      SELECT id, amount_cents, billing_period, status, provider_transfer_id,
             failure_reason, return_reason, created_at
      FROM public.tenant_maintenance_payments WHERE id = $1::uuid
    `, [LEGACY])).rows[0] || null;

    await client.query('BEGIN');
    await client.query(SQL);

    const kindCol = (await client.query(`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tenant_maintenance_payments'
        AND column_name='occurrence_kind'
    `)).rows[0] || null;
    const checks = (await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'tenant_maintenance_payments_occurrence_kind_check',
        'tenant_maintenance_payments_verification_contract_check'
      )
      ORDER BY 1
    `)).rows.map((row) => row.conname);
    const indexes = (await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname='public'
        AND indexname IN (
          'tenant_maintenance_payments_verification_uidx',
          'tenant_maintenance_payments_idempotence_key_uidx'
        )
      ORDER BY 1
    `)).rows.map((row) => row.indexname);
    const after = (await client.query(`
      SELECT
        (SELECT count(*) FROM public.tenant_maintenance_payments) AS occurrences,
        (SELECT count(*) FROM public.tenant_invoice_allocations) AS allocations,
        (SELECT count(*) FROM public.check_billing_events) AS usage_events,
        (SELECT count(*) FROM public.tenant_maintenance_payments
          WHERE occurrence_kind = 'billing_verification') AS verifications,
        (SELECT count(*) FROM public.tenant_maintenance_payments
          WHERE tenant_id = $1::uuid AND billing_period = '2026-09') AS september_occurrences,
        (SELECT count(*) FROM public.tenant_maintenance_payments
          WHERE occurrence_kind = 'legacy') AS legacy_rows,
        (SELECT count(*) FROM public.tenant_maintenance_payments
          WHERE occurrence_kind = 'monthly_subscription') AS monthly_rows
    `, [FREEDOM])).rows[0];
    const legacyAfter = (await client.query(`
      SELECT id, amount_cents, billing_period, status, provider_transfer_id,
             failure_reason, return_reason, created_at, occurrence_kind
      FROM public.tenant_maintenance_payments WHERE id = $1::uuid
    `, [LEGACY])).rows[0] || null;

    const countsPreserved = String(before.occurrences) === String(after.occurrences)
      && String(before.allocations) === String(after.allocations)
      && String(before.usage_events) === String(after.usage_events)
      && String(before.september_occurrences) === String(after.september_occurrences);
    const noVerificationCreated = Number(after.verifications) === 0;
    const legacyUnchanged = Boolean(legacyBefore && legacyAfter
      && String(legacyBefore.amount_cents) === String(legacyAfter.amount_cents)
      && String(legacyBefore.status) === String(legacyAfter.status)
      && String(legacyBefore.billing_period) === String(legacyAfter.billing_period)
      && String(legacyBefore.provider_transfer_id) === String(legacyAfter.provider_transfer_id)
      && String(legacyBefore.created_at) === String(legacyAfter.created_at)
      && legacyAfter.occurrence_kind === 'legacy');

    if (!kindCol || checks.length !== 2 || indexes.length < 1 || !countsPreserved
      || !noVerificationCreated || !legacyUnchanged) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        rolledBack: true,
        countsPreserved,
        noVerificationCreated,
        legacyUnchanged,
        before,
        after,
        kindCol,
        checks,
        indexes,
        legacyPenny: legacyAfter,
      };
    }

    await client.query('COMMIT');
    return {
      ok: true,
      host,
      liveDebitCreated: false,
      verificationOccurrenceCreated: false,
      productionPost: false,
      verificationPost: false,
      kindCol,
      checks,
      indexes,
      before,
      after,
      countsPreserved,
      noVerificationCreated,
      legacyPenny: legacyAfter,
      legacyUnchanged,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: String(error.message || error).slice(0, 800) };
  } finally {
    await client.end();
  }
};
