#!/usr/bin/env node
/**
 * READ-ONLY: resolve the production ChecksOps facilitator from connected
 * tenant wallet partnerAccountID values. Never selects first wallet.
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
const KNOWN = {
  freedomVerified: '60922058-7eca-4889-81dd-5720d7b9de96',
  freedomUnverified: '7c50c273-89ec-4651-addc-f27330fd4360',
  c1c: '817e1bf0-e1f7-4e9e-95a8-ce15bfa31708',
  pipelineTest: '7597a1f1-79c8-4c80-bbfd-fd5906c2bb73',
};

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
  const creds = JSON.parse(run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN,
    '--role-session-name', 'moov-prod-facilitator-inspect',
    '--web-identity-token', String(await oidcToken()),
    '--duration-seconds', '3600',
    '--output', 'json',
  ])).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
};

const decodeJwtClaims = (token) => {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const allow = ['iss', 'aud', 'scope', 'scopes', 'account_id', 'accountID', 'accountId', 'client_id', 'azp', 'sub'];
    const out = {};
    for (const key of Object.keys(payload)) {
      if (allow.includes(key) || /account/i.test(key)) out[key] = payload[key];
    }
    return out;
  } catch {
    return null;
  }
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
  return {
    ok: res.ok,
    status: res.status,
    token: body.access_token || null,
    claims: body.access_token ? decodeJwtClaims(body.access_token) : null,
    tokenKeys: body && typeof body === 'object' ? Object.keys(body).sort() : [],
    error: body.error || body.errorCode || null,
  };
};

const moovGet = async (creds, path, scope) => {
  const auth = await moovToken({ ...creds, scope });
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error, path, claims: auth.claims };
  const res = await fetch(`https://api.moov.io${path}`, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Origin: creds.origin,
      Accept: 'application/json',
      'x-moov-version': MOOV_VERSION,
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 240) }; }
  return { ok: res.ok, status: res.status, data, path, claims: auth.claims };
};

const summarizeAccount = (account) => account && typeof account === 'object' ? {
  accountID: account.accountID || account.accountId || null,
  displayName: account.displayName || account.profile?.business?.legalBusinessName || null,
  legalBusinessName: account.profile?.business?.legalBusinessName || null,
  accountType: account.accountType || null,
  mode: account.mode || null,
  verificationStatus: account.verification?.status || account.verification?.verificationStatus || null,
  email: account.profile?.business?.email || null,
  website: account.profile?.business?.website || null,
} : null;

const inspectAccount = async (creds, accountId) => {
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
  const partnerIds = [...new Set(methodRows
    .map((row) => row.wallet?.partnerAccountID || row.wallet?.partnerAccountId)
    .filter(Boolean))];
  return {
    requestedAccountId: accountId,
    isSandboxId: accountId === SANDBOX_MERCHANT,
    accountHttp: account.status,
    account: summarizeAccount(account.data),
    tokenClaims: account.claims,
    walletsHttp: wallets.status,
    wallets: Array.isArray(wallets.data) ? wallets.data.map((row) => ({
      walletID: row.walletID || row.walletId || row.id || null,
      status: row.status || null,
      walletType: row.walletType || row.type || null,
      partnerAccountID: row.partnerAccountID || row.partnerAccountId || null,
    })) : [],
    methodsHttp: methods.status,
    paymentMethodTypes: methodRows.map((row) => row.paymentMethodType || row.type || null),
    walletPaymentMethods: walletMethods,
    walletPaymentMethodCount: walletMethods.length,
    partnerAccountIDs: partnerIds,
    uniqueWalletDecision: walletMethods.length === 1
      ? 'unique_moov_wallet'
      : (walletMethods.length === 0 ? 'no_moov_wallet' : 'multiple_moov_wallets_do_not_choose'),
    uniqueWallet: walletMethods.length === 1 ? walletMethods[0] : null,
    capabilities: Array.isArray(capabilities.data)
      ? capabilities.data.map((row) => ({ capability: row.capability || row.name || null, status: row.status || null }))
      : [],
  };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeRole();
  const parsed = JSON.parse(awsJson(['secretsmanager', 'get-secret-value', '--secret-id', PROD_SECRET]).SecretString || '{}');
  const creds = {
    key: parsed.MOOV_PUBLIC_KEY,
    secret: parsed.MOOV_SECRET_KEY,
    origin: parsed.MOOV_ALLOWED_ORIGIN || 'https://checksops.com',
  };
  const listAuth = await moovToken({ ...creds, scope: '/accounts.read' });
  const tenants = {};
  for (const [label, accountId] of Object.entries(KNOWN)) {
    tenants[label] = await inspectAccount(creds, accountId);
  }
  const partnerIds = [...new Set(Object.values(tenants).flatMap((row) => row.partnerAccountIDs || []))];
  const facilitators = [];
  for (const accountId of partnerIds) {
    facilitators.push(await inspectAccount(creds, accountId));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mutatedMoov: false,
    productionSecretHasAccountId: Boolean(parsed.MOOV_ACCOUNT_ID || parsed.MOOV_PLATFORM_ACCOUNT_ID),
    tokenClaimsFromAccountsRead: listAuth.claims,
    tokenKeys: listAuth.tokenKeys,
    tenantPartnerResolution: Object.fromEntries(Object.entries(tenants).map(([label, row]) => [label, {
      accountID: row.account?.accountID || row.requestedAccountId,
      displayName: row.account?.displayName || null,
      partnerAccountIDs: row.partnerAccountIDs,
      walletPaymentMethodCount: row.walletPaymentMethodCount,
    }])),
    uniquePartnerAccountIds: partnerIds,
    facilitators,
    decision: partnerIds.length === 1
      ? 'unique_facilitator_from_partner_account'
      : (partnerIds.length === 0 ? 'facilitator_unresolved' : 'multiple_facilitator_candidates_do_not_choose'),
  };
  await writeFile(`${OUT}/production-facilitator-inspect.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
