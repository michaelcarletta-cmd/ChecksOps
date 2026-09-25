/**
 * Apply monthly tenant billing schema on the target AWS RDS database.
 * Resolves the explicit ChecksOps sandbox merchant destination. Never
 * selects first-wallet at charge time. Does not post a real debit.
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
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';

const adminClient = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be checksops_admin');
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
    query_timeout: 120000,
  });
  await client.connect();
  return client;
};

const resolveSandboxWallet = async () => {
  const accountId = String(process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || SANDBOX_MERCHANT).trim();
  const methodId = String(process.env.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID || '').trim();
  if (accountId !== SANDBOX_MERCHANT) {
    return { ok: false, reason: 'sandbox_destination_must_be_checksops_merchant', accountId };
  }
  if (methodId) {
    return { ok: true, accountId, paymentMethodId: methodId, source: 'env' };
  }
  const arn = process.env.PROVIDER_SECRETS_ARN;
  if (!arn) {
    return {
      ok: false,
      reason: 'destination_payment_method_required',
      accountId,
      message: 'Set AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID to the ChecksOps merchant wallet. Do not select first wallet at charge time.',
    };
  }
  try {
    const sm = new SecretsManagerClient({});
    const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    const parsed = JSON.parse(secret.SecretString || '{}');
    const key = parsed.MOOV_SANDBOX_PUBLIC_KEY;
    const secretKey = parsed.MOOV_SANDBOX_SECRET_KEY;
    const origin = parsed.MOOV_SANDBOX_ALLOWED_ORIGIN || 'https://staging.checksops.com';
    if (!key || !secretKey) {
      return { ok: false, reason: 'sandbox_moov_credentials_missing', accountId };
    }
    const basic = Buffer.from(`${key}:${secretKey}`).toString('base64');
    const tokenRes = await fetch('https://api.moov.io/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: origin,
        'x-moov-version': 'v2024.01.00',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: `/accounts/${accountId}/payment-methods.read`,
      }),
    });
    const tokenBody = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenBody.access_token) {
      return { ok: false, reason: 'moov_token_failed', status: tokenRes.status, accountId };
    }
    const methodsRes = await fetch(`https://api.moov.io/accounts/${accountId}/payment-methods`, {
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        Origin: origin,
        'x-moov-version': 'v2024.01.00',
      },
    });
    const methods = await methodsRes.json().catch(() => []);
    const wallets = (Array.isArray(methods) ? methods : []).filter((row) => (
      String(row?.paymentMethodType || row?.paymentMethodType || '') === 'moov-wallet'
    ));
    if (wallets.length !== 1) {
      return {
        ok: false,
        reason: 'sandbox_wallet_not_unique',
        accountId,
        walletCount: wallets.length,
        message: 'ChecksOps merchant wallet must be uniquely identified. Refusing first-wallet selection.',
      };
    }
    const paymentMethodId = wallets[0].paymentMethodID || wallets[0].paymentMethodId;
    if (!paymentMethodId) return { ok: false, reason: 'wallet_id_missing', accountId };
    return { ok: true, accountId, paymentMethodId, source: 'moov_unique_wallet' };
  } catch (error) {
    return { ok: false, reason: 'moov_resolve_failed', accountId, error: String(error.message || error).slice(0, 180) };
  }
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
    let dest = await resolveSandboxWallet();
    if (!dest.ok) {
      const platformMethod = (await client.query(`
        SELECT provider_account_id, provider_payment_method_id
        FROM public.payment_provider_methods
        WHERE is_platform = true
          AND environment = 'sandbox'
          AND provider_account_id = $1
          AND provider_payment_method_id IS NOT NULL
          AND btrim(provider_payment_method_id) <> ''
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1
      `, [SANDBOX_MERCHANT]).catch(() => ({ rows: [] }))).rows[0];
      if (platformMethod?.provider_payment_method_id) {
        dest = {
          ok: true,
          accountId: SANDBOX_MERCHANT,
          paymentMethodId: platformMethod.provider_payment_method_id,
          source: 'platform_payment_method',
        };
      }
    }
    if (dest.ok) {
      await client.query(
        `INSERT INTO public.platform_billing_destination (
           environment, moov_account_id, moov_payment_method_id, label, verified_at
         ) VALUES ('sandbox', $1, $2, 'ChecksOps sandbox merchant', now())
         ON CONFLICT (environment) DO UPDATE SET
           moov_account_id = EXCLUDED.moov_account_id,
           moov_payment_method_id = EXCLUDED.moov_payment_method_id,
           label = EXCLUDED.label,
           verified_at = now(),
           updated_at = now()`,
        [dest.accountId, dest.paymentMethodId],
      );
    }
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
      WHERE environment = 'sandbox'
    `)).rows[0] || null;
    await client.query('COMMIT');
    return {
      ok: dest.ok === true && tables.length === 2 && columns.length === 3 && index.length === 1,
      database: process.env.DATABASE_NAME || 'checksops',
      destination: dest,
      persisted,
      tables: tables.map((row) => row.table_name),
      occurrenceColumns: columns.map((row) => row.column_name),
      uniqueIndex: index.length === 1,
      productionRecordsMutated: false,
      liveDebitCreated: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: String(error.message || error).slice(0, 500) };
  } finally {
    await client.end();
  }
};
