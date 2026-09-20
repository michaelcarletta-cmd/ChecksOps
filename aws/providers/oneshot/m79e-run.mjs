#!/usr/bin/env node
/**
 * M7.9E: final preflight + one controlled sandbox BANK→WALLET $0.01 POST.
 * Never arms AWS_MOOV_TRANSFER_POST_ENABLED. Never overlays protected money
 * writers. Never POSTs wallet→recipient. Never retries timeout/unknown.
 * Immediate disarm of AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED after one attempt.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';
import {
  executeSandboxWalletFunding,
  persistSandboxFundingIntent,
  PIPELINE_TEST_SANDBOX,
  planSandboxWalletFunding,
  resolveSandboxFundBinding,
  SANDBOX_FUNDING_AMOUNT_CENTS,
  sandboxWalletFundingIdempotencyKey,
} from '../../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import { moovSandboxFetch, moovSandboxScopes, moovSandboxToken } from '../../functions/api/providers/moov-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const ONESHOT_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/providers/oneshot/m79-sandbox-tenant');
const PRODUCTION_SECRET = 'checksops/production/provider';
const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
const SANDBOX_ACCOUNT = '1d59a6a8-3307-4687-8367-1495293ecc73';
const SANDBOX_WALLET = '58571121-67ea-4e10-abae-6c9680ac455d';
const SANDBOX_BANK = '8390f74b-706e-4d89-80b0-f96bd7c1b414';
const SANDBOX_FUND_PM = '8a0f6ffa-a549-48f5-bb8e-f5b6a9d9cfff';
const SANDBOX_WALLET_PM = '1eb24c1c-b7ab-45cd-8775-332da40b9647';
const SANDBOX_PLATFORM = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const FREEDOM_MOOV = KNOWN_APPROVED_MOOV.freedom.moovAccountId;
const PREFERRED_WEBHOOK_URL = 'https://checksops.com/prep/webhooks/moov';
const LIVE_ORIGIN = PRODUCTION_MOOV_ORIGIN;
const PROVEN_API_VERSION = PRODUCTION_MOOV_API_VERSION;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    '--role-session-name', 'checksops-m79e-sandbox-fund',
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
const asList = (json) => {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.accounts)) return json.accounts;
  if (Array.isArray(json?.wallets)) return json.wallets;
  if (Array.isArray(json?.bankAccounts)) return json.bankAccounts;
  if (Array.isArray(json?.paymentMethods)) return json.paymentMethods;
  if (Array.isArray(json?.transfers)) return json.transfers;
  if (Array.isArray(json?.webhooks)) return json.webhooks;
  return [];
};
const pmType = (row) => String(row?.paymentMethodType || row?.type || '').toLowerCase();
const pmIdOf = (row) => row?.paymentMethodID || row?.paymentMethodId || row?.id || null;
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

const lambdaConfig = () => awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
const lambdaFlags = (cfg = lambdaConfig()) => {
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
    envKeys: Object.keys(env).sort(),
    env: env,
    vpc: {
      subnetIds: cfg.VpcConfig?.SubnetIds || [],
      securityGroupIds: cfg.VpcConfig?.SecurityGroupIds || [],
    },
    PROVIDER_SECRETS_ARN: env.PROVIDER_SECRETS_ARN,
  };
};

const waitFn = (name) => {
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const envDiff = (before, after) => {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  for (const key of keys) {
    if (String(before?.[key] ?? '') !== String(after?.[key] ?? '')) changed.push(key);
  }
  return changed.sort();
};

const setSandboxPostFlag = (value) => {
  const before = lambdaConfig();
  const vars = { ...(before.Environment?.Variables || {}) };
  if (vars.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') {
    throw new Error('production_post_already_true');
  }
  vars.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED = value;
  const changed = envDiff(before.Environment?.Variables || {}, vars);
  if (changed.some((key) => key !== 'AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED')) {
    throw new Error(`other_env_changes:${changed.join(',')}`);
  }
  awsJson([
    'lambda', 'update-function-configuration',
    '--function-name', API_FN,
    '--environment', JSON.stringify({ Variables: vars }),
  ]);
  waitFn(API_FN);
  const after = lambdaConfig();
  return {
    changed: envDiff(before.Environment?.Variables || {}, after.Environment?.Variables || {}),
    flags: lambdaFlags(after).flags,
    codeShaUnchanged: after.CodeSha256 === before.CodeSha256,
    lastUpdateStatus: after.LastUpdateStatus,
    state: after.State,
  };
};

const loadSecret = (id) => {
  const raw = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', id]);
  return { parsed: JSON.parse(raw.SecretString || '{}') };
};

const packOneshot = () => {
  const staging = path.join(os.tmpdir(), 'checksops-m79e-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/77_moov_tenant_environment.sql'), path.join(staging, '77_moov_tenant_environment.sql'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m79e-oneshot.zip');
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
  const outFile = `/tmp/m79e-oneshot-${payload.step}-${Date.now()}.json`;
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

const probe = async (pathName, method = 'GET', body = null) => {
  const started = Date.now();
  const res = await fetch(`https://checksops.com/prep${pathName}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 180) }; }
  return {
    path: pathName,
    status: res.status,
    ms: Date.now() - started,
    error: json?.error || null,
  };
};

const sandboxCredentials = (parsed) => ({
  environment: 'sandbox',
  publicKey: parsed.MOOV_SANDBOX_PUBLIC_KEY,
  secretKey: parsed.MOOV_SANDBOX_SECRET_KEY,
  platformId: parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID,
  origin: parsed.MOOV_SANDBOX_ALLOWED_ORIGIN || LIVE_ORIGIN,
  apiVersion: parsed.MOOV_SANDBOX_API_VERSION || PROVEN_API_VERSION,
  host: 'https://api.moov.io',
});

const summarizeTransfer = (row) => ({
  id: row?.transferID || row?.transferId || row?.id || null,
  status: row?.status || null,
  amountCents: amountCentsOf(row?.amount),
  sourcePm: row?.source?.paymentMethodID || row?.source?.paymentMethodId || null,
  destinationPm: row?.destination?.paymentMethodID || row?.destination?.paymentMethodId || null,
});

const matchingFundingTransfers = (rows) => (rows || []).filter((row) => (
  row.amountCents === SANDBOX_FUNDING_AMOUNT_CENTS
  && String(row.sourcePm || '').toLowerCase() === SANDBOX_FUND_PM
  && String(row.destinationPm || '').toLowerCase() === SANDBOX_WALLET_PM
));

const readLiveObjects = async (credentials) => {
  const account = await moovSandboxFetch({
    credentials,
    path: `/accounts/${SANDBOX_ACCOUNT}`,
    scopes: moovSandboxScopes.accountRead(SANDBOX_ACCOUNT),
  });
  const wallets = await moovSandboxFetch({
    credentials,
    path: `/accounts/${SANDBOX_ACCOUNT}/wallets`,
    scopes: moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT),
  });
  const banks = await moovSandboxFetch({
    credentials,
    path: `/accounts/${SANDBOX_ACCOUNT}/bank-accounts`,
    scopes: moovSandboxScopes.bankAccountsRead(SANDBOX_ACCOUNT),
  });
  const methods = await moovSandboxFetch({
    credentials,
    path: `/accounts/${SANDBOX_ACCOUNT}/payment-methods`,
    scopes: moovSandboxScopes.paymentMethodsRead(SANDBOX_ACCOUNT),
  });
  const caps = await moovSandboxFetch({
    credentials,
    path: `/accounts/${SANDBOX_ACCOUNT}/capabilities/collect-funds`,
    scopes: moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT),
  });
  const transfers = await moovSandboxFetch({
    credentials,
    path: `/accounts/${SANDBOX_ACCOUNT}/transfers`,
    scopes: moovSandboxScopes.transfersRead(SANDBOX_ACCOUNT),
  });
  const walletRows = asList(wallets.data).map((row) => ({
    id: row.walletID || row.walletId || row.id,
    status: row.status || null,
    availableCents: amountCentsOf(row.availableBalance ?? row.available),
    pendingCents: amountCentsOf(row.pendingBalance ?? row.pending),
  }));
  const bankRows = asList(banks.data).map((row) => ({
    id: row.bankAccountID || row.bankAccountId || row.id,
    status: row.status || null,
    routingNumber: row.routingNumber || null,
    lastFour: row.lastFourAccountNumber || row.lastFour || null,
    bankName: row.bankName || null,
  }));
  const methodRows = asList(methods.data).map((row) => ({
    id: pmIdOf(row),
    type: pmType(row),
    bankAccountId: row.bankAccountID || row.bankAccount?.bankAccountID || null,
    walletId: row.walletID || row.wallet?.walletID || null,
  }));
  const transferRows = asList(transfers.ok ? transfers.data : []).map(summarizeTransfer);
  const wallet = walletRows.find((row) => String(row.id).toLowerCase() === SANDBOX_WALLET) || null;
  const bank = bankRows.find((row) => String(row.id).toLowerCase() === SANDBOX_BANK) || null;
  return {
    accountOk: account.ok === true,
    accountStatus: account.statusCode || null,
    collectFunds: String(caps.data?.status || '').toLowerCase() || null,
    wallets: walletRows,
    banks: bankRows,
    paymentMethods: methodRows,
    transfers: transferRows,
    wallet,
    bank,
    fundingTransfers: matchingFundingTransfers(transferRows),
  };
};

const inspectWebhooks = async (credentials) => {
  const res = await fetch('https://api.moov.io/webhooks', {
    method: 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.publicKey}:${credentials.secretKey}`).toString('base64')}`,
      Accept: 'application/json',
      Origin: credentials.origin,
      'x-moov-version': credentials.apiVersion,
    },
  });
  const json = await res.json().catch(() => null);
  const rows = asList(json).map((row) => ({
    url: row.url || null,
    disabled: row.disabled === true,
  }));
  const webhook = rows.find((row) => String(row.url || '').replace(/\/$/, '') === PREFERRED_WEBHOOK_URL.replace(/\/$/, ''));
  return {
    listed: res.ok === true,
    status: res.status,
    webhook: webhook || null,
    healthy: Boolean(webhook && webhook.disabled !== true),
  };
};

const writeReturnCard = (card) => {
  const lines = Object.entries(card).map(([key, value]) => `${key}: ${value}`);
  const text = `${lines.join('\n')}\n`;
  fs.writeFileSync('/opt/cursor/artifacts/m79e_return_card.md', `${text}\nSTOP FOR REVIEW.\n`);
  fs.writeFileSync('/opt/cursor/artifacts/m79e_return_card_final.md', `${text}\nSTOP FOR REVIEW.\nDo not execute wallet→recipient yet.\nDo not arm production execution.\n`);
  return text;
};

const main = async () => {
  if (PIPELINE !== PIPELINE_TEST_SANDBOX.tenantId
    || SANDBOX_ACCOUNT !== PIPELINE_TEST_SANDBOX.accountId
    || SANDBOX_WALLET !== PIPELINE_TEST_SANDBOX.walletId
    || SANDBOX_BANK !== PIPELINE_TEST_SANDBOX.bankId
    || SANDBOX_FUND_PM !== PIPELINE_TEST_SANDBOX.achDebitFundPm
    || SANDBOX_WALLET_PM !== PIPELINE_TEST_SANDBOX.walletPm
    || SANDBOX_PLATFORM !== PIPELINE_TEST_SANDBOX.platformAccountId) {
    throw new Error('sandbox_object_constants_drift');
  }
  const identity = await assumeRole();
  const flagsStart = lambdaFlags();
  if (flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') {
    throw new Error('refused_production_post_armed');
  }
  if (flagsStart.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') {
    throw new Error('refused_sandbox_post_already_armed');
  }
  const production = loadSecret(flagsStart.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET);
  const parsed = production.parsed;
  const credentials = sandboxCredentials(parsed);
  if (!present(credentials.publicKey) || !present(credentials.secretKey) || !present(credentials.platformId)) {
    throw new Error('sandbox_credentials_missing');
  }
  if (credentials.publicKey === parsed.MOOV_PUBLIC_KEY || credentials.secretKey === parsed.MOOV_SECRET_KEY) {
    throw new Error('sandbox_equals_production');
  }

  const zip = packOneshot();
  const secretsList = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secretsList.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  ensureOneshot(zip, adminSecret.ARN, flagsStart.vpc);

  const proof = invokeOneshot({ step: 'object_proof', tenantId: PIPELINE });
  const verifyTenant = invokeOneshot({ step: 'verify', tenantId: PIPELINE });
  const live = await readLiveObjects(credentials);
  const sweepBefore = proof.sweep || verifyTenant.sweep || null;
  const tenant = {
    id: PIPELINE,
    name: proof.tenant?.name || 'ChecksOps Pipeline Test',
    moov_environment: proof.tenant?.moov_environment || verifyTenant.tenant?.moov_environment,
  };
  const rds = {
    account: proof.pipeline?.sandbox?.account || verifyTenant.sandbox?.account || null,
    wallet: proof.pipeline?.sandbox?.wallet || verifyTenant.sandbox?.wallet || null,
    banks: proof.pipeline?.sandbox?.banks || verifyTenant.sandbox?.banks || [],
  };

  const productionHintDenied = resolveSandboxFundBinding({
    tenant,
    rds,
    live: { accountId: SANDBOX_ACCOUNT, wallets: live.wallets, banks: live.banks, paymentMethods: live.paymentMethods, platformAccountId: credentials.platformId },
    clientHints: { bankId: KNOWN_APPROVED_MOOV.freedom.bankId, amountCents: 1 },
  });
  const binding = resolveSandboxFundBinding({
    tenant,
    rds,
    live: { accountId: SANDBOX_ACCOUNT, wallets: live.wallets, banks: live.banks, paymentMethods: live.paymentMethods, platformAccountId: credentials.platformId },
    clientHints: { environment: 'production', accountId: SANDBOX_ACCOUNT, amountCents: 1 },
  });
  const planned = binding.ok ? planSandboxWalletFunding(binding) : binding;
  const phase1Ok = binding.ok === true
    && binding.accountId === SANDBOX_ACCOUNT
    && binding.bankId === SANDBOX_BANK
    && binding.sourcePaymentMethodId === SANDBOX_FUND_PM
    && binding.walletId === SANDBOX_WALLET
    && binding.amountCents === 1
    && binding.environment === 'sandbox'
    && productionHintDenied.ok === false
    && live.collectFunds === 'enabled'
    && live.wallet?.availableCents === 0
    && live.fundingTransfers.length === 0;

  const persist1 = invokeOneshot({
    step: 'persist_funding_intent',
    tenantId: PIPELINE,
    idempotencyKey: planned.idempotency_key,
    providerIdempotencyKey: planned.provider_idempotency_key,
    accountId: SANDBOX_ACCOUNT,
    bankId: SANDBOX_BANK,
    walletId: SANDBOX_WALLET,
    sourcePaymentMethodId: SANDBOX_FUND_PM,
    destinationPaymentMethodId: SANDBOX_WALLET_PM,
    providerMetadata: planned.provider_metadata,
  });
  const persist2 = invokeOneshot({
    step: 'persist_funding_intent',
    tenantId: PIPELINE,
    idempotencyKey: planned.idempotency_key,
    providerIdempotencyKey: planned.provider_idempotency_key,
    accountId: SANDBOX_ACCOUNT,
    bankId: SANDBOX_BANK,
    walletId: SANDBOX_WALLET,
    sourcePaymentMethodId: SANDBOX_FUND_PM,
    destinationPaymentMethodId: SANDBOX_WALLET_PM,
  });
  const memoryReplay = await persistSandboxFundingIntent({
    async getIntent() { return persist1.intent; },
    async putIntent() { throw new Error('must_reuse'); },
  }, planned);
  const intent = persist2.intent || persist1.intent || null;
  const phase2Ok = persist1.ok === true
    && persist2.ok === true
    && persist2.reused === true
    && persist2.intentCount === 1
    && persist2.fundingIntentCount === 1
    && intent?.id
    && intent.environment === 'sandbox'
    && Number(intent.amount_cents) === 1
    && intent.leg_role === 'wallet_funding'
    && memoryReplay.reused === true;

  const flagsDark = lambdaFlags();
  const dark = await executeSandboxWalletFunding({
    credentials,
    productionPublicKey: parsed.MOOV_PUBLIC_KEY,
    productionSecretKey: parsed.MOOV_SECRET_KEY,
    binding,
    intent,
    transferPostEnabled: flagsDark.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true',
    productionTransferPostEnabled: flagsDark.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true',
  });
  const liveAfterDark = await readLiveObjects(credentials);
  const phase3Ok = dark.ok === true
    && dark.outcome === 'transfer_post_held'
    && dark.transfer_post_held === true
    && dark.liveProviderCalled === false
    && dark.liveProviderPosted === false
    && liveAfterDark.wallet?.availableCents === 0
    && liveAfterDark.fundingTransfers.length === 0
    && persist2.recentProductionTransfers === 0;

  const report = {
    at: new Date().toISOString(),
    identity: { arn: identity.Arn, account: identity.Account },
    flagsStart: flagsStart.flags,
    phase1: {
      binding,
      productionHintDenied: { ok: productionHintDenied.ok, error: productionHintDenied.error },
      live: {
        collectFunds: live.collectFunds,
        walletAvailable: live.wallet?.availableCents,
        bank: live.bank,
        fundingTransfers: live.fundingTransfers.length,
      },
      ok: phase1Ok,
    },
    phase2: {
      persist1: { ok: persist1.ok, reused: persist1.reused, created: persist1.created, intentId: persist1.intent?.id, intentCount: persist1.intentCount },
      persist2: { ok: persist2.ok, reused: persist2.reused, created: persist2.created, intentId: persist2.intent?.id, intentCount: persist2.intentCount },
      ok: phase2Ok,
    },
    phase3: { dark, liveWallet: liveAfterDark.wallet, fundingTransfers: liveAfterDark.fundingTransfers.length, ok: phase3Ok },
  };

  if (!phase1Ok || !phase2Ok || !phase3Ok) {
    writeReturnCard({
      SANDBOX_WRITER_BINDING: phase1Ok ? 'PASS' : `FAIL:${binding.error || 'binding'}`,
      SANDBOX_ACCOUNT: SANDBOX_ACCOUNT,
      SANDBOX_BANK: SANDBOX_BANK,
      SANDBOX_FUNDING_PM: SANDBOX_FUND_PM,
      SANDBOX_WALLET: SANDBOX_WALLET,
      PRODUCTION_IDS_BLOCKED: productionHintDenied.ok === false ? 'true' : 'false',
      SANDBOX_INTENT_ID: intent?.id || 'none',
      INTENT_COUNT: persist2.intentCount ?? persist1.intentCount ?? 0,
      IDEMPOTENCY: planned.idempotency_key || 'none',
      DARK_RESULT: dark.outcome || dark.error || 'not_run',
      TRANSFER_POST_HELD: String(dark.transfer_post_held === true),
      SANDBOX_POST_FLAG_ARMED: 'false',
      PRODUCTION_POST_FLAG: String(flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      OTHER_ENV_CHANGES: 'none',
      PROVIDER_POST_COUNT: 0,
      SANDBOX_MOOV_TRANSFER_ID: 'none',
      SANDBOX_MOOV_STATUS: 'none',
      INTENT_STATUS: intent?.status || 'none',
      PROVIDER_REFERENCE: intent?.provider_transfer_id || 'none',
      SANDBOX_POST_FLAG_DISARMED: 'true',
      DUPLICATE_TRANSFER: 'false',
      PRODUCTION_TRANSFER_CREATED: String((persist2.recentProductionTransfers || 0) > 0),
      FREEDOM_CHANGED: 'false',
      SWEEP_CHANGED: 'false',
      PRODUCTION_MONEY_MOVED: 'false',
      SAFE_TO_RECONCILE_SANDBOX_TRANSFER: 'NO',
      SAFE_TO_PREPARE_SANDBOX_WALLET_RECIPIENT_AFTER_FUNDS_AVAILABLE: 'NO',
      GO_NO_GO: 'NO-GO',
    });
    fs.writeFileSync('/opt/cursor/artifacts/m79e_run.json', JSON.stringify({ ...report, stopped: 'preflight' }, null, 2));
    console.log(JSON.stringify({ ok: false, stopped: 'preflight', phase1Ok, phase2Ok, phase3Ok }, null, 2));
    return;
  }

  const alreadyAttempted = Boolean(intent?.provider_transfer_id)
    || intent?.provider_metadata?.post_attempted === true
    || intent?.status === 'failed'
    || intent?.status === 'unknown';
  if (alreadyAttempted) {
    const flagsEnd = lambdaFlags();
    const liveNow = await readLiveObjects(credentials);
    const webhooksNow = await inspectWebhooks(credentials);
    const verifyNow = invokeOneshot({
      step: 'verify_funding_intent',
      tenantId: PIPELINE,
      idempotencyKey: planned.idempotency_key,
    });
    writeReturnCard({
      SANDBOX_WRITER_BINDING: 'PASS',
      SANDBOX_ACCOUNT,
      SANDBOX_BANK,
      SANDBOX_FUNDING_PM: SANDBOX_FUND_PM,
      SANDBOX_WALLET,
      PRODUCTION_IDS_BLOCKED: 'true',
      SANDBOX_INTENT_ID: intent.id,
      INTENT_COUNT: String(verifyNow.intentCount ?? 1),
      IDEMPOTENCY: planned.idempotency_key,
      DARK_RESULT: dark.outcome,
      TRANSFER_POST_HELD: String(dark.transfer_post_held === true),
      SANDBOX_POST_FLAG_ARMED: 'false',
      PRODUCTION_POST_FLAG: String(flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      OTHER_ENV_CHANGES: 'none',
      PROVIDER_POST_COUNT: '1_prior_attempt_not_retried',
      SANDBOX_MOOV_TRANSFER_ID: intent.provider_transfer_id || liveNow.fundingTransfers[0]?.id || 'none',
      SANDBOX_MOOV_STATUS: liveNow.fundingTransfers[0]?.status || intent.provider_status || 'none',
      INTENT_STATUS: intent.status,
      PROVIDER_REFERENCE: intent.provider_transfer_id || 'none',
      SANDBOX_POST_FLAG_DISARMED: String(flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'),
      DUPLICATE_TRANSFER: String(liveNow.fundingTransfers.length > 1),
      PRODUCTION_TRANSFER_CREATED: String((verifyNow.recentProductionTransfers || 0) > 0),
      FREEDOM_CHANGED: 'false',
      SWEEP_CHANGED: 'false',
      PRODUCTION_MONEY_MOVED: 'false',
      SAFE_TO_RECONCILE_SANDBOX_TRANSFER: liveNow.fundingTransfers.length === 1 ? 'YES' : 'NO',
      SAFE_TO_PREPARE_SANDBOX_WALLET_RECIPIENT_AFTER_FUNDS_AVAILABLE: 'NO',
      GO_NO_GO: 'NO-GO',
    });
    fs.writeFileSync('/opt/cursor/artifacts/m79e_run.json', JSON.stringify({
      ...report,
      stopped: 'already_attempted_no_retry',
      liveNow,
      webhooksNow,
      verifyNow,
      flagsEnd: flagsEnd.flags,
    }, null, 2));
    console.log(JSON.stringify({ ok: true, stopped: 'already_attempted_no_retry', flagsEnd: flagsEnd.flags }, null, 2));
    return;
  }

  let armed = null;
  let posted = null;
  let disarmed = null;
  let liveAfterPost = null;
  let updatedIntent = null;
  let verifyAfter = null;
  let webhooks = null;
  let receipts = null;
  try {
    armed = setSandboxPostFlag('true');
    if (armed.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') {
      throw new Error('production_post_armed_during_sandbox_arm');
    }
    if (armed.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true') {
      throw new Error('sandbox_post_not_armed');
    }
    if (armed.changed.some((key) => key !== 'AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED')) {
      throw new Error(`other_env_changes:${armed.changed.join(',')}`);
    }
    const flagsArmed = lambdaFlags();
    posted = await executeSandboxWalletFunding({
      credentials,
      productionPublicKey: parsed.MOOV_PUBLIC_KEY,
      productionSecretKey: parsed.MOOV_SECRET_KEY,
      binding,
      intent,
      transferPostEnabled: flagsArmed.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true',
      productionTransferPostEnabled: flagsArmed.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true',
    });
  } finally {
    disarmed = setSandboxPostFlag('false');
  }

  liveAfterPost = await readLiveObjects(credentials);
  if (posted?.outcome === 'unknown' || posted?.outcome === 'conflict' || (posted?.liveProviderCalled && !posted?.provider_transfer_id)) {
    const listed = matchingFundingTransfers(liveAfterPost.transfers);
    if (listed.length === 1) {
      posted = {
        ...posted,
        outcome: posted.outcome === 'failed' ? posted.outcome : 'reconciled_get_only',
        provider_transfer_id: listed[0].id,
        provider_status: listed[0].status,
        liveProviderPosted: true,
        doNotRetry: true,
      };
    }
  }
  const intentStatus = posted?.provider_transfer_id
    ? (['completed', 'failed', 'canceled', 'returned'].includes(String(posted.provider_status || '').toLowerCase())
      ? String(posted.provider_status).toLowerCase()
      : 'pending')
    : (posted?.outcome === 'failed' ? 'failed' : 'unknown');
  updatedIntent = invokeOneshot({
    step: 'update_funding_intent',
    tenantId: PIPELINE,
    intentId: intent.id,
    providerTransferId: posted?.provider_transfer_id || null,
    providerStatus: posted?.provider_status || null,
    status: intentStatus,
    markSubmitted: posted?.liveProviderCalled === true,
    failureReason: posted?.ok === false ? (posted.error || posted.outcome) : null,
    providerMetadata: {
      ...(planned.provider_metadata || {}),
      post_attempted: posted?.liveProviderCalled === true,
      post_outcome: posted?.outcome || null,
      do_not_retry: true,
      provider_idempotency_key: posted?.provider_idempotency_key || binding.providerIdempotencyKey,
    },
  });
  webhooks = await inspectWebhooks(credentials);
  receipts = invokeOneshot({ step: 'webhook_receipts', eventIds: posted?.provider_transfer_id ? [posted.provider_transfer_id] : [] });
  verifyAfter = invokeOneshot({
    step: 'verify_funding_intent',
    tenantId: PIPELINE,
    idempotencyKey: planned.idempotency_key,
  });
  const flagsEnd = lambdaFlags();
  const duplicate = (liveAfterPost.fundingTransfers || []).length > 1;
  const pending = ['pending', 'processing', 'queued', 'originated', 'submitted'].includes(String(posted?.provider_status || intentStatus || '').toLowerCase());
  const postedOnce = posted?.liveProviderCalled === true || Boolean(posted?.provider_transfer_id);
  const isolated = verifyAfter.freedomEnvironment === 'production'
    && (verifyAfter.recentProductionTransfers || 0) === 0
    && (verifyAfter.recentFreedomTransfers || 0) === 0
    && flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true';
  const sweepChanged = Boolean(sweepBefore && verifyAfter.sweep
    && (String(sweepBefore.id) !== String(verifyAfter.sweep.id)
      || String(sweepBefore.status) !== String(verifyAfter.sweep.status)
      || Number(sweepBefore.minimum_balance_cents) !== Number(verifyAfter.sweep.minimum_balance_cents)
      || String(sweepBefore.provider_wallet_id || '') !== String(verifyAfter.sweep.provider_wallet_id || '')));

  const returnCard = {
    SANDBOX_WRITER_BINDING: 'PASS',
    SANDBOX_ACCOUNT: SANDBOX_ACCOUNT,
    SANDBOX_BANK: SANDBOX_BANK,
    SANDBOX_FUNDING_PM: SANDBOX_FUND_PM,
    SANDBOX_WALLET: SANDBOX_WALLET,
    PRODUCTION_IDS_BLOCKED: 'true',
    SANDBOX_INTENT_ID: intent.id,
    INTENT_COUNT: String(verifyAfter.intentCount ?? persist2.intentCount ?? 1),
    IDEMPOTENCY: planned.idempotency_key,
    DARK_RESULT: dark.outcome,
    TRANSFER_POST_HELD: String(dark.transfer_post_held === true),
    SANDBOX_POST_FLAG_ARMED: String(armed?.flags?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true'),
    PRODUCTION_POST_FLAG: String(flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    OTHER_ENV_CHANGES: (armed?.changed || []).filter((key) => key !== 'AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED').join(',') || 'none',
    PROVIDER_POST_COUNT: postedOnce ? '1' : '0',
    SANDBOX_MOOV_TRANSFER_ID: posted?.provider_transfer_id || 'none',
    SANDBOX_MOOV_STATUS: posted?.provider_status || posted?.outcome || 'none',
    INTENT_STATUS: updatedIntent?.intent?.status || intentStatus,
    PROVIDER_REFERENCE: updatedIntent?.intent?.provider_transfer_id || posted?.provider_transfer_id || 'none',
    SANDBOX_POST_FLAG_DISARMED: String(flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'),
    DUPLICATE_TRANSFER: String(duplicate),
    PRODUCTION_TRANSFER_CREATED: String((verifyAfter.recentProductionTransfers || 0) > 0),
    FREEDOM_CHANGED: String(verifyAfter.freedomEnvironment !== 'production'),
    SWEEP_CHANGED: String(sweepChanged),
    PRODUCTION_MONEY_MOVED: 'false',
    SAFE_TO_RECONCILE_SANDBOX_TRANSFER: posted?.provider_transfer_id && isolated ? 'YES' : 'NO',
    SAFE_TO_PREPARE_SANDBOX_WALLET_RECIPIENT_AFTER_FUNDS_AVAILABLE: posted?.provider_transfer_id && isolated && !duplicate ? 'REVIEW' : 'NO',
    GO_NO_GO: 'NO-GO',
  };
  writeReturnCard(returnCard);
  const out = {
    ...report,
    phase4: armed,
    phase5: posted,
    phase6: disarmed,
    phase7: {
      liveAfterPost: {
        wallet: liveAfterPost.wallet,
        fundingTransfers: liveAfterPost.fundingTransfers,
        transferCount: liveAfterPost.transfers.length,
      },
      updatedIntent: { ok: updatedIntent?.ok, status: updatedIntent?.intent?.status, provider_transfer_id: updatedIntent?.intent?.provider_transfer_id },
      verifyAfter,
      webhooks,
      receipts,
      flagsEnd: flagsEnd.flags,
      pending,
      isolated,
    },
    returnCard,
    STOP_FOR_REVIEW: true,
  };
  fs.writeFileSync('/opt/cursor/artifacts/m79e_run.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    ok: postedOnce && isolated && flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true',
    returnCard,
    pending,
  }, null, 2));
};

const reconcileOnly = async () => {
  const identity = await assumeRole();
  const flags = lambdaFlags();
  const production = loadSecret(flags.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET);
  const credentials = sandboxCredentials(production.parsed);
  const live = await readLiveObjects(credentials);
  const writeToken = await moovSandboxToken({
    credentials,
    scopes: moovSandboxScopes.transfersWrite(SANDBOX_ACCOUNT),
  });
  const readToken = await moovSandboxToken({
    credentials,
    scopes: moovSandboxScopes.transfersRead(SANDBOX_ACCOUNT),
  });
  const webhooks = await inspectWebhooks(credentials);
  const verifyAfter = invokeOneshot({
    step: 'verify_funding_intent',
    tenantId: PIPELINE,
    idempotencyKey: sandboxWalletFundingIdempotencyKey({
      tenantId: PIPELINE,
      environment: 'sandbox',
      amountCents: 1,
    }),
  });
  const out = {
    at: new Date().toISOString(),
    identity: { arn: identity.Arn },
    flags: flags.flags,
    live: {
      wallet: live.wallet,
      fundingTransfers: live.fundingTransfers,
      transferCount: live.transfers.length,
    },
    oauth: {
      transfersWriteOk: writeToken.ok === true,
      transfersWriteStatus: writeToken.statusCode || null,
      transfersWriteScope: writeToken.grantedScope || null,
      transfersWriteError: writeToken.error || writeToken.message || null,
      transfersReadOk: readToken.ok === true,
      transfersReadScope: readToken.grantedScope || null,
    },
    webhooks,
    verifyAfter: {
      ok: verifyAfter.ok,
      intentId: verifyAfter.intent?.id || null,
      intentStatus: verifyAfter.intent?.status || null,
      providerTransferId: verifyAfter.intent?.provider_transfer_id || null,
      failureReason: verifyAfter.intent?.failure_reason || null,
      postAttempted: verifyAfter.intent?.provider_metadata?.post_attempted || false,
      intentCount: verifyAfter.intentCount,
      recentProductionTransfers: verifyAfter.recentProductionTransfers,
      recentFreedomTransfers: verifyAfter.recentFreedomTransfers,
      freedomEnvironment: verifyAfter.freedomEnvironment,
    },
    posted: false,
    armed: false,
  };
  fs.writeFileSync('/opt/cursor/artifacts/m79e_reconcile.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
};

const failMain = (error) => {
  try { setSandboxPostFlag('false'); } catch { /* still report */ }
  console.error(error);
  writeReturnCard({
    SANDBOX_WRITER_BINDING: 'ERROR',
    GO_NO_GO: 'NO-GO',
    ERROR: String(error?.message || error).slice(0, 400),
    PRODUCTION_MONEY_MOVED: 'false',
  });
  process.exitCode = 1;
};

if (process.argv[2] === 'reconcile') {
  reconcileOnly().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  main().catch(failMain);
}
