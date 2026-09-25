/**
 * READ-ONLY inspect of ChecksOps Moov merchant destination.
 * Does not create accounts, payment methods, transfers, or apply SQL.
 * Never selects a "first wallet" when more than one candidate exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const MOOV_VERSION = 'v2024.01.00';

const redactId = (value) => {
  const raw = String(value || '');
  if (raw.length < 8) return raw || null;
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
};

const secretKeysPresent = (parsed) => Object.keys(parsed || {}).sort();

const loadJsonSecret = async (arn) => {
  if (!arn) return { ok: false, reason: 'secret_arn_missing' };
  try {
    const sm = new SecretsManagerClient({});
    const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    const parsed = JSON.parse(secret.SecretString || '{}');
    return { ok: true, parsed, keys: secretKeysPresent(parsed) };
  } catch (error) {
    return {
      ok: false,
      reason: 'secretsmanager_denied_or_failed',
      action: 'secretsmanager:GetSecretValue',
      secretArn: arn,
      error: String(error.name || ''),
      message: String(error.message || error).slice(0, 240),
    };
  }
};

const adminClient = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) {
    throw new Error('ADMIN_SECRET_ARN must be checksops_admin');
  }
  const loaded = await loadJsonSecret(arn);
  if (!loaded.ok) throw new Error(loaded.message || loaded.reason);
  const parsed = loaded.parsed;
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
  return client;
};

const querySafe = async (client, sql, params = []) => {
  try {
    return { ok: true, rows: (await client.query(sql, params)).rows };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 240), rows: [] };
  }
};

const inspectRds = async (client) => {
  const tenants = await querySafe(client, `
    SELECT id, name, slug, is_system_tenant, subscription_status
    FROM public.tenants
    WHERE is_system_tenant = true
       OR name ILIKE '%checksops%'
       OR name ILIKE '%freedom%'
       OR name ILIKE '%c1c%'
       OR slug ILIKE '%checksops%'
       OR slug ILIKE '%freedom%'
       OR slug ILIKE '%c1c%'
    ORDER BY is_system_tenant DESC, name
  `);
  const wallets = await querySafe(client, `
    SELECT
      w.id, w.tenant_id, t.name AS tenant_name, t.slug, t.is_system_tenant,
      w.environment, w.wallet_type, w.name, w.status,
      w.provider_account_id, w.provider_wallet_id, w.provider_payment_method_id
    FROM public.payment_wallets w
    JOIN public.tenants t ON t.id = w.tenant_id
    WHERE w.provider = 'moov'
    ORDER BY w.environment, t.is_system_tenant DESC, t.name, w.wallet_type
  `);
  const platformMethods = await querySafe(client, `
    SELECT
      provider, environment, provider_account_id, provider_payment_method_id,
      payment_method_type, is_platform, connection_status, last_four, nickname
    FROM public.payment_provider_methods
    WHERE is_platform = true
       OR provider_account_id = $1
    ORDER BY environment, is_platform DESC
  `, [SANDBOX_MERCHANT]);
  const destination = await querySafe(client, `
    SELECT environment, moov_account_id, moov_payment_method_id, label, verified_at
    FROM public.platform_billing_destination
    ORDER BY environment
  `);
  const settings = await querySafe(client, `
    SELECT tenant_id, billing_enabled, billing_day_of_month, next_period_start
    FROM public.tenant_billing_settings
    LIMIT 20
  `);
  const authorizations = await querySafe(client, `
    SELECT tenant_id, provider_payment_method_id, ach_authorized_at, ach_authorized_by,
           auto_debit_enabled, account_number_last4, nickname
    FROM public.tenant_billing_accounts
    WHERE provider_payment_method_id IS NOT NULL
       OR ach_authorized_at IS NOT NULL
    LIMIT 20
  `);
  return {
    tenants: tenants.rows,
    wallets: wallets.rows,
    platformMethods: platformMethods.ok ? platformMethods.rows : { error: platformMethods.error },
    destination: destination.ok ? destination.rows : { error: destination.error },
    settings: settings.ok ? settings.rows : { error: settings.error },
    authorizations: authorizations.ok ? authorizations.rows : { error: authorizations.error },
  };
};

const moovToken = async ({ key, secret, origin, scope }) => {
  const basic = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await fetch('https://api.moov.io/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
      'x-moov-version': MOOV_VERSION,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    return { ok: false, status: res.status, error: body.error || body.errorCode || 'token_failed' };
  }
  return { ok: true, token: body.access_token };
};

const moovGet = async ({ key, secret, origin, path, scope }) => {
  const auth = await moovToken({ key, secret, origin, scope });
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error, path };
  const res = await fetch(`https://api.moov.io${path}`, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Origin: origin,
      Accept: 'application/json',
      'x-moov-version': MOOV_VERSION,
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, data, path };
};

const summarizeAccount = (account) => {
  if (!account || typeof account !== 'object') return null;
  return {
    accountID: account.accountID || account.accountId || null,
    displayName: account.displayName || account.profile?.business?.legalBusinessName || null,
    accountType: account.accountType || null,
    mode: account.mode || account.accountMode || null,
    status: account.status || null,
    foreignID: account.foreignID || account.foreignId || null,
    verificationStatus: account.verification?.status || account.verificationStatus || null,
  };
};

const summarizeCapabilities = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => ({
    capability: row.capability || row.name || null,
    status: row.status || null,
  }));
};

const summarizeWallets = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => ({
    walletID: row.walletID || row.walletId || row.id || null,
    status: row.status || null,
    walletType: row.walletType || row.type || null,
    availableBalance: row.availableBalance ?? row.balance?.available ?? null,
    partnerAccountID: row.partnerAccountID || row.partnerAccountId || null,
  }));
};

const summarizeMethods = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => ({
    paymentMethodID: row.paymentMethodID || row.paymentMethodId || row.id || null,
    paymentMethodType: row.paymentMethodType || row.type || null,
    status: row.status || null,
    walletID: row.wallet?.walletID || row.wallet?.walletId || null,
    partnerAccountID: row.wallet?.partnerAccountID || row.wallet?.partnerAccountId || null,
    bankLastFour: row.bankAccount?.lastFourAccountNumber || row.achDetails?.lastFourAccountNumber || null,
  }));
};

const inspectMoovAccount = async (label, creds, accountId) => {
  if (!creds?.key || !creds?.secret || !accountId) {
    return { ok: false, label, reason: 'credentials_or_account_missing', accountId: accountId || null };
  }
  const origin = creds.origin;
  const account = await moovGet({
    key: creds.key,
    secret: creds.secret,
    origin,
    path: `/accounts/${accountId}`,
    scope: `/accounts/${accountId}/profile.read`,
  });
  const wallets = await moovGet({
    key: creds.key,
    secret: creds.secret,
    origin,
    path: `/accounts/${accountId}/wallets`,
    scope: `/accounts/${accountId}/wallets.read`,
  });
  const methods = await moovGet({
    key: creds.key,
    secret: creds.secret,
    origin,
    path: `/accounts/${accountId}/payment-methods`,
    scope: `/accounts/${accountId}/payment-methods.read`,
  });
  const capabilities = await moovGet({
    key: creds.key,
    secret: creds.secret,
    origin,
    path: `/accounts/${accountId}/capabilities`,
    scope: `/accounts/${accountId}/capabilities.read`,
  });
  const methodRows = summarizeMethods(methods.data);
  const walletMethods = methodRows.filter((row) => row.paymentMethodType === 'moov-wallet');
  return {
    ok: account.ok === true,
    label,
    requestedAccountId: accountId,
    accountHttp: account.status,
    account: summarizeAccount(account.data),
    walletsHttp: wallets.status,
    wallets: summarizeWallets(wallets.data),
    methodsHttp: methods.status,
    paymentMethods: methodRows,
    walletPaymentMethods: walletMethods,
    walletPaymentMethodCount: walletMethods.length,
    uniqueWallet: walletMethods.length === 1 ? walletMethods[0] : null,
    uniqueWalletDecision: walletMethods.length === 1
      ? 'unique_moov_wallet'
      : (walletMethods.length === 0 ? 'no_moov_wallet' : 'multiple_moov_wallets_do_not_choose'),
    capabilitiesHttp: capabilities.status,
    capabilities: summarizeCapabilities(capabilities.data),
    errors: [account, wallets, methods, capabilities]
      .filter((row) => !row.ok)
      .map((row) => ({ path: row.path, status: row.status, error: row.error || row.data?.error || null })),
  };
};

const listCandidateAccounts = async (label, creds) => {
  if (!creds?.key || !creds?.secret) {
    return { ok: false, label, reason: 'credentials_missing' };
  }
  const listed = await moovGet({
    key: creds.key,
    secret: creds.secret,
    origin: creds.origin,
    path: '/accounts',
    scope: '/accounts.read',
  });
  const rows = Array.isArray(listed.data)
    ? listed.data
    : (Array.isArray(listed.data?.accounts) ? listed.data.accounts : []);
  const summarized = rows.map(summarizeAccount);
  const checksops = summarized.filter((row) => /checksops/i.test(String(row?.displayName || '')));
  return {
    ok: listed.ok,
    label,
    http: listed.status,
    listedCount: summarized.length,
    checksopsCandidates: checksops,
    allDisplayNames: summarized.map((row) => ({
      accountID: row.accountID,
      displayName: row.displayName,
      status: row.status,
      mode: row.mode,
    })),
    error: listed.ok ? null : (listed.error || listed.data?.error || null),
  };
};

const sandboxCredsFrom = (parsed) => ({
  key: parsed.MOOV_SANDBOX_PUBLIC_KEY || parsed.MOOV_SANDBOX_CLIENT_ID || null,
  secret: parsed.MOOV_SANDBOX_SECRET_KEY || parsed.MOOV_SANDBOX_CLIENT_SECRET || null,
  origin: parsed.MOOV_SANDBOX_ALLOWED_ORIGIN || 'https://staging.checksops.com',
  platformAccountId: parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID || SANDBOX_MERCHANT,
  accountId: parsed.MOOV_SANDBOX_ACCOUNT_ID || parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID || SANDBOX_MERCHANT,
});

const productionCredsFrom = (parsed) => ({
  key: parsed.MOOV_PUBLIC_KEY || parsed.MOOV_CLIENT_ID || null,
  secret: parsed.MOOV_SECRET_KEY || parsed.MOOV_CLIENT_SECRET || null,
  origin: parsed.MOOV_ALLOWED_ORIGIN || parsed.MOOV_PRODUCTION_ALLOWED_ORIGIN || 'https://checksops.com',
  platformAccountId: parsed.MOOV_PLATFORM_ACCOUNT_ID || null,
  accountId: parsed.MOOV_ACCOUNT_ID || parsed.MOOV_PLATFORM_ACCOUNT_ID || null,
  environmentHint: parsed.MOOV_ENVIRONMENT || null,
  hasPublicKey: Boolean(parsed.MOOV_PUBLIC_KEY || parsed.MOOV_CLIENT_ID),
  hasSecretKey: Boolean(parsed.MOOV_SECRET_KEY || parsed.MOOV_CLIENT_SECRET),
  hasAccountId: Boolean(parsed.MOOV_ACCOUNT_ID),
  hasPlatformAccountId: Boolean(parsed.MOOV_PLATFORM_ACCOUNT_ID),
});

export const handler = async () => {
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    mutatedMoov: false,
    appliedSql: false,
    createdTransfer: false,
    selectedFirstWallet: false,
    providerSecret: null,
    rds: null,
    sandbox: null,
    production: null,
  };

  const providerArn = process.env.PROVIDER_SECRETS_ARN || '';
  const loaded = await loadJsonSecret(providerArn);
  report.providerSecret = loaded.ok
    ? {
      ok: true,
      secretArn: providerArn,
      keys: loaded.keys,
      sandbox: {
        hasPublicKey: Boolean(loaded.parsed.MOOV_SANDBOX_PUBLIC_KEY || loaded.parsed.MOOV_SANDBOX_CLIENT_ID),
        hasSecretKey: Boolean(loaded.parsed.MOOV_SANDBOX_SECRET_KEY || loaded.parsed.MOOV_SANDBOX_CLIENT_SECRET),
        platformAccountId: loaded.parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID || null,
      },
      production: productionCredsFrom(loaded.parsed),
    }
    : loaded;

  try {
    const client = await adminClient();
    try {
      report.rds = await inspectRds(client);
    } finally {
      await client.end();
    }
  } catch (error) {
    report.rds = {
      ok: false,
      error: String(error.message || error).slice(0, 300),
    };
  }

  if (loaded.ok) {
    const sandboxCreds = sandboxCredsFrom(loaded.parsed);
    report.sandbox = {
      configuredAccountId: sandboxCreds.accountId,
      list: await listCandidateAccounts('sandbox', sandboxCreds),
      merchant: await inspectMoovAccount('sandbox-merchant', sandboxCreds, SANDBOX_MERCHANT),
    };

    const prodCreds = productionCredsFrom(loaded.parsed);
    const productionAccountIds = [...new Set([prodCreds.accountId, prodCreds.platformAccountId].filter(Boolean))];
    const productionInspects = [];
    for (const accountId of productionAccountIds) {
      if (accountId === SANDBOX_MERCHANT) {
        productionInspects.push({
          ok: false,
          requestedAccountId: accountId,
          reason: 'refused_sandbox_id_as_production_candidate',
        });
        continue;
      }
      productionInspects.push(await inspectMoovAccount('production-configured', prodCreds, accountId));
    }
    report.production = {
      configuredAccountIds: productionAccountIds,
      credentialsPresent: Boolean(prodCreds.key && prodCreds.secret),
      list: (prodCreds.key && prodCreds.secret)
        ? await listCandidateAccounts('production', prodCreds)
        : { ok: false, reason: 'production_moov_credentials_missing' },
      merchants: productionInspects,
    };
  }

  report.ok = true;
  return report;
};
