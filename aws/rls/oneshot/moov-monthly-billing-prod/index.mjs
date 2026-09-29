/**
 * Apply monthly tenant billing schema on production RDS only.
 * Persists the already-approved ChecksOps production merchant destination.
 * Never selects first-wallet. Never posts a debit. Never writes sandbox dest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const SQL = fs.readFileSync(path.join(ROOT, '43_moov_monthly_tenant_billing.sql'), 'utf8');
const PROD_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const PROD_WALLET = '72630a70-4954-4761-b652-e8beff1ad02c';
const PROD_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';

const adminClient = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be checksops_admin');
  if (!/checksops-production/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be the production admin secret');
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  if (!/checksops-production/i.test(String(host || ''))) {
    throw new Error('production SQL oneshot refused a non-production RDS host');
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
  const envAccount = String(process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || '').trim();
  const envMethod = String(process.env.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID || '').trim();
  if (envAccount !== PROD_ACCOUNT || envMethod !== PROD_METHOD) {
    return {
      ok: false,
      phase: 'destination_guard',
      error: 'production destination IDs must be the accepted ChecksOps merchant',
      firstWalletFallback: false,
    };
  }
  if (envAccount === SANDBOX_MERCHANT) {
    return { ok: false, phase: 'destination_guard', error: 'refusing sandbox merchant on production' };
  }

  let client;
  let host;
  try {
    ({ client, host } = await adminClient());
  } catch (error) {
    return { ok: false, phase: 'connect', error: String(error.message || error).slice(0, 500) };
  }

  try {
    await client.query('BEGIN');
    await client.query(SQL);
    await client.query(
      `INSERT INTO public.platform_billing_destination (
         environment, moov_account_id, moov_payment_method_id, label, verified_at
       ) VALUES ('production', $1, $2, 'ChecksOps production merchant', now())
       ON CONFLICT (environment) DO UPDATE SET
         moov_account_id = EXCLUDED.moov_account_id,
         moov_payment_method_id = EXCLUDED.moov_payment_method_id,
         label = EXCLUDED.label,
         verified_at = now(),
         updated_at = now()`,
      [PROD_ACCOUNT, PROD_METHOD],
    );
    const tables = (await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('tenant_billing_settings', 'platform_billing_destination')
      ORDER BY 1
    `)).rows;
    const columns = (await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tenant_maintenance_payments'
        AND column_name IN ('billing_period', 'provider_transfer_id', 'destination_account_id')
      ORDER BY 1
    `)).rows;
    const index = (await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'tenant_maintenance_payments_tenant_period_uidx'
    `)).rows;
    const persisted = (await client.query(`
      SELECT environment, moov_account_id, moov_payment_method_id, label, verified_at
      FROM public.platform_billing_destination
      WHERE environment = 'production'
    `)).rows[0] || null;
    const sandboxDest = (await client.query(`
      SELECT environment, moov_account_id
      FROM public.platform_billing_destination
      WHERE environment = 'sandbox'
    `)).rows[0] || null;
    const checkalt = (await client.query(`
      SELECT count(*)::int AS n FROM public.checkalt_tenant_accounts
    `).catch(() => ({ rows: [{ n: null }] }))).rows[0];
    const tenantCount = (await client.query(`
      SELECT count(*)::int AS n FROM public.tenants
    `)).rows[0];
    await client.query('COMMIT');
    const destOk = persisted?.moov_account_id === PROD_ACCOUNT
      && persisted?.moov_payment_method_id === PROD_METHOD
      && persisted?.moov_account_id !== SANDBOX_MERCHANT;
    return {
      ok: destOk && tables.length === 2 && columns.length === 3 && index.length === 1,
      database: process.env.DATABASE_NAME || 'checksops',
      host,
      destination: {
        ok: destOk,
        accountId: PROD_ACCOUNT,
        walletId: PROD_WALLET,
        paymentMethodId: PROD_METHOD,
        source: 'explicit',
        firstWalletFallback: false,
      },
      persisted,
      sandboxDestinationUntouched: sandboxDest || null,
      tables: tables.map((row) => row.table_name),
      occurrenceColumns: columns.map((row) => row.column_name),
      uniqueIndex: index.length === 1,
      checkaltTenantAccounts: checkalt.n,
      tenantCount: tenantCount.n,
      productionRecordsMutated: false,
      liveDebitCreated: false,
      eventBridgeCreated: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: String(error.message || error).slice(0, 500) };
  } finally {
    await client.end();
  }
};
