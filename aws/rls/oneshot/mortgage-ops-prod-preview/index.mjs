/**
 * Read-only production Freedom invoice reconstruction + Mortgage Ops cutoff proof.
 * persist:false engine only. No ACH, no Pull Now, no synthetic accepts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { buildConsolidatedInvoice, loadMortgageOpsBillingLaunch } from './tenant-billing-engine.mjs';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const LEGACY = '68041b0b-563e-4948-b19c-ce6c0c2e1a07';
const PROD_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const PROD_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const JULY_ACCEPTED_AT = '2026-07-15T19:47:15.958Z';

export const handler = async () => {
  if (process.env.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST === 'true') {
    return { ok: false, error: 'refusing_preview_while_production_post_true' };
  }
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops-production/i.test(arn)) {
    return { ok: false, error: 'preview requires production admin secret' };
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
    const launch = await loadMortgageOpsBillingLaunch(client);
    const freedom = (await client.query(`
      SELECT id, slug, name, monthly_rate_cents, referral_discount_cents,
             per_check_rate_cents, next_day_rate_cents, same_day_rate_cents,
             mortgage_ops_initial_rate_cents, mortgage_ops_additional_rate_cents
      FROM public.tenants WHERE id = $1::uuid
    `, [FREEDOM])).rows[0];
    const destination = (await client.query(`
      SELECT environment, moov_account_id, moov_payment_method_id
      FROM public.platform_billing_destination WHERE environment = 'production'
    `)).rows[0] || null;
    const legacy = (await client.query(`
      SELECT id, amount_cents, billing_period, status, provider_transfer_id, created_at
      FROM public.tenant_maintenance_payments WHERE id = $1::uuid
    `, [LEGACY])).rows[0] || null;
    const july = (await client.query(`
      SELECT r.id, r.tenant_id, r.claim_id, r.check_intake_item_id, r.status, r.accepted_at
      FROM public.mortgage_handling_requests r
      WHERE r.tenant_id = $1::uuid
        AND r.accepted_at IS NOT NULL
        AND r.status IN ('in_progress', 'completed')
      ORDER BY r.accepted_at
    `, [FREEDOM])).rows;
    const julyEvents = (await client.query(`
      SELECT count(*)::int AS events
      FROM public.check_billing_events
      WHERE event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
        AND (
          mortgage_request_id = ANY($1::uuid[])
          OR check_intake_item_id = ANY($2::uuid[])
        )
    `, [july.map((row) => row.id), july.map((row) => row.check_intake_item_id)])).rows[0];
    const source = (await client.query(`
      SELECT event_type, count(*)::int AS count, coalesce(sum(unit_price_cents),0)::int AS amount_cents
      FROM public.check_billing_events
      WHERE tenant_id = $1::uuid
        AND billed_at >= '2026-09-01T00:00:00Z'
        AND billed_at < '2026-10-01T00:00:00Z'
        AND status IS DISTINCT FROM 'voided'
      GROUP BY event_type
      ORDER BY 1
    `, [FREEDOM])).rows;
    const mortgageEvents = (await client.query(`
      SELECT id, event_type, unit_price_cents, billed_at, claim_id,
             check_intake_item_id, mortgage_request_id, billing_period
      FROM public.check_billing_events
      WHERE tenant_id = $1::uuid
        AND event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
      ORDER BY billed_at
    `, [FREEDOM])).rows;
    const invoice = await buildConsolidatedInvoice(client, {
      tenantId: FREEDOM,
      period: '2026-09',
      persist: false,
    });

    return {
      ok: invoice?.ok === true,
      readOnly: true,
      host,
      launch: launch.launch,
      freedomRates: {
        monthly_rate_cents: freedom?.monthly_rate_cents ?? null,
        referral_discount_cents: freedom?.referral_discount_cents ?? null,
        per_check_rate_cents: freedom?.per_check_rate_cents ?? null,
        next_day_rate_cents: freedom?.next_day_rate_cents ?? null,
        same_day_rate_cents: freedom?.same_day_rate_cents ?? null,
        mortgage_ops_initial_rate_cents: freedom?.mortgage_ops_initial_rate_cents ?? null,
        mortgage_ops_additional_rate_cents: freedom?.mortgage_ops_additional_rate_cents ?? null,
      },
      destination,
      destinationMatchesExpected: destination?.moov_account_id === PROD_ACCOUNT
        && destination?.moov_payment_method_id === PROD_METHOD,
      legacyPenny: legacy,
      legacyUnchanged: legacy?.id === LEGACY && Number(legacy?.amount_cents) === 1,
      julyHistorical: july,
      julyBeforeCutoff: Boolean(launch.launch?.launched_at)
        && july.every((row) => new Date(row.accepted_at) < new Date(launch.launch.launched_at)),
      julyUnbilled: Number(julyEvents?.events || 0) === 0,
      septemberSource: source,
      mortgageEvents,
      invoice: invoice?.ok ? {
        period: invoice.period,
        maintenance_gross_cents: invoice.maintenance_gross_cents,
        discount_cents: invoice.discount_cents,
        maintenance_net_cents: invoice.maintenance_net_cents,
        check_count: invoice.check_count,
        check_usage_cents: invoice.check_usage_cents,
        next_day_count: invoice.next_day_count,
        next_day_usage_cents: invoice.next_day_usage_cents,
        same_day_count: invoice.same_day_count,
        same_day_usage_cents: invoice.same_day_usage_cents,
        mortgage_ops_initial_count: invoice.mortgage_ops_initial_count,
        mortgage_ops_initial_amount_cents: invoice.mortgage_ops_initial_amount_cents,
        mortgage_ops_additional_count: invoice.mortgage_ops_additional_count,
        mortgage_ops_additional_amount_cents: invoice.mortgage_ops_additional_amount_cents,
        mortgage_ops_usage_cents: invoice.mortgage_ops_usage_cents,
        amount_cents: invoice.amount_cents,
      } : { error: invoice?.error || invoice },
      persist: false,
      pullExecuted: false,
      liveDebitCreated: false,
      historicalBackfill: false,
      productionRecordsMutated: false,
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 800) };
  } finally {
    await client.end();
  }
};
