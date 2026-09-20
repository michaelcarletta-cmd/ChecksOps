#!/usr/bin/env node
/**
 * M7.9C: create/link sandbox Moov objects for ChecksOps Pipeline Test and
 * cut the existing sandbox webhook URL to AWS prep. Never prints secret
 * values. Never copies production IDs. Never arms POST flags. Never POSTs
 * transfers. Never creates a duplicate webhook if URL update is allowed.
 * Never modifies Freedom or Freedom Sweep.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';
import { hmacHex } from '../../functions/api/providers/hmac.mjs';
import { verifyMoovWebhookEnvironment } from '../../functions/api/providers/webhooks.mjs';
import { assertNoCrossEnvironmentObject } from '../../functions/api/providers/moov-environment.mjs';
import {
  FIRST_PRODUCTION_TRANSFER_CENTS,
} from '../../functions/api/providers/production/moov-first-test.mjs';
import {
  orchestratePayout,
  payoutOperationIdFor,
} from '../../functions/api/providers/production/moov-payout-orchestrator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const ONESHOT_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/providers/oneshot/m79-sandbox-tenant');
const PRODUCTION_SECRET = 'checksops/production/provider';
const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const FREEDOM_MOOV = KNOWN_APPROVED_MOOV.freedom.moovAccountId;
const PRODUCTION_PLATFORM = KNOWN_APPROVED_MOOV.platform.moovAccountId;
const MICHAEL = KNOWN_APPROVED_MOOV.recipient.moovAccountId;
const LIVE_ORIGIN = PRODUCTION_MOOV_ORIGIN;
const PROVEN_API_VERSION = PRODUCTION_MOOV_API_VERSION;
const PREFERRED_WEBHOOK_URL = 'https://checksops.com/prep/webhooks/moov';
const TEST_ROUTING = '322271627';
const TEST_BANK_ACCOUNT = '12345654321';
const TEST_RECIPIENT_BANK_ACCOUNT = '12345678901';
const INSTANT_CODE = '0001';
const PRODUCTION_IDS = new Set([
  KNOWN_APPROVED_MOOV.freedom.moovAccountId,
  KNOWN_APPROVED_MOOV.freedom.walletId,
  KNOWN_APPROVED_MOOV.freedom.bankId,
  KNOWN_APPROVED_MOOV.freedom.achDebitFundPm,
  KNOWN_APPROVED_MOOV.freedom.walletPm,
  KNOWN_APPROVED_MOOV.freedom.achCreditStandardPm,
  KNOWN_APPROVED_MOOV.c1c.moovAccountId,
  KNOWN_APPROVED_MOOV.platform.moovAccountId,
  KNOWN_APPROVED_MOOV.recipient.moovAccountId,
  KNOWN_APPROVED_MOOV.recipient.bankId,
  KNOWN_APPROVED_MOOV.recipient.achCreditStandardPm,
  KNOWN_APPROVED_MOOV.recipient.walletPm,
  KNOWN_APPROVED_MOOV.recipient.recipientId,
].map((id) => String(id).toLowerCase()));

const POST_ALLOW = [
  /^\/accounts$/,
  /^\/accounts\/[0-9a-f-]+\/wallets$/,
  /^\/accounts\/[0-9a-f-]+\/representatives$/,
  /^\/accounts\/[0-9a-f-]+\/underwriting$/,
  /^\/accounts\/[0-9a-f-]+\/bank-accounts$/,
  /^\/accounts\/[0-9a-f-]+\/bank-accounts\/[0-9a-f-]+\/verify$/,
  /^\/accounts\/[0-9a-f-]+\/bank-accounts\/[0-9a-f-]+\/micro-deposits$/,
  /^\/accounts\/[0-9a-f-]+\/capabilities$/,
  /^\/accounts\/[0-9a-f-]+\/capabilities\/[^/]+$/,
  /^\/webhooks\/[^/]+\/ping$/,
];
const PATCH_ALLOW = [
  /^\/webhooks\/[^/]+$/i,
  /^\/accounts\/[0-9a-f-]+$/i,
  /^\/accounts\/[0-9a-f-]+\/underwriting$/i,
  /^\/accounts\/[0-9a-f-]+\/bank-accounts\/[0-9a-f-]+\/verify$/i,
  /^\/accounts\/[0-9a-f-]+\/bank-accounts\/[0-9a-f-]+\/micro-deposits$/i,
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TEST_ADDRESS = {
  addressLine1: '123 Main Street',
  city: 'Boulder',
  stateOrProvince: 'CO',
  postalCode: '80301',
  country: 'US',
};

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  ...opts,
});
const awsJson = (args) => {
  const out = run(AWS, ['--region', REGION, '--output', 'json', ...args]);
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
      try { resolve(JSON.parse(Buffer.concat(chunks).toString()).token); }
      catch (error) { reject(error); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const assumeRole = async () => {
  const role = process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
  if (!role) throw new Error('CURSOR_AWS_ASSUME_IAM_ROLE_ARN missing');
  const token = await oidcToken();
  const creds = awsJson([
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-m79c-sandbox-objects',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
  ]).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
  return awsJson(['sts', 'get-caller-identity']);
};

const present = (value) => typeof value === 'string' && value.trim().length > 0;
const sha12 = (value) => createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 12);
const fingerprint = (id) => {
  if (!id) return null;
  const s = String(id);
  if (s.length < 12) return '[id]';
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
};
const isProdId = (id) => PRODUCTION_IDS.has(String(id || '').toLowerCase());
const asList = (json) => {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.accounts)) return json.accounts;
  if (Array.isArray(json?.wallets)) return json.wallets;
  if (Array.isArray(json?.bankAccounts)) return json.bankAccounts;
  if (Array.isArray(json?.paymentMethods)) return json.paymentMethods;
  if (Array.isArray(json?.capabilities)) return json.capabilities;
  if (Array.isArray(json?.webhooks)) return json.webhooks;
  return [];
};
const accountIdOf = (row) => row?.accountID || row?.accountId || row?.account?.accountID || row?.id || null;
const walletIdOf = (row) => row?.walletID || row?.walletId || row?.paymentMethodID || row?.id || null;
const bankIdOf = (row) => row?.bankAccountID || row?.bankAccountId || row?.id || null;
const pmIdOf = (row) => row?.paymentMethodID || row?.paymentMethodId || row?.id || null;
const capName = (row) => row?.capability || row?.capabilityID || row?.id || null;
const capStatus = (row) => String(row?.status || '').toLowerCase();
const amountCentsOf = (amount) => {
  if (amount === undefined || amount === null) return 0;
  if (typeof amount === 'object') {
    if (amount.valueDecimal !== undefined && amount.valueDecimal !== null) {
      const dollars = Number(amount.valueDecimal);
      return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
    }
    const raw = amount.value ?? amount.amount ?? 0;
    if (typeof raw === 'string' && raw.includes('.')) {
      const dollars = Number(raw);
      return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  if (typeof amount === 'string' && amount.includes('.')) {
    const dollars = Number(amount);
    return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
  }
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

const waitFn = (name) => {
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const lambdaFlags = () => {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  const env = cfg.Environment?.Variables || {};
  return {
    lastModified: cfg.LastModified,
    codeSha256: cfg.CodeSha256,
    state: cfg.State,
    lastUpdateStatus: cfg.LastUpdateStatus,
    description: cfg.Description || null,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
      AWS_PROVIDER_WEBHOOK_DRY_RUN: env.AWS_PROVIDER_WEBHOOK_DRY_RUN || null,
    },
    vpc: {
      subnetIds: cfg.VpcConfig?.SubnetIds || [],
      securityGroupIds: cfg.VpcConfig?.SecurityGroupIds || [],
    },
    PROVIDER_SECRETS_ARN: env.PROVIDER_SECRETS_ARN,
    MOOV_WEBHOOK_SECRET_ARN: env.MOOV_WEBHOOK_SECRET_ARN,
  };
};

const loadSecret = (id) => {
  const raw = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', id]);
  return {
    name: raw.Name,
    arnEndsWith: String(raw.ARN || '').slice(-36),
    parsed: JSON.parse(raw.SecretString || '{}'),
  };
};

const packOneshot = () => {
  const staging = path.join(os.tmpdir(), 'checksops-m79c-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/77_moov_tenant_environment.sql'), path.join(staging, '77_moov_tenant_environment.sql'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m79c-oneshot.zip');
  fs.rmSync(zipPath, { force: true });
  run('zip', ['-qr', zipPath, '.'], { cwd: staging });
  return zipPath;
};

const ensureOneshot = (zipPath, adminArn, vpc) => {
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminArn,
      RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
    },
  };
  const vpcConfig = `SubnetIds=${vpc.subnetIds.join(',')},SecurityGroupIds=${vpc.securityGroupIds.join(',')}`;
  try {
    awsJson(['lambda', 'get-function-configuration', '--function-name', ONESHOT_FN]);
    run(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', ONESHOT_FN, '--zip-file', `fileb://${zipPath}`]);
    waitFn(ONESHOT_FN);
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT_FN, '--timeout', '120', '--memory-size', '512', '--environment', JSON.stringify(env)]);
    waitFn(ONESHOT_FN);
  } catch {
    awsJson([
      'lambda', 'create-function',
      '--function-name', ONESHOT_FN,
      '--runtime', 'nodejs20.x',
      '--role', ONESHOT_ROLE,
      '--handler', 'index.handler',
      '--timeout', '120',
      '--memory-size', '512',
      '--zip-file', `fileb://${zipPath}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', vpcConfig,
    ]);
    waitFn(ONESHOT_FN);
  }
};

const invokeOneshot = (payload) => {
  const outFile = path.join(os.tmpdir(), `m79c-oneshot-${payload.step}-${Date.now()}.json`);
  run(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', ONESHOT_FN,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(payload),
    outFile,
  ]);
  const raw = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  if (raw.statusCode && raw.body) {
    try { return JSON.parse(raw.body); } catch { return raw; }
  }
  return raw;
};

const basicAuth = (publicKey, secretKey) => (
  `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`
);

const moovOauth = async ({ publicKey, secretKey, origin, scopes }) => {
  const res = await fetch('https://api.moov.io/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuth(publicKey, secretKey),
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: scopes.join(' '),
    }),
  });
  const json = await res.json().catch(() => null);
  return {
    ok: res.ok && Boolean(json?.access_token),
    status: res.status,
    token: json?.access_token || null,
    scope: json?.scope || null,
    error: json?.error || json?.error_description || null,
  };
};

const assertSafeMoovPath = (method, apiPath) => {
  const verb = String(method || 'GET').toUpperCase();
  const p = String(apiPath || '');
  if (/\/transfers(\/|$|\?)/i.test(p)) throw new Error('refused_transfer_path');
  if (verb === 'GET') return;
  if (['PATCH', 'PUT'].includes(verb) && PATCH_ALLOW.some((re) => re.test(p))) return;
  if (verb === 'POST' && POST_ALLOW.some((re) => re.test(p))) return;
  throw new Error(`refused_method_${verb}_${p}`);
};

const moovCall = async ({
  publicKey,
  secretKey,
  token,
  origin,
  apiVersion,
  path: apiPath,
  method = 'GET',
  body,
  extraHeaders = {},
}) => {
  assertSafeMoovPath(method, apiPath);
  const headers = {
    Accept: 'application/json',
    Origin: origin,
    'x-moov-version': apiVersion,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  else headers.Authorization = basicAuth(publicKey, secretKey);
  const res = await fetch(`https://api.moov.io${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 180) }; }
  return {
    ok: res.ok,
    status: res.status,
    path: apiPath,
    method,
    error: json?.error || json?.message || json?.errorCode || null,
    json,
    bodyLen: text.length,
  };
};

const sandboxGet = async (creds, apiPath, scopes) => {
  const oauth = await moovOauth({
    publicKey: creds.publicKey,
    secretKey: creds.secretKey,
    origin: creds.origin,
    scopes,
  });
  if (!oauth.ok) return { ok: false, status: oauth.status, json: null, error: oauth.error, oauth: false };
  const row = await moovCall({
    token: oauth.token,
    origin: creds.origin,
    apiVersion: creds.apiVersion,
    path: apiPath,
  });
  return { ...row, oauth: true };
};

const sandboxWrite = async (creds, apiPath, method, body, scopes) => {
  const oauth = await moovOauth({
    publicKey: creds.publicKey,
    secretKey: creds.secretKey,
    origin: creds.origin,
    scopes,
  });
  if (!oauth.ok) return { ok: false, status: oauth.status, json: null, error: oauth.error, oauth: false };
  const row = await moovCall({
    token: oauth.token,
    origin: creds.origin,
    apiVersion: creds.apiVersion,
    path: apiPath,
    method,
    body,
  });
  return { ...row, oauth: true };
};

const probe = async (pathName, method = 'GET', body = null, headers = {}) => {
  const started = Date.now();
  const res = await fetch(`https://checksops.com/prep${pathName}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 180) }; }
  return {
    path: pathName,
    status: res.status,
    ms: Date.now() - started,
    error: json?.error || null,
    environment: json?.environment || json?.secretEnvironment || null,
    mappedEnvironment: json?.mapped_environment || json?.mappedEnvironment || null,
    mappedTenantId: json?.mapped_tenant_id || null,
    lookup: json?.lookup || null,
    receiptId: json?.receipt_id || null,
    duplicate: json?.duplicate === true,
    applied: json?.applied === true,
    applySkipped: json?.apply_skipped || null,
    createdPaymentTransfer: json?.createdPaymentTransfer === true,
    liveProviderPosted: json?.liveProviderPosted === true,
    liveProviderCalled: json?.liveProviderCalled === true,
    financialTablesMutated: json?.financialTablesMutated === true,
    productionRecordsMutated: json?.productionRecordsMutated === true,
    accepted: json?.accepted === true,
  };
};

const signedWebhook = async (secret, environment, accountId, eventId) => {
  if (!present(secret)) return { environment, skipped: 'secret_missing', status: null };
  const ts = Math.floor(Date.now() / 1000);
  const nonce = `m79c-${environment}-${Date.now()}`;
  const webhookId = eventId || `m79c-${environment}-${Math.random().toString(16).slice(2, 10)}`;
  const body = JSON.stringify({
    eventID: webhookId,
    type: 'account.updated',
    accountID: accountId,
    data: { status: 'updated', source: 'm79c_fixture' },
  });
  const signature = hmacHex(secret, `${ts}|${nonce}|${webhookId}`, 'sha512');
  const result = await probe('/webhooks/moov', 'POST', body, {
    'content-type': 'application/json',
    'x-timestamp': String(ts),
    'x-nonce': nonce,
    'x-webhook-id': webhookId,
    'x-signature': signature,
  });
  return { ...result, eventId: webhookId, signedEnvironment: environment };
};

const looksLikePipeline = (row) => {
  const name = `${row?.displayName || ''} ${row?.profile?.business?.legalBusinessName || ''} ${row?.name || ''}`.toLowerCase();
  const foreign = String(row?.foreignID || row?.foreignId || '').toLowerCase();
  return foreign === PIPELINE.toLowerCase()
    || name.includes('pipeline test')
    || name.includes('checksops pipeline');
};

const inspectMoov = async (creds) => {
  const platformId = creds.platformId;
  const listed = await sandboxGet(creds, '/accounts', ['/accounts.read']);
  const byForeign = await sandboxGet(creds, `/accounts?foreignID=${PIPELINE}`, ['/accounts.read']);
  const accounts = [
    ...asList(listed.json),
    ...asList(byForeign.json),
  ].filter((row, idx, all) => {
    const id = accountIdOf(row);
    return id && all.findIndex((other) => accountIdOf(other) === id) === idx;
  });
  const pipelineAccounts = accounts.filter((row) => looksLikePipeline(row) && !isProdId(accountIdOf(row)));
  const platform = await sandboxGet(creds, `/accounts/${platformId}`, [`/accounts/${platformId}/profile.read`]);
  const webhooksBasic = await moovCall({
    publicKey: creds.publicKey,
    secretKey: creds.secretKey,
    origin: creds.origin,
    apiVersion: creds.apiVersion,
    path: '/webhooks',
  });
  const webhookRows = asList(webhooksBasic.json).map((row) => ({
    id: row.webhookID || row.webhookId || row.id || null,
    url: row.url || row.endpoint || null,
    disabled: row.disabled === true || String(row.status || '').toLowerCase() === 'disabled',
    status: row.status || null,
    events: row.events || row.eventTypes || row.subscribedEvents || null,
    description: row.description || null,
  }));
  const sandboxWebhook = webhookRows.find((row) => {
    try {
      const parsed = new URL(String(row.url || ''));
      return ['checksops.com', 'staging.checksops.com', 'www.checksops.com'].includes(parsed.hostname.toLowerCase())
        && /webhooks\/moov\/?$/i.test(parsed.pathname)
        && row.disabled !== true;
    } catch {
      return false;
    }
  }) || null;

  const details = [];
  for (const account of pipelineAccounts.length ? pipelineAccounts : []) {
    const id = accountIdOf(account);
    const wallets = await sandboxGet(creds, `/accounts/${id}/wallets`, [`/accounts/${id}/wallets.read`]);
    const banks = await sandboxGet(creds, `/accounts/${id}/bank-accounts`, [`/accounts/${id}/bank-accounts.read`]);
    const methods = await sandboxGet(creds, `/accounts/${id}/payment-methods`, [`/accounts/${id}/payment-methods.read`]);
    const caps = await sandboxGet(creds, `/accounts/${id}/capabilities`, [`/accounts/${id}/capabilities.read`]);
    details.push({
      accountId: id,
      accountFp: fingerprint(id),
      displayName: account.displayName || account.profile?.business?.legalBusinessName || null,
      foreignID: account.foreignID || account.foreignId || null,
      mode: account.mode || account.accountMode || null,
      isProductionId: isProdId(id),
      wallets: asList(wallets.json).map((row) => ({
        id: walletIdOf(row),
        status: row.status || null,
        availableCents: amountCentsOf(row.availableBalance ?? row.available),
        pendingCents: amountCentsOf(row.pendingBalance ?? row.pending),
      })),
      banks: asList(banks.json).map((row) => ({
        id: bankIdOf(row),
        status: row.status || null,
        routingNumber: row.routingNumber || row.bankAccount?.routingNumber || null,
        lastFour: row.lastFourAccountNumber || row.lastFour || null,
        bankName: row.bankName || null,
        holderName: row.holderName || row.account?.holderName || null,
      })),
      paymentMethods: asList(methods.json).map((row) => ({
        id: pmIdOf(row),
        type: row.paymentMethodType || row.type || null,
      })),
      capabilities: asList(caps.json).map((row) => ({
        capability: capName(row),
        status: capStatus(row),
      })),
    });
  }

  return {
    listedStatus: listed.status,
    byForeignStatus: byForeign.status,
    accountCount: accounts.length,
    pipelineAccounts: details,
    platform: {
      status: platform.status,
      idFp: fingerprint(accountIdOf(platform.json) || platformId),
      displayName: platform.json?.displayName || null,
      mode: platform.json?.mode || platform.json?.accountMode || null,
    },
    webhooks: webhookRows.map((row) => ({
      idFp: fingerprint(row.id),
      id: row.id,
      url: row.url,
      disabled: row.disabled,
      events: row.events,
    })),
    sandboxWebhook: sandboxWebhook ? {
      id: sandboxWebhook.id,
      idFp: fingerprint(sandboxWebhook.id),
      url: sandboxWebhook.url,
      disabled: sandboxWebhook.disabled,
      events: sandboxWebhook.events,
    } : null,
    existingBeforeCreate: {
      account: details[0]?.accountId || null,
      wallet: details[0]?.wallets?.[0]?.id || null,
      bank: details[0]?.banks?.[0]?.id || null,
      capabilities: details[0]?.capabilities || [],
    },
  };
};

const inspectProductionWebhooks = async (production) => {
  const s = production.parsed;
  if (!present(s.MOOV_PUBLIC_KEY) || !present(s.MOOV_SECRET_KEY)) {
    return { listed: false, skipped: 'production_secret_missing' };
  }
  const listed = await moovCall({
    publicKey: s.MOOV_PUBLIC_KEY,
    secretKey: s.MOOV_SECRET_KEY,
    origin: LIVE_ORIGIN,
    apiVersion: PROVEN_API_VERSION,
    path: '/webhooks',
  });
  return {
    listed: listed.status === 200,
    status: listed.status,
    rows: asList(listed.json).map((row) => ({
      idFp: fingerprint(row.webhookID || row.webhookId || row.id),
      url: row.url || row.endpoint || null,
      disabled: row.disabled === true,
      events: row.events || row.eventTypes || null,
    })),
  };
};

const chooseAccount = (inspect) => {
  const rows = inspect.pipelineAccounts || [];
  const byForeign = rows.find((row) => String(row.foreignID || '').toLowerCase() === PIPELINE.toLowerCase());
  const named = rows.find((row) => String(row.displayName || '').toLowerCase().includes('pipeline'));
  return byForeign || named || rows[0] || null;
};

const acceptTos = async (creds, accountId) => {
  const tokenGet = await sandboxGet(creds, '/tos-token', [`/accounts/${accountId}/profile.write`]);
  const token = tokenGet.json?.token || tokenGet.json?.tosToken || (typeof tokenGet.json === 'string' ? tokenGet.json : null);
  if (present(token)) {
    const patched = await sandboxWrite(creds, `/accounts/${accountId}`, 'PATCH', {
      termsOfService: { token },
    }, [`/accounts/${accountId}/profile.write`]);
    if (patched.ok) return { ok: true, method: 'token', status: patched.status };
  }
  const manual = await sandboxWrite(creds, `/accounts/${accountId}`, 'PATCH', {
    termsOfService: {
      manual: {
        acceptedDate: new Date().toISOString(),
        acceptedIP: '127.0.0.1',
        acceptedUserAgent: 'ChecksOps-M79C/1.0',
        acceptedDomain: 'checksops.com',
      },
    },
  }, [`/accounts/${accountId}/profile.write`]);
  return { ok: manual.ok, method: 'manual', status: manual.status, error: manual.error, tokenStatus: tokenGet.status };
};

const saveUnderwriting = async (creds, accountId) => {
  const body = {
    averageTransactionSize: 10000,
    maxTransactionSize: 50000,
    averageMonthlyTransactionVolume: 100000,
    volumeByCustomerType: {
      businessToBusinessPercentage: 50,
      consumerToBusinessPercentage: 50,
    },
    fulfillment: {
      hasPhysicalGoods: false,
      isShippingProduct: false,
      shipmentDurationDays: 0,
      returnPolicy: 'none',
    },
  };
  const put = await sandboxWrite(creds, `/accounts/${accountId}/underwriting`, 'PUT', body, [`/accounts/${accountId}/profile.write`]);
  if (put.ok) return { ok: true, method: 'PUT', status: put.status };
  const post = await sandboxWrite(creds, `/accounts/${accountId}/underwriting`, 'POST', body, [`/accounts/${accountId}/profile.write`]);
  return { ok: post.ok, method: 'POST', status: post.status, putStatus: put.status, error: post.error || put.error };
};

const completeBusinessOnboarding = async (creds, accountId, created) => {
  const profile = await sandboxWrite(creds, `/accounts/${accountId}`, 'PATCH', {
    profile: {
      business: {
        legalBusinessName: 'ChecksOps Pipeline Test',
        doingBusinessAs: 'Pipeline Test',
        businessType: 'llc',
        email: 'pipeline-test-sandbox@checksops.com',
        website: 'https://checksops.com',
        description: 'Sandbox-only ChecksOps pipeline payout test tenant. No live money.',
        phone: { number: '8185551212', countryCode: '1' },
        address: TEST_ADDRESS,
        taxID: { ein: { number: '123456789' } },
        industryCodes: { mcc: '7372', naics: '541511', sic: '7371' },
        ownersProvided: false,
      },
    },
  }, [`/accounts/${accountId}/profile.write`]);
  const reps = await sandboxGet(creds, `/accounts/${accountId}/representatives`, [`/accounts/${accountId}/representatives.read`]);
  const existingReps = asList(reps.json);
  let representative = { reused: existingReps.length > 0, created: false, status: reps.status };
  if (!existingReps.length) {
    const write = await sandboxWrite(creds, `/accounts/${accountId}/representatives`, 'POST', {
      name: { firstName: 'Pat', lastName: 'Pipeline' },
      email: 'pat.pipeline-sandbox@checksops.com',
      phone: { number: '8185551212', countryCode: '1' },
      address: TEST_ADDRESS,
      birthDate: { year: 1988, month: 6, day: 15 },
      governmentID: { ssn: { full: '123456789' } },
      responsibilities: {
        isController: true,
        isOwner: true,
        ownershipPercentage: 100,
        jobTitle: 'Owner',
      },
    }, [`/accounts/${accountId}/representatives.write`]);
    if (write.ok) created.push('sandbox_representative');
    representative = { reused: false, created: write.ok, status: write.status, error: write.error };
  } else {
    representative = { reused: true, created: false, status: reps.status, count: existingReps.length };
  }
  const owners = await sandboxWrite(creds, `/accounts/${accountId}`, 'PATCH', {
    profile: { business: { ownersProvided: true } },
  }, [`/accounts/${accountId}/profile.write`]);
  const tos = await acceptTos(creds, accountId);
  const underwriting = await saveUnderwriting(creds, accountId);
  return {
    profileStatus: profile.status,
    representative,
    ownersProvidedStatus: owners.status,
    tos,
    underwriting,
  };
};

const completeIndividualOnboarding = async (creds, accountId, created) => {
  const profile = await sandboxWrite(creds, `/accounts/${accountId}`, 'PATCH', {
    profile: {
      individual: {
        name: { firstName: 'Pipeline', lastName: 'Payee' },
        email: 'pipeline-payee-sandbox@checksops.com',
        phone: { number: '3035550100', countryCode: '1' },
        address: TEST_ADDRESS,
        birthDate: { year: 1990, month: 1, day: 15 },
        governmentID: { ssn: { full: '987654321' } },
      },
    },
  }, [`/accounts/${accountId}/profile.write`]);
  const tos = await acceptTos(creds, accountId);
  if (tos.ok) created.push('sandbox_recipient_tos');
  return { profileStatus: profile.status, tos };
};

const waitForWallet = async (creds, accountId) => {
  for (let i = 0; i < 8; i += 1) {
    const listed = await sandboxGet(creds, `/accounts/${accountId}/wallets`, [`/accounts/${accountId}/wallets.read`]);
    const wallets = asList(listed.json);
    const wallet = wallets.find((row) => walletIdOf(row) && !isProdId(walletIdOf(row))) || wallets[0];
    if (wallet && walletIdOf(wallet)) {
      return { listed, wallet, attempts: i + 1 };
    }
    const methodsGet = await sandboxGet(
      creds,
      `/accounts/${accountId}/payment-methods`,
      [`/accounts/${accountId}/payment-methods.read`],
    );
    const methods = asList(methodsGet.json);
    const walletPm = methods.find((row) => {
      const type = String(row.paymentMethodType || row.type || '').toLowerCase();
      const walletId = row.wallet?.walletID || row.walletID || null;
      return type.includes('wallet') && walletId && !isProdId(walletId);
    });
    if (walletPm) {
      const walletId = walletPm.wallet?.walletID || walletPm.walletID;
      return {
        listed,
        wallet: { walletID: walletId, status: 'active', availableBalance: { value: 0 } },
        attempts: i + 1,
        fromPaymentMethod: true,
      };
    }
    await sleep(2000);
  }
  return {
    listed: await sandboxGet(creds, `/accounts/${accountId}/wallets`, [`/accounts/${accountId}/wallets.read`]),
    wallet: null,
    attempts: 8,
  };
};

const ensureCapabilities = async (creds, accountId, created) => {
  const needed = ['transfers', 'wallet', 'send-funds', 'send-funds.ach', 'collect-funds', 'collect-funds.ach'];
  const listed = await sandboxGet(creds, `/accounts/${accountId}/capabilities`, [`/accounts/${accountId}/capabilities.read`]);
  const current = asList(listed.json);
  const byName = new Map(current.map((row) => [String(capName(row)).toLowerCase(), capStatus(row)]));
  const requested = [];
  for (const cap of needed) {
    const status = byName.get(cap);
    if (status === 'enabled' || status === 'pending') continue;
    const write = await sandboxWrite(
      creds,
      `/accounts/${accountId}/capabilities`,
      'POST',
      { capability: cap },
      [`/accounts/${accountId}/capabilities.write`],
    );
    requested.push({ capability: cap, status: write.status, ok: write.ok });
    if (write.ok) created.push(`capability:${cap}`);
  }
  const after = await sandboxGet(creds, `/accounts/${accountId}/capabilities`, [`/accounts/${accountId}/capabilities.read`]);
  return {
    listed: asList(after.json).map((row) => ({ capability: capName(row), status: capStatus(row) })),
    requested,
    collectFundsAch: asList(after.json).some((row) => String(capName(row)).toLowerCase() === 'collect-funds.ach' && ['enabled', 'pending'].includes(capStatus(row))),
  };
};

const ensureAccount = async (creds, inspect, created, reused) => {
  const existing = chooseAccount(inspect);
  if (existing?.accountId) {
    if (isProdId(existing.accountId)) throw new Error('refused_production_account_id');
    reused.push('sandbox_account');
    return { accountId: existing.accountId, created: false, displayName: existing.displayName };
  }
  const write = await sandboxWrite(creds, '/accounts', 'POST', {
    accountType: 'business',
    displayName: 'ChecksOps Pipeline Test',
    profile: {
      business: {
        legalBusinessName: 'ChecksOps Pipeline Test',
        businessType: 'llc',
        email: 'pipeline-test-sandbox@checksops.com',
      },
    },
    capabilities: ['transfers', 'wallet', 'send-funds', 'send-funds.ach', 'collect-funds', 'collect-funds.ach'],
    foreignID: PIPELINE,
    metadata: { checksops_tenant_id: PIPELINE, checksops_purpose: 'm79c_sandbox' },
  }, ['/accounts.write']);
  const accountId = accountIdOf(write.json);
  if (!write.ok || !accountId) {
    return { ok: false, error: `account_create_${write.status}`, detail: write.error };
  }
  if (isProdId(accountId)) throw new Error('created_account_collided_with_production_id');
  created.push('sandbox_account');
  return { accountId, created: true, displayName: 'ChecksOps Pipeline Test', status: write.status };
};

const ensureWallet = async (creds, accountId, inspect, created, reused) => {
  const existing = (chooseAccount(inspect)?.wallets || []).find((row) => row.id && !isProdId(row.id));
  const waited = await waitForWallet(creds, accountId);
  if (waited.wallet && walletIdOf(waited.wallet)) {
    if (existing || waited.attempts > 1) reused.push('sandbox_wallet');
    else reused.push('sandbox_wallet_from_account');
    return {
      walletId: walletIdOf(waited.wallet),
      status: waited.wallet.status || null,
      availableCents: amountCentsOf(waited.wallet.availableBalance ?? waited.wallet.available),
      pendingCents: amountCentsOf(waited.wallet.pendingBalance ?? waited.wallet.pending),
      created: false,
      waitAttempts: waited.attempts,
    };
  }
  const write = await sandboxWrite(creds, `/accounts/${accountId}/wallets`, 'POST', {
    name: 'Operating wallet',
    description: 'ChecksOps Pipeline Test sandbox operating wallet',
  }, [`/accounts/${accountId}/wallets.write`]);
  const walletId = walletIdOf(write.json);
  if (write.ok && walletId && !isProdId(walletId)) {
    created.push('sandbox_wallet');
    return {
      walletId,
      status: write.json?.status || 'active',
      availableCents: amountCentsOf(write.json?.availableBalance ?? write.json?.available),
      pendingCents: amountCentsOf(write.json?.pendingBalance ?? write.json?.pending),
      created: true,
      waitAttempts: waited.attempts,
    };
  }
  return {
    ok: false,
    error: 'sandbox_wallet_missing',
    listedStatus: waited.listed?.status,
    createStatus: write.status,
    createError: write.error,
  };
};

const verifyBank = async (creds, accountId, bankId, created) => {
  const current = await sandboxGet(
    creds,
    `/accounts/${accountId}/bank-accounts/${bankId}`,
    [`/accounts/${accountId}/bank-accounts.read`],
  );
  if (String(current.json?.status || '').toLowerCase() === 'verified') {
    return { verified: true, method: 'already_verified', status: current.json.status };
  }
  const initiate = await sandboxWrite(
    creds,
    `/accounts/${accountId}/bank-accounts/${bankId}/verify`,
    'POST',
    undefined,
    [`/accounts/${accountId}/bank-accounts.write`],
  );
  const instant = await sandboxWrite(
    creds,
    `/accounts/${accountId}/bank-accounts/${bankId}/verify`,
    'PUT',
    { code: INSTANT_CODE },
    [`/accounts/${accountId}/bank-accounts.write`],
  );
  const afterWait = async () => {
    for (let i = 0; i < 5; i += 1) {
      const after = await sandboxGet(
        creds,
        `/accounts/${accountId}/bank-accounts/${bankId}`,
        [`/accounts/${accountId}/bank-accounts.read`],
      );
      if (String(after.json?.status || '').toLowerCase() === 'verified') return after;
      await sleep(1500);
    }
    return sandboxGet(
      creds,
      `/accounts/${accountId}/bank-accounts/${bankId}`,
      [`/accounts/${accountId}/bank-accounts.read`],
    );
  };
  if (instant.ok || instant.status === 200 || instant.status === 204) {
    created.push('sandbox_bank_instant_verify');
    const after = await afterWait();
    return {
      verified: String(after.json?.status || '').toLowerCase() === 'verified',
      method: 'instant_0001',
      initiateStatus: initiate.status,
      confirmStatus: instant.status,
      status: after.json?.status || null,
    };
  }
  const microInit = await sandboxWrite(
    creds,
    `/accounts/${accountId}/bank-accounts/${bankId}/micro-deposits`,
    'POST',
    undefined,
    [`/accounts/${accountId}/bank-accounts.write`],
  );
  const microConfirm = await sandboxWrite(
    creds,
    `/accounts/${accountId}/bank-accounts/${bankId}/micro-deposits`,
    'PUT',
    { amounts: [0, 0] },
    [`/accounts/${accountId}/bank-accounts.write`],
  );
  if (microConfirm.ok || microConfirm.status === 200 || microConfirm.status === 204) {
    created.push('sandbox_bank_micro_verify');
    return {
      verified: true,
      method: 'micro_0_0',
      initiateStatus: microInit.status,
      confirmStatus: microConfirm.status,
      instantStatus: instant.status,
    };
  }
  const after = await sandboxGet(
    creds,
    `/accounts/${accountId}/bank-accounts/${bankId}`,
    [`/accounts/${accountId}/bank-accounts.read`],
  );
  return {
    verified: String(after.json?.status || '').toLowerCase() === 'verified',
    method: 'unverified',
    initiateStatus: initiate.status,
    instantStatus: instant.status,
    microInitStatus: microInit.status,
    microConfirmStatus: microConfirm.status,
    status: after.json?.status || null,
    error: instant.error || microConfirm.error || after.error,
  };
};

const paymentMethodsOf = async (creds, accountId) => {
  const listed = await sandboxGet(
    creds,
    `/accounts/${accountId}/payment-methods`,
    [`/accounts/${accountId}/payment-methods.read`],
  );
  return asList(listed.json).map((row) => ({
    id: pmIdOf(row),
    type: String(row.paymentMethodType || row.type || '').toLowerCase(),
    bankAccountId: row.bankAccount?.bankAccountID || row.bankAccountID || null,
    walletId: row.wallet?.walletID || row.walletID || null,
  }));
};

const ensureBank = async (creds, accountId, inspect, created, reused) => {
  const listed = await sandboxGet(creds, `/accounts/${accountId}/bank-accounts`, [`/accounts/${accountId}/bank-accounts.read`]);
  const banks = asList(listed.json);
  const testVerified = banks.find((row) => String(row.routingNumber || row.bankAccount?.routingNumber || '') === TEST_ROUTING
    && String(row.status || '').toLowerCase() === 'verified'
    && !isProdId(bankIdOf(row)));
  const anyVerified = banks.find((row) => String(row.status || '').toLowerCase() === 'verified' && !isProdId(bankIdOf(row)));
  const testUnverified = banks.find((row) => String(row.routingNumber || row.bankAccount?.routingNumber || '') === TEST_ROUTING
    && !isProdId(bankIdOf(row)));
  let bank = testVerified || anyVerified || testUnverified || null;
  let createdBank = false;
  if (!bank) {
    const write = await sandboxWrite(creds, `/accounts/${accountId}/bank-accounts`, 'POST', {
      account: {
        holderName: 'ChecksOps Pipeline Test',
        holderType: 'business',
        accountNumber: TEST_BANK_ACCOUNT,
        routingNumber: TEST_ROUTING,
        bankAccountType: 'checking',
      },
    }, [`/accounts/${accountId}/bank-accounts.write`]);
    const bankId = bankIdOf(write.json);
    if (!write.ok || !bankId) {
      return { ok: false, error: `bank_create_${write.status}`, detail: write.error };
    }
    if (isProdId(bankId)) throw new Error('created_bank_collided_with_production_id');
    created.push('sandbox_bank');
    createdBank = true;
    bank = write.json;
  } else {
    reused.push('sandbox_bank');
  }
  const bankId = bankIdOf(bank);
  const verification = await verifyBank(creds, accountId, bankId, created);
  const after = await sandboxGet(
    creds,
    `/accounts/${accountId}/bank-accounts/${bankId}`,
    [`/accounts/${accountId}/bank-accounts.read`],
  );
  const methods = await paymentMethodsOf(creds, accountId);
  const achDebit = methods.find((row) => row.type.includes('ach') && row.type.includes('debit') && row.bankAccountId === bankId)
    || methods.find((row) => row.type.includes('ach-debit-fund'))
    || methods.find((row) => row.bankAccountId === bankId);
  return {
    bankId,
    created: createdBank,
    status: after.json?.status || bank.status || null,
    verified: String(after.json?.status || '').toLowerCase() === 'verified' || verification.verified === true,
    verification,
    routingNumber: after.json?.routingNumber || TEST_ROUTING,
    lastFour: after.json?.lastFourAccountNumber || after.json?.lastFour || String(TEST_BANK_ACCOUNT).slice(-4),
    bankName: after.json?.bankName || 'Moov Test Bank',
    paymentMethodId: achDebit?.id || null,
    paymentMethods: methods,
  };
};

const looksLikeRecipient = (row) => {
  const name = `${row?.displayName || ''} ${row?.profile?.individual?.name?.firstName || ''} ${row?.profile?.individual?.name?.lastName || ''}`.toLowerCase();
  const foreign = String(row?.foreignID || row?.foreignId || '').toLowerCase();
  return foreign === `recipient:${PIPELINE}`.toLowerCase()
    || name.includes('pipeline test payee')
    || name.includes('pipeline payee');
};

const ensureRecipient = async (creds, inspectAllAccounts, created, reused) => {
  const listed = await sandboxGet(creds, '/accounts', ['/accounts.read']);
  const byForeign = await sandboxGet(creds, `/accounts?foreignID=${encodeURIComponent(`recipient:${PIPELINE}`)}`, ['/accounts.read']);
  const accounts = [...asList(listed.json), ...asList(byForeign.json)];
  const existing = accounts.find((row) => looksLikeRecipient(row) && !isProdId(accountIdOf(row)) && accountIdOf(row) !== creds.platformId);
  let accountId = existing ? accountIdOf(existing) : null;
  let createdAccount = false;
  if (accountId) {
    reused.push('sandbox_recipient');
  } else {
    const write = await sandboxWrite(creds, '/accounts', 'POST', {
      accountType: 'individual',
      displayName: 'Pipeline Test Payee',
      profile: {
        individual: {
          name: { firstName: 'Pipeline', lastName: 'Payee' },
          email: 'pipeline-payee-sandbox@checksops.com',
        },
      },
      capabilities: ['transfers', 'collect-funds'],
      foreignID: `recipient:${PIPELINE}`,
      metadata: { checksops_tenant_id: PIPELINE, checksops_purpose: 'm79c_sandbox_recipient' },
    }, ['/accounts.write']);
    accountId = accountIdOf(write.json);
    if (!write.ok || !accountId) {
      return { ok: false, error: `recipient_create_${write.status}`, detail: write.error };
    }
    if (isProdId(accountId) || accountId === MICHAEL) throw new Error('refused_production_recipient_id');
    created.push('sandbox_recipient');
    createdAccount = true;
  }
  const recipientKyc = await completeIndividualOnboarding(creds, accountId, created);
  const banks = await sandboxGet(creds, `/accounts/${accountId}/bank-accounts`, [`/accounts/${accountId}/bank-accounts.read`]);
  let bank = asList(banks.json).find((row) => !isProdId(bankIdOf(row)));
  let createdBank = false;
  if (!bank) {
    const write = await sandboxWrite(creds, `/accounts/${accountId}/bank-accounts`, 'POST', {
      account: {
        holderName: 'Pipeline Test Payee',
        holderType: 'individual',
        accountNumber: TEST_RECIPIENT_BANK_ACCOUNT,
        routingNumber: TEST_ROUTING,
        bankAccountType: 'checking',
      },
    }, [`/accounts/${accountId}/bank-accounts.write`]);
    if (!write.ok || !bankIdOf(write.json)) {
      return { ok: false, error: `recipient_bank_create_${write.status}`, detail: write.error, accountId };
    }
    created.push('sandbox_recipient_bank');
    createdBank = true;
    bank = write.json;
  } else {
    reused.push('sandbox_recipient_bank');
  }
  const bankId = bankIdOf(bank);
  const verification = await verifyBank(creds, accountId, bankId, created);
  const after = await sandboxGet(
    creds,
    `/accounts/${accountId}/bank-accounts/${bankId}`,
    [`/accounts/${accountId}/bank-accounts.read`],
  );
  const methods = await paymentMethodsOf(creds, accountId);
  const achCredit = methods.find((row) => row.type.includes('ach') && row.type.includes('credit'))
    || methods.find((row) => row.bankAccountId === bankId);
  const verified = String(after.json?.status || '').toLowerCase() === 'verified' || verification.verified === true;
  return {
    accountId,
    created: createdAccount,
    bankId,
    bankCreated: createdBank,
    verified,
    verification,
    lastFour: after.json?.lastFourAccountNumber || after.json?.lastFour || String(TEST_RECIPIENT_BANK_ACCOUNT).slice(-4),
    bankName: after.json?.bankName || 'Moov Test Bank',
    paymentMethodId: achCredit?.id || null,
    ready: verified && Boolean(accountId) && Boolean(bankId),
    kyc: recipientKyc,
  };
};

const cutWebhook = async (creds, existing, productionBefore) => {
  if (!existing?.id) {
    return { ok: false, stopped: 'sandbox_webhook_missing', createdReplacement: false };
  }
  const beforeUrl = existing.url;
  if (String(beforeUrl || '').replace(/\/$/, '') === PREFERRED_WEBHOOK_URL.replace(/\/$/, '')) {
    return {
      ok: true,
      alreadyPrep: true,
      updated: false,
      createdReplacement: false,
      secretRotated: false,
      productionWebhookChanged: false,
      before: existing,
      after: existing,
    };
  }
  const getBefore = await moovCall({
    publicKey: creds.publicKey,
    secretKey: creds.secretKey,
    origin: creds.origin,
    apiVersion: creds.apiVersion,
    path: `/webhooks/${existing.id}`,
  });
  const secretBefore = await moovCall({
    publicKey: creds.publicKey,
    secretKey: creds.secretKey,
    origin: creds.origin,
    apiVersion: creds.apiVersion,
    path: `/webhooks/${existing.id}/secret`,
  });
  const secretHashBefore = present(secretBefore.json?.secret || secretBefore.json?.webhookSecret)
    ? sha12(secretBefore.json?.secret || secretBefore.json?.webhookSecret)
    : null;
  const body = {
    url: PREFERRED_WEBHOOK_URL,
    status: 'enabled',
    eventTypes: existing.events && Array.isArray(existing.events) && existing.events.length ? existing.events : ['*'],
  };
  const attempts = [];
  let updated = null;
  const bodies = [
    { url: PREFERRED_WEBHOOK_URL },
    {
      url: PREFERRED_WEBHOOK_URL,
      status: 'enabled',
      eventTypes: existing.events && Array.isArray(existing.events) && existing.events.length ? existing.events : ['*'],
    },
  ];
  for (const method of ['PATCH', 'PUT']) {
    for (const payload of bodies) {
      const basic = await moovCall({
        publicKey: creds.publicKey,
        secretKey: creds.secretKey,
        origin: creds.origin,
        apiVersion: creds.apiVersion,
        path: `/webhooks/${existing.id}`,
        method,
        body: payload,
      });
      attempts.push({
        auth: 'basic',
        method,
        status: basic.status,
        error: basic.error,
        url: basic.json?.url || null,
        bodyKeys: Object.keys(payload),
      });
      if (basic.ok) {
        updated = basic;
        break;
      }
    }
    if (updated) break;
  }
  if (!updated) {
    const scopesToTry = [
      ['/webhooks.write'],
      [`/accounts/${creds.platformId}/webhooks.write`],
      ['/webhooks.read', '/webhooks.write'],
    ];
    for (const method of ['PATCH', 'PUT']) {
      for (const scopes of scopesToTry) {
        const oauth = await moovOauth({
          publicKey: creds.publicKey,
          secretKey: creds.secretKey,
          origin: creds.origin,
          scopes,
        });
        if (!oauth.ok) {
          attempts.push({ auth: 'oauth', method, scopes, oauthStatus: oauth.status, error: oauth.error });
          continue;
        }
        const row = await moovCall({
          token: oauth.token,
          origin: creds.origin,
          apiVersion: creds.apiVersion,
          path: `/webhooks/${existing.id}`,
          method,
          body: { url: PREFERRED_WEBHOOK_URL },
        });
        attempts.push({
          auth: 'oauth',
          method,
          scopes,
          status: row.status,
          error: row.error,
          url: row.json?.url || null,
        });
        if (row.ok) {
          updated = row;
          break;
        }
      }
      if (updated) break;
    }
  }
  if (!updated) {
    return {
      ok: false,
      stopped: 'webhook_url_update_not_allowed',
      createdReplacement: false,
      secretRotated: false,
      productionWebhookChanged: false,
      before: { idFp: fingerprint(existing.id), url: beforeUrl, events: existing.events },
      attempts,
      getBeforeStatus: getBefore.status,
      note: 'Moov did not allow URL update on the existing webhook. STOP before creating a replacement.',
    };
  }
  const afterList = await moovCall({
    publicKey: creds.publicKey,
    secretKey: creds.secretKey,
    origin: creds.origin,
    apiVersion: creds.apiVersion,
    path: '/webhooks',
  });
  const afterRows = asList(afterList.json).map((row) => ({
    id: row.webhookID || row.webhookId || row.id,
    url: row.url || row.endpoint,
    disabled: row.disabled === true,
    events: row.events || row.eventTypes,
  }));
  const after = afterRows.find((row) => row.id === existing.id) || {
    id: existing.id,
    url: updated.json?.url || PREFERRED_WEBHOOK_URL,
    disabled: false,
    events: updated.json?.events || updated.json?.eventTypes,
  };
  const secretAfter = await moovCall({
    publicKey: creds.publicKey,
    secretKey: creds.secretKey,
    origin: creds.origin,
    apiVersion: creds.apiVersion,
    path: `/webhooks/${existing.id}/secret`,
  });
  const secretHashAfter = present(secretAfter.json?.secret || secretAfter.json?.webhookSecret)
    ? sha12(secretAfter.json?.secret || secretAfter.json?.webhookSecret)
    : null;
  const productionAfter = await inspectProductionWebhooks({ parsed: { MOOV_PUBLIC_KEY: creds.productionPublicKey, MOOV_SECRET_KEY: creds.productionSecretKey } });
  const productionChanged = JSON.stringify(productionBefore?.rows || []) !== JSON.stringify(productionAfter?.rows || []);
  const duplicateCreated = afterRows.filter((row) => {
    try {
      const parsed = new URL(String(row.url || ''));
      return parsed.hostname.toLowerCase() === 'checksops.com' && /webhooks\/moov\/?$/i.test(parsed.pathname) && row.disabled !== true;
    } catch { return false; }
  }).length > 1;
  return {
    ok: String(after.url || '').replace(/\/$/, '') === PREFERRED_WEBHOOK_URL.replace(/\/$/, '')
      && secretHashBefore === secretHashAfter
      && productionChanged !== true
      && duplicateCreated !== true,
    updated: true,
    createdReplacement: false,
    secretRotated: secretHashBefore !== secretHashAfter,
    productionWebhookChanged: productionChanged === true,
    duplicateCreated,
    before: { idFp: fingerprint(existing.id), url: beforeUrl, events: existing.events },
    after: { idFp: fingerprint(after.id), url: after.url, disabled: after.disabled, events: after.events },
    attempts,
    secretHashUnchanged: secretHashBefore === secretHashAfter,
  };
};

const darkM77 = async ({ creds, accountId, walletId, bank, recipient }) => {
  const wallet = await sandboxGet(
    creds,
    `/accounts/${accountId}/wallets/${walletId}`,
    [`/accounts/${accountId}/wallets.read`],
  );
  const availableCents = amountCentsOf(wallet.json?.availableBalance ?? wallet.json?.available);
  const payoutCents = FIRST_PRODUCTION_TRANSFER_CENTS;
  const operationId = payoutOperationIdFor({
    tenantId: PIPELINE,
    environment: 'sandbox',
    recipientId: recipient.accountId,
    payoutCents,
  });
  const labels = {
    fund: {
      sourceLabel: bank.lastFour ? `${bank.bankName || 'Bank'} ••••${bank.lastFour}` : 'Sandbox funding bank',
      destinationLabel: 'Sandbox wallet',
    },
    disburse: {
      sourceLabel: 'Sandbox wallet',
      destinationLabel: recipient.lastFour ? `${recipient.bankName || 'Bank'} ••••${recipient.lastFour}` : 'Sandbox recipient bank',
      recipientLabel: 'Pipeline Test Payee',
      recipientId: recipient.accountId,
    },
  };
  const common = {
    payoutCents,
    recipientVerified: recipient.verified === true,
    totpFundPresent: false,
    totpDisbursePresent: false,
    transferPostEnabled: false,
    persistMoneyIntents: false,
    environment: 'sandbox',
    tenantId: PIPELINE,
    labels,
  };
  const sufficient = Math.max(availableCents, payoutCents);
  const a = await orchestratePayout({ ...common, availableCents: sufficient });
  const b = await orchestratePayout({ ...common, availableCents: 0 });
  const c = {
    liveAvailableCents: availableCents,
    payoutCents,
    shortfallCents: Math.max(0, payoutCents - availableCents),
  };
  const d = await orchestratePayout({
    ...common,
    availableCents: 0,
    existingRows: [{
      environment: 'sandbox',
      leg_role: 'wallet_funding',
      payout_operation_id: operationId,
      status: 'submitted',
      amount_cents: payoutCents,
      origin: 'checksops',
    }],
  });
  const e = await orchestratePayout({
    ...common,
    availableCents: sufficient,
    existingRows: [{
      environment: 'sandbox',
      leg_role: 'wallet_funding',
      payout_operation_id: operationId,
      status: 'completed',
      amount_cents: payoutCents,
      origin: 'checksops',
    }],
  });
  const f = await orchestratePayout({
    ...common,
    availableCents: 0,
    existingRows: [{
      environment: 'sandbox',
      leg_role: 'wallet_funding',
      payout_operation_id: operationId,
      status: 'failed',
      amount_cents: payoutCents,
      origin: 'checksops',
    }],
  });
  const summarize = (plan) => ({
    decision: plan.decision,
    shortfall_cents: plan.shortfall_cents,
    available_cents: plan.available_cents,
    funding_state: plan.funding_state,
    payout_state: plan.payout_state,
    blocked_reasons: plan.blocked_reasons,
    live_provider_posted: plan.live_provider_posted,
    persist_money_intents: plan.persist_money_intents,
    transfer_post_enabled: plan.transfer_post_enabled,
    created_payment_transfer: plan.created_payment_transfer,
    environment: plan.environment,
  });
  return {
    liveWallet: {
      status: wallet.status,
      availableCents,
      walletStatus: wallet.json?.status || null,
    },
    A: summarize(a),
    B: summarize(b),
    C: c,
    D: summarize(d),
    E: summarize(e),
    F: summarize(f),
    ok: a.decision === 'PAYOUT_READY'
      && b.decision === 'FUND_FIRST'
      && d.blocked_reasons.includes('funding_pending')
      && e.payout_state === 'payout_ready'
      && f.blocked_reasons.includes('funding_failed')
      && [a, b, d, e, f].every((plan) => plan.live_provider_posted === false && plan.persist_money_intents === false && plan.transfer_post_enabled === false),
  };
};

const crossEnvLookups = async (creds, sandboxAccountId) => {
  const sandboxOnFreedom = await sandboxGet(creds, `/accounts/${FREEDOM_MOOV}`, [`/accounts/${FREEDOM_MOOV}/profile.read`]);
  const sandboxOnPlatform = await sandboxGet(creds, `/accounts/${PRODUCTION_PLATFORM}`, [`/accounts/${PRODUCTION_PLATFORM}/profile.read`]);
  const sandboxOnMichael = await sandboxGet(creds, `/accounts/${MICHAEL}`, [`/accounts/${MICHAEL}/profile.read`]);
  let productionOnSandbox = { ok: false, status: null };
  if (present(creds.productionPublicKey) && present(creds.productionSecretKey)) {
    const oauth = await moovOauth({
      publicKey: creds.productionPublicKey,
      secretKey: creds.productionSecretKey,
      origin: LIVE_ORIGIN,
      scopes: [`/accounts/${sandboxAccountId}/profile.read`],
    });
    productionOnSandbox = oauth.ok ? await moovCall({
      token: oauth.token,
      origin: LIVE_ORIGIN,
      apiVersion: PROVEN_API_VERSION,
      path: `/accounts/${sandboxAccountId}`,
    }) : { ok: false, status: oauth.status };
  }
  const objectGuardSandbox = assertNoCrossEnvironmentObject({
    environment: 'sandbox',
    accountId: FREEDOM_MOOV,
  });
  const objectGuardProduction = assertNoCrossEnvironmentObject({
    environment: 'production',
    accountId: sandboxAccountId,
  });
  return {
    sandboxCannotReadFreedom: sandboxOnFreedom.ok !== true,
    sandboxCannotReadProductionPlatform: sandboxOnPlatform.ok !== true,
    sandboxCannotReadMichael: sandboxOnMichael.ok !== true,
    productionCannotReadSandbox: productionOnSandbox.ok !== true,
    sandboxFreedomStatus: sandboxOnFreedom.status,
    productionSandboxStatus: productionOnSandbox.status,
    objectGuardSandboxDenied: objectGuardSandbox.ok !== true,
    objectGuardProductionDenied: objectGuardProduction.ok !== true,
    fallbackUsed: false,
    ok: sandboxOnFreedom.ok !== true
      && sandboxOnPlatform.ok !== true
      && productionOnSandbox.ok !== true
      && objectGuardSandbox.ok !== true
      && objectGuardProduction.ok !== true,
  };
};

const main = async () => {
  const identity = await assumeRole();
  const flags = lambdaFlags();
  if (flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true' || flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') {
    throw new Error('refused_armed_post_flag');
  }
  const production = loadSecret(flags.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET);
  let webhookBundle = null;
  if (flags.MOOV_WEBHOOK_SECRET_ARN) {
    try { webhookBundle = loadSecret(flags.MOOV_WEBHOOK_SECRET_ARN); }
    catch { webhookBundle = null; }
  }
  const s = production.parsed;
  const creds = {
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    platformId: s.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID,
    origin: s.MOOV_SANDBOX_ALLOWED_ORIGIN || LIVE_ORIGIN,
    apiVersion: s.MOOV_SANDBOX_API_VERSION || PROVEN_API_VERSION,
    webhookSecret: s.MOOV_SANDBOX_WEBHOOK_SECRET
      || webhookBundle?.parsed?.MOOV_SANDBOX_WEBHOOK_SECRET
      || null,
    productionPublicKey: s.MOOV_PUBLIC_KEY,
    productionSecretKey: s.MOOV_SECRET_KEY,
    productionWebhookSecret: webhookBundle?.parsed?.MOOV_WEBHOOK_SECRET
      || s.MOOV_WEBHOOK_SECRET
      || null,
  };
  if (!present(creds.publicKey) || !present(creds.secretKey) || !present(creds.platformId)) {
    throw new Error('sandbox_credentials_missing');
  }
  if (creds.publicKey === creds.productionPublicKey || creds.secretKey === creds.productionSecretKey) {
    throw new Error('sandbox_equals_production');
  }

  const zip = packOneshot();
  const secretsList = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secretsList.SecretList || []).find((row) => /checksops_admin/i.test(row.Name || row.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  ensureOneshot(zip, adminSecret.ARN, flags.vpc);

  const rdsInspect = invokeOneshot({ step: 'inspect' });
  const rdsVerify = invokeOneshot({ step: 'verify', tenantId: PIPELINE });
  const moovInspect = await inspectMoov(creds);
  const productionWebhooksBefore = await inspectProductionWebhooks(production);

  const created = [];
  const reused = [];
  const duplicates = [];

  const account = await ensureAccount(creds, moovInspect, created, reused);
  if (account.ok === false) {
    const stopped = { ok: false, stopped: account.error, account, moovInspect, rdsVerify };
    fs.writeFileSync('/opt/cursor/artifacts/m79c_stopped.json', JSON.stringify(stopped, null, 2));
    console.log(JSON.stringify(stopped, null, 2));
    process.exit(2);
  }
  const capabilities = await ensureCapabilities(creds, account.accountId, created);
  const onboarding = await completeBusinessOnboarding(creds, account.accountId, created);
  const wallet = await ensureWallet(creds, account.accountId, moovInspect, created, reused);
  if (wallet.ok === false) {
    const stopped = { ok: false, stopped: wallet.error, account, onboarding, capabilities, wallet };
    fs.writeFileSync('/opt/cursor/artifacts/m79c_stopped.json', JSON.stringify(stopped, null, 2));
    console.log(JSON.stringify(stopped, null, 2));
    process.exit(2);
  }
  const bank = await ensureBank(creds, account.accountId, moovInspect, created, reused);
  if (bank.ok === false) {
    const stopped = { ok: false, stopped: bank.error, account, wallet, bank };
    fs.writeFileSync('/opt/cursor/artifacts/m79c_stopped.json', JSON.stringify(stopped, null, 2));
    console.log(JSON.stringify(stopped, null, 2));
    process.exit(2);
  }
  const recipient = await ensureRecipient(creds, moovInspect, created, reused);
  if (recipient.ok === false) {
    const stopped = { ok: false, stopped: recipient.error, account, wallet, bank, recipient };
    fs.writeFileSync('/opt/cursor/artifacts/m79c_stopped.json', JSON.stringify(stopped, null, 2));
    console.log(JSON.stringify(stopped, null, 2));
    process.exit(2);
  }

  const ids = [account.accountId, wallet.walletId, bank.bankId, bank.paymentMethodId, recipient.accountId, recipient.bankId, recipient.paymentMethodId];
  if (ids.some((id) => isProdId(id))) throw new Error('production_id_in_sandbox_set');

  const linked = invokeOneshot({
    step: 'link_objects',
    tenantId: PIPELINE,
    displayName: 'ChecksOps Pipeline Test',
    accountId: account.accountId,
    walletId: wallet.walletId,
    availableCents: wallet.availableCents,
    pendingCents: wallet.pendingCents,
    bankId: bank.bankId,
    bankPmId: bank.paymentMethodId,
    bankName: bank.bankName,
    lastFour: bank.lastFour,
    bankVerified: bank.verified === true,
    recipientAccountId: recipient.accountId,
    recipientBankId: recipient.bankId,
    recipientPmId: recipient.paymentMethodId,
    recipientName: 'Pipeline Test Payee',
    recipientBankName: recipient.bankName,
    recipientLastFour: recipient.lastFour,
  });
  const proof = invokeOneshot({ step: 'object_proof', tenantId: PIPELINE });
  const cross = await crossEnvLookups(creds, account.accountId);

  const webhookCut = await cutWebhook(creds, moovInspect.sandboxWebhook, productionWebhooksBefore);
  const stoppedForWebhook = Boolean(webhookCut.stopped);

  const unknownId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const sandboxEvent = await signedWebhook(creds.webhookSecret, 'sandbox', account.accountId);
  const sandboxDup = await signedWebhook(creds.webhookSecret, 'sandbox', account.accountId, sandboxEvent.eventId);
  const productionEvent = await signedWebhook(creds.productionWebhookSecret, 'production', FREEDOM_MOOV);
  const sandboxOnFreedom = await signedWebhook(creds.webhookSecret, 'sandbox', FREEDOM_MOOV);
  const productionOnSandbox = await signedWebhook(creds.productionWebhookSecret, 'production', account.accountId);
  const unknownSandbox = await signedWebhook(creds.webhookSecret, 'sandbox', unknownId);
  const receipts = invokeOneshot({
    step: 'webhook_receipts',
    eventIds: [sandboxEvent.eventId, sandboxDup.eventId, productionEvent.eventId, unknownSandbox.eventId],
  });

  let ping = null;
  if (!stoppedForWebhook && moovInspect.sandboxWebhook?.id) {
    ping = await sandboxWrite(
      creds,
      `/webhooks/${moovInspect.sandboxWebhook.id}/ping`,
      'POST',
      undefined,
      ['/webhooks.write'],
    );
  }

  const dark = await darkM77({ creds, accountId: account.accountId, walletId: wallet.walletId, bank, recipient });
  const health = {
    login: await probe('/auth/login', 'POST', { email: 'nobody@example.com', password: 'invalid' }),
    webhookUnsigned: await probe('/webhooks/moov', 'POST', { type: 'account.updated' }),
    providersStatus: await probe('/providers/status', 'GET'),
  };
  const postFlagsAfter = lambdaFlags();

  const returnCard = {
    SANDBOX_ACCOUNT: account.displayName || 'ChecksOps Pipeline Test',
    SANDBOX_ACCOUNT_ID: account.accountId,
    SANDBOX_WALLET: wallet.status || 'active',
    SANDBOX_WALLET_ID: wallet.walletId,
    SANDBOX_WALLET_BALANCE: wallet.availableCents,
    SANDBOX_BANK: bank.bankName,
    SANDBOX_BANK_VERIFIED: bank.verified === true,
    SANDBOX_BANK_FUNDING_CAPABILITY: capabilities.collectFundsAch === true
      ? true
      : `pending:${(capabilities.listed || []).filter((row) => String(row.capability || '').includes('collect-funds')).map((row) => `${row.capability}=${row.status}`).join(',') || 'missing'}`,
    SAFE_TO_ARM_ONLY_AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: dark.ok && bank.verified && recipient.ready && webhookCut.ok && cross.ok && capabilities.collectFundsAch === true && sandboxEvent.status === 200 && sandboxEvent.mappedTenantId === PIPELINE ? 'REVIEW' : 'NO',
    SANDBOX_RECIPIENT: 'Pipeline Test Payee',
    SANDBOX_RECIPIENT_ACCOUNT: recipient.accountId,
    SANDBOX_RECIPIENT_METHOD: recipient.paymentMethodId || recipient.bankId,
    SANDBOX_RECIPIENT_READY: recipient.ready === true,
    OBJECTS_CREATED: created,
    OBJECTS_REUSED: reused,
    DUPLICATES: duplicates,
    CROSS_ENVIRONMENT_BLOCKED: cross.ok === true && proof.ok === true,
    SANDBOX_WEBHOOK_BEFORE: webhookCut.before,
    SANDBOX_WEBHOOK_AFTER: webhookCut.after,
    WEBHOOK_URL_UPDATED: webhookCut.updated === true || webhookCut.alreadyPrep === true,
    WEBHOOK_SECRET_ROTATED: webhookCut.secretRotated === true,
    PRODUCTION_WEBHOOK_CHANGED: webhookCut.productionWebhookChanged === true,
    SANDBOX_WEBHOOK_LIVE_PROOF: sandboxEvent.status === 200
      && sandboxEvent.signedEnvironment === 'sandbox'
      && sandboxEvent.accepted === true
      && sandboxEvent.mappedTenantId === PIPELINE,
    SANDBOX_RECEIPT_PERSISTED: Boolean(sandboxEvent.receiptId)
      || Boolean((receipts.rows || []).some((row) => row.external_event_id === sandboxEvent.eventId)),
    PRODUCTION_ISOLATION: productionEvent.status === 200
      && productionEvent.signedEnvironment === 'production'
      && productionEvent.mappedTenantId === FREEDOM
      && sandboxEvent.mappedTenantId === PIPELINE
      && sandboxOnFreedom.mappedTenantId !== FREEDOM
      && productionOnSandbox.mappedTenantId !== PIPELINE
      && unknownSandbox.status === 200
      && unknownSandbox.lookup === 'unmapped'
      && sandboxDup.duplicate === true
      && sandboxEvent.createdPaymentTransfer !== true
      && productionEvent.createdPaymentTransfer !== true
      && (receipts.recentProductionAccountWebhookMutations === 0 || receipts.recentProductionAccountWebhookMutations === null)
      && (receipts.recentPaymentTransfersCreated === 0),
    TENANT_MANAGEMENT_BADGE: rdsVerify?.tenant?.moov_environment === 'sandbox' ? 'SANDBOX' : rdsVerify?.tenant?.moov_environment,
    WALLETOPS_BADGE: rdsVerify?.tenant?.moov_environment === 'sandbox' ? 'SANDBOX' : rdsVerify?.tenant?.moov_environment,
    DARK_M77_RESULT: dark.ok ? 'PASS' : 'FAIL',
    SANDBOX_PROVIDER_POSTS: false,
    PRODUCTION_PROVIDER_POSTS: false,
    SANDBOX_MONEY_MOVED: false,
    PRODUCTION_MONEY_MOVED: false,
    SANDBOX_POST_FLAG: postFlagsAfter.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || 'false',
    PRODUCTION_POST_FLAG: postFlagsAfter.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false',
    SAFE_TO_ARM_ONLY_AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: dark.ok && bank.verified && recipient.ready && webhookCut.ok && cross.ok && !stoppedForWebhook ? 'REVIEW' : 'NO',
    SAFE_TO_RUN_FIRST_SANDBOX_BANK_TO_WALLET: 'NO',
    GO_NO_GO: stoppedForWebhook || !webhookCut.ok || !linked.ok || !dark.ok ? 'NO-GO — STOP FOR REVIEW' : 'NO-GO — STOP FOR REVIEW',
  };

  const report = {
    at: new Date().toISOString(),
    identity: { arn: identity.Arn, account: identity.Account },
    flags: postFlagsAfter.flags,
    rdsInspectDesignated: rdsInspect.designated || null,
    rdsVerify: {
      ok: rdsVerify.ok,
      tenant: rdsVerify.tenant,
      freedomEnvironment: rdsVerify.freedomEnvironment,
      productionIgnored: rdsVerify.productionIgnored,
    },
    moovInspectBefore: {
      listedStatus: moovInspect.listedStatus,
      pipelineAccounts: moovInspect.pipelineAccounts.map((row) => ({
        accountFp: row.accountFp,
        displayName: row.displayName,
        wallets: row.wallets.length,
        banks: row.banks.length,
      })),
      sandboxWebhook: moovInspect.sandboxWebhook,
    },
    account: { ...account, accountFp: fingerprint(account.accountId) },
    onboarding,
    wallet: { ...wallet, walletFp: fingerprint(wallet.walletId) },
    bank: { ...bank, bankFp: fingerprint(bank.bankId), paymentMethodFp: fingerprint(bank.paymentMethodId) },
    recipient: {
      ...recipient,
      accountFp: fingerprint(recipient.accountId),
      bankFp: fingerprint(recipient.bankId),
      paymentMethodFp: fingerprint(recipient.paymentMethodId),
    },
    capabilities,
    linked: {
      ok: linked.ok,
      error: linked.error,
      productionIdHits: linked.objects?.productionIdHits || [],
      unusedProductionReused: linked.unusedProductionReused,
    },
    proof,
    cross,
    webhookCut,
    ping: ping ? { status: ping.status, ok: ping.ok, error: ping.error } : null,
    webhooks: {
      sandboxEvent,
      sandboxDup,
      productionEvent,
      sandboxOnFreedom,
      productionOnSandbox,
      unknownSandbox,
      receipts,
    },
    dark,
    health,
    created,
    reused,
    duplicates,
    returnCard,
    STOP_FOR_REVIEW: true,
    stopped: webhookCut.stopped || null,
  };
  fs.writeFileSync('/opt/cursor/artifacts/m79c_run.json', JSON.stringify(report, null, 2));
  fs.writeFileSync('/opt/cursor/artifacts/m79c_return_card.md', `${Object.entries(returnCard).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n')}\n`);
  console.log(JSON.stringify({
    ok: linked.ok === true && proof.ok === true && webhookCut.ok === true && dark.ok === true && cross.ok === true && !webhookCut.stopped,
    returnCard,
    created,
    reused,
    webhookCut: {
      updated: webhookCut.updated,
      alreadyPrep: webhookCut.alreadyPrep,
      secretRotated: webhookCut.secretRotated,
      productionWebhookChanged: webhookCut.productionWebhookChanged,
      stopped: webhookCut.stopped || null,
    },
    STOP_FOR_REVIEW: true,
  }, null, 2));
  if (webhookCut.stopped) process.exit(2);
};

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 500) }, null, 2));
  process.exit(1);
});
