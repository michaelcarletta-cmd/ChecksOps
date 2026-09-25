/**
 * Read-only V3D production proof.
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
const PROD_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const PROD_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const EXPECTED_CREDIT = '7a78a544-340d-46fd-a4a4-228661374da7';
const EXPECTED_FUND = 'a02c1c81-9ca6-434d-accc-ea4471a70ef2';
const EXPECTED_COLLECT = '128977bb-5034-4e8b-89ed-b10982105aa3';
const EXPECTED_ACCT = '60922058-7eca-4889-81dd-5720d7b9de96';
const RETIRED = [
  'de8f0478-ce49-4505-a72c-be09d9ed494e',
  '27f422af-5a6e-4862-98bc-3ade306c1edd',
];

const q = async (client, sql, params = []) => {
  try {
    return (await client.query(sql, params)).rows;
  } catch (error) {
    return { error: String(error.message || error).slice(0, 400) };
  }
};

const pickDebit = (rails) => {
  const map = rails && typeof rails === 'object' ? rails : {};
  if (map['ach-debit-fund']) {
    return { sourceMethodId: map['ach-debit-fund'], sourceRail: 'ach-debit-fund' };
  }
  if (map['ach-debit-collect']) {
    return { sourceMethodId: map['ach-debit-collect'], sourceRail: 'ach-debit-collect' };
  }
  return { sourceMethodId: null, sourceRail: null };
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
    const method = (await q(client, `
      SELECT id, tenant_id, provider_account_id, provider_payment_method_id, provider_bank_account_id,
             rail_payment_method_ids, rails_synced_at
      FROM public.payment_provider_methods
      WHERE tenant_id = $1::uuid
        AND provider_payment_method_id = $2
      LIMIT 1
    `, [FREEDOM, funding?.provider_payment_method_id || EXPECTED_CREDIT]))[0] || null;
    const rails = method?.rail_payment_method_ids || {};
    const picked = pickDebit(rails);
    const occurrences = await q(client, `
      SELECT id, occurrence_kind, amount_cents, billing_period, status, provider_transfer_id,
             idempotence_key, failure_reason, submitted_at, created_at
      FROM public.tenant_maintenance_payments
      WHERE tenant_id = $1::uuid
      ORDER BY created_at
    `, [FREEDOM]);
    const retiredRows = await q(client, `
      SELECT id, occurrence_kind, status, provider_transfer_id, idempotence_key, created_at
      FROM public.tenant_maintenance_payments
      WHERE idempotence_key = ANY($1::text[])
         OR id::text = ANY($1::text[])
    `, [RETIRED.map((id) => `billing_verification:${FREEDOM}:${id}`).concat(RETIRED)]);
    const transfers = await q(client, `
      SELECT count(*)::int AS count
      FROM public.payment_transfers
      WHERE tenant_id = $1::uuid
        AND created_at >= timestamptz '2026-09-25 00:00:00+00'
    `, [FREEDOM]);
    const invoice = await buildConsolidatedInvoice(client, {
      tenantId: FREEDOM, period: '2026-09', persist: false,
    });
    const verificationRows = Array.isArray(occurrences)
      ? occurrences.filter((row) => row.occurrence_kind === 'billing_verification')
      : [];
    const septemberOccurrence = Array.isArray(occurrences)
      ? occurrences.filter((row) => row.billing_period === '2026-09')
      : [];
    return {
      ok: identity?.read_only === 'on',
      mutated: false,
      liveDebitCreated: false,
      host,
      identity,
      destination: {
        row: dest,
        matchesExpected: dest?.moov_account_id === PROD_ACCOUNT
          && dest?.moov_payment_method_id === PROD_METHOD,
      },
      freedom: {
        provider_account_id: funding?.provider_account_id || null,
        stored_credit_standard: funding?.provider_payment_method_id || null,
        rails,
        rails_synced_at: method?.rails_synced_at || null,
        preferred_debit_fund: rails['ach-debit-fund'] || null,
        fallback_debit_collect: rails['ach-debit-collect'] || null,
        resolved: picked,
        resolvedIsPreferredFund: picked.sourceMethodId === EXPECTED_FUND,
        creditNotSelected: picked.sourceMethodId !== EXPECTED_CREDIT,
        accountMatches: funding?.provider_account_id === EXPECTED_ACCT,
        fundMatches: rails['ach-debit-fund'] === EXPECTED_FUND,
        collectMatches: rails['ach-debit-collect'] === EXPECTED_COLLECT,
        creditMatches: rails['ach-credit-standard'] === EXPECTED_CREDIT
          || funding?.provider_payment_method_id === EXPECTED_CREDIT,
      },
      septemberInvoice: invoice.ok ? {
        amount_cents: invoice.amount_cents,
        maintenance_net_cents: invoice.maintenance_net_cents,
        usage_total_cents: invoice.usage_total_cents,
      } : { ok: false, error: invoice.error || invoice },
      septemberOccurrences: septemberOccurrence,
      verificationOccurrenceCount: verificationRows.length,
      verificationRows,
      retiredAttempts: retiredRows,
      recentTransferCount: Array.isArray(transfers) ? transfers[0]?.count ?? null : transfers,
      occurrences,
    };
  } finally {
    await client.end();
  }
};
