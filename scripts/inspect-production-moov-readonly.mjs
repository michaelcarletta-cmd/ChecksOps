#!/usr/bin/env node
/**
 * READ-ONLY production Moov merchant inspect.
 * Prints account IDs and payment-method metadata only. Never logs secret values.
 * Does not create accounts, payment methods, or transfers.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';
const PROD_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/provider-At4ZFR';
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const MOOV_VERSION = 'v2024.01.00';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};

const oidcToken = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/run/cursor/api.sock',
    path: '/v1/tokens/oidc',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed.token || parsed.oidcToken || parsed);
      } catch (error) { reject(error); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const assumeRole = async () => {
  const role = process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
  const token = await oidcToken();
  const creds = JSON.parse(run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'moov-prod-readonly-inspect',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
    '--output', 'json',
  ])).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
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
  return { ok: res.ok, status: res.status, token: body.access_token || null, error: body.error || body.errorCode || null };
};

const moovGet = async (creds, path, scope) => {
  const auth = await moovToken({ ...creds, scope });
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error, path, cloudflare: false };
  const res = await fetch(`https://api.moov.io${path}`, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Origin: creds.origin,
      Accept: 'application/json',
      'x-moov-version': MOOV_VERSION,
    },
  });
  const text = await res.text();
  const cloudflare = /cloudflare|error code 1010|attention required/i.test(text);
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 240) }; }
  return { ok: res.ok, status: res.status, data, path, cloudflare };
};

const summarizeAccount = (account) => account && typeof account === 'object' ? {
  accountID: account.accountID || account.accountId || null,
  displayName: account.displayName || account.profile?.business?.legalBusinessName || null,
  accountType: account.accountType || null,
  mode: account.mode || account.accountMode || null,
  status: account.status || null,
  verificationStatus: account.verification?.status || null,
} : null;

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeRole();
  const secret = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', PROD_SECRET]);
  const parsed = JSON.parse(secret.SecretString || '{}');
  const keys = Object.keys(parsed).sort();
  const moovKeys = keys.filter((key) => /^MOOV_/i.test(key));
  const creds = {
    key: parsed.MOOV_PUBLIC_KEY || parsed.MOOV_CLIENT_ID || null,
    secret: parsed.MOOV_SECRET_KEY || parsed.MOOV_CLIENT_SECRET || null,
    origin: parsed.MOOV_ALLOWED_ORIGIN || parsed.MOOV_PRODUCTION_ALLOWED_ORIGIN || 'https://checksops.com',
  };
  const configuredIds = [...new Set([
    parsed.MOOV_ACCOUNT_ID,
    parsed.MOOV_PLATFORM_ACCOUNT_ID,
    parsed.MOOV_PRODUCTION_ACCOUNT_ID,
    parsed.MOOV_PRODUCTION_PLATFORM_ACCOUNT_ID,
  ].filter(Boolean))];

  const report = {
    generatedAt: new Date().toISOString(),
    secretArn: PROD_SECRET,
    keys,
    moovKeys,
    flags: {
      hasPublicKey: Boolean(parsed.MOOV_PUBLIC_KEY || parsed.MOOV_CLIENT_ID),
      hasSecretKey: Boolean(parsed.MOOV_SECRET_KEY || parsed.MOOV_CLIENT_SECRET),
      hasAccountId: Boolean(parsed.MOOV_ACCOUNT_ID),
      hasPlatformAccountId: Boolean(parsed.MOOV_PLATFORM_ACCOUNT_ID),
      hasSandboxPlatform: Boolean(parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID),
      sandboxPlatformAccountId: parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID || null,
      moovEnvironment: parsed.MOOV_ENVIRONMENT || null,
      allowedOrigin: parsed.MOOV_ALLOWED_ORIGIN || parsed.MOOV_PRODUCTION_ALLOWED_ORIGIN || null,
    },
    configuredIds,
    sandboxIdInProductionSecret: configuredIds.includes(SANDBOX_MERCHANT),
    list: null,
    merchants: [],
    mutatedMoov: false,
  };

  if (!creds.key || !creds.secret) {
    report.blocked = 'production_moov_credentials_missing';
    await writeFile(`${OUT}/production-moov-inspect.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  report.list = await moovGet(creds, '/accounts', '/accounts.read');
  const rows = Array.isArray(report.list.data)
    ? report.list.data
    : (Array.isArray(report.list.data?.accounts) ? report.list.data.accounts : []);
  report.listedAccounts = rows.map(summarizeAccount);
  report.checksopsCandidates = (report.listedAccounts || []).filter((row) => /checksops/i.test(String(row?.displayName || '')));

  const ids = new Set(configuredIds);
  for (const row of report.checksopsCandidates || []) {
    if (row?.accountID) ids.add(row.accountID);
  }
  for (const accountId of ids) {
    const account = await moovGet(creds, `/accounts/${accountId}`, `/accounts/${accountId}/profile.read`);
    const wallets = await moovGet(creds, `/accounts/${accountId}/wallets`, `/accounts/${accountId}/wallets.read`);
    const methods = await moovGet(creds, `/accounts/${accountId}/payment-methods`, `/accounts/${accountId}/payment-methods.read`);
    const capabilities = await moovGet(creds, `/accounts/${accountId}/capabilities`, `/accounts/${accountId}/capabilities.read`);
    const methodRows = Array.isArray(methods.data) ? methods.data : [];
    const walletMethods = methodRows
      .filter((row) => String(row.paymentMethodType || row.type || '') === 'moov-wallet')
      .map((row) => ({
        paymentMethodID: row.paymentMethodID || row.paymentMethodId || row.id || null,
        paymentMethodType: row.paymentMethodType || row.type || null,
        walletID: row.wallet?.walletID || row.wallet?.walletId || null,
        partnerAccountID: row.wallet?.partnerAccountID || row.wallet?.partnerAccountId || null,
      }));
    report.merchants.push({
      requestedAccountId: accountId,
      isSandboxId: accountId === SANDBOX_MERCHANT,
      accountHttp: account.status,
      cloudflare: account.cloudflare || wallets.cloudflare || methods.cloudflare,
      account: summarizeAccount(account.data),
      walletsHttp: wallets.status,
      wallets: Array.isArray(wallets.data) ? wallets.data.map((row) => ({
        walletID: row.walletID || row.walletId || row.id || null,
        status: row.status || null,
        walletType: row.walletType || row.type || null,
        partnerAccountID: row.partnerAccountID || row.partnerAccountId || null,
      })) : [],
      methodsHttp: methods.status,
      walletPaymentMethods: walletMethods,
      walletPaymentMethodCount: walletMethods.length,
      uniqueWalletDecision: walletMethods.length === 1
        ? 'unique_moov_wallet'
        : (walletMethods.length === 0 ? 'no_moov_wallet' : 'multiple_moov_wallets_do_not_choose'),
      uniqueWallet: walletMethods.length === 1 ? walletMethods[0] : null,
      capabilitiesHttp: capabilities.status,
      capabilities: Array.isArray(capabilities.data)
        ? capabilities.data.map((row) => ({ capability: row.capability || row.name || null, status: row.status || null }))
        : [],
    });
  }

  await writeFile(`${OUT}/production-moov-inspect.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
