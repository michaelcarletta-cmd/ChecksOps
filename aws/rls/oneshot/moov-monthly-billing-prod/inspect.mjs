/**
 * Read-only production monthly billing inspect. No debit. No dest rewrite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const PROD_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const PROD_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';

export const handler = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops-production/i.test(arn)) {
    return { ok: false, error: 'inspect requires production admin secret' };
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
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
  try {
    const dest = (await client.query(`
      SELECT environment, moov_account_id, moov_payment_method_id, label, verified_at
      FROM public.platform_billing_destination
      ORDER BY environment
    `)).rows;
    const tenants = (await client.query(`
      SELECT t.id, t.slug, t.name, t.subscription_status, t.monthly_rate_cents, t.referral_discount_cents,
             s.billing_enabled, s.billing_day_of_month, s.next_period_start,
             a.auto_debit_enabled, a.ach_authorized_at, a.provider_payment_method_id, a.account_number_last4,
             a.provider_environment
      FROM public.tenants t
      LEFT JOIN public.tenant_billing_settings s ON s.tenant_id = t.id
      LEFT JOIN public.tenant_billing_accounts a ON a.tenant_id = t.id
      ORDER BY t.slug
    `)).rows;
    const history = (await client.query(`
      SELECT tenant_id, billing_period, status, amount_cents, provider_transfer_id,
             destination_account_id, destination_payment_method_id, submitted_at, created_at
      FROM public.tenant_maintenance_payments
      WHERE billing_period IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 20
    `)).rows;
    const liveTransfers = history.filter((row) => row.provider_transfer_id && !String(row.provider_transfer_id).startsWith('sim:'));
    const checkalt = (await client.query(`SELECT count(*)::int AS n FROM public.checkalt_tenant_accounts`)).rows[0];
    const focus = tenants.filter((row) => row.id === FREEDOM || row.id === C1C);
    return {
      ok: true,
      host,
      destination: dest,
      destinationMatches: dest.some((row) => row.environment === 'production' && row.moov_account_id === PROD_ACCOUNT && row.moov_payment_method_id === PROD_METHOD),
      firstWalletFallback: false,
      tenants: focus,
      allTenantSlugs: tenants.map((row) => ({ slug: row.slug, status: row.subscription_status, billing_enabled: row.billing_enabled, authorized: Boolean(row.ach_authorized_at) })),
      history,
      liveMonthlyTransfers: liveTransfers,
      checkaltTenantAccounts: checkalt.n,
      mutated: false,
      liveDebitCreated: false,
    };
  } finally {
    await client.end();
  }
};
