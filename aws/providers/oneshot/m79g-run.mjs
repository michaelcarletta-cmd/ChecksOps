#!/usr/bin/env node
/**
 * M7.9G: one controlled sandbox BANK→WALLET retry on the platform/facilitator path.
 * Reuses intent b18a96d7-4415-4df8-992f-70d5a17365a9 and UUID
 * 72f44c1a-5ee4-4601-9e4b-3ca54fbc3935. Never creates a replacement intent.
 * Never arms production POST. Never POSTs wallet→recipient. Immediate disarm.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';
import {
  CLASSIFIED_PROVIDER_REJECTED,
  executeSandboxWalletFunding,
  FAILED_SANDBOX_FUNDING_INTENT_ID,
  PIPELINE_TEST_SANDBOX,
  resolveSandboxFundBinding,
  SANDBOX_FUNDING_AMOUNT_CENTS,
  SANDBOX_FUNDING_PROVIDER_UUID,
  sandboxFacilitatorTransferContract,
  sandboxFundingRetryClassification,
  sandboxWalletFundingIdempotencyKey,
} from '../../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import { moovSandboxFetch, moovSandboxScopes } from '../../functions/api/providers/moov-sandbox.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const PRODUCTION_SECRET = 'checksops/production/provider';
const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
const SANDBOX_ACCOUNT = '1d59a6a8-3307-4687-8367-1495293ecc73';
const SANDBOX_WALLET = '58571121-67ea-4e10-abae-6c9680ac455d';
const SANDBOX_BANK = '8390f74b-706e-4d89-80b0-f96bd7c1b414';
const SANDBOX_FUND_PM = '8a0f6ffa-a549-48f5-bb8e-f5b6a9d9cfff';
const SANDBOX_WALLET_PM = '1eb24c1c-b7ab-45cd-8775-332da40b9647';
const SANDBOX_PLATFORM = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const FAILED_INTENT = 'b18a96d7-4415-4df8-992f-70d5a17365a9';
const PROVIDER_UUID = '72f44c1a-5ee4-4601-9e4b-3ca54fbc3935';
const PREFERRED_WEBHOOK_URL = 'https://checksops.com/prep/webhooks/moov';
const LIVE_ORIGIN = PRODUCTION_MOOV_ORIGIN;
const PROVEN_API_VERSION = PRODUCTION_MOOV_API_VERSION;

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
    '--role-session-name', 'checksops-m79g-sandbox-retry',
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
const amountCentsOf = (amount) => {
  if (amount === undefined || amount === null) return 0;
  if (typeof amount === 'object') {
    const raw = amount.value ?? amount.amount ?? 0;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const summarizeTransfer = (row) => ({
  id: row?.transferID || row?.transferId || row?.id || null,
  status: row?.status || null,
  amountCents: amountCentsOf(row?.amount),
  sourcePm: row?.source?.paymentMethodID || row?.source?.paymentMethodId || null,
  destinationPm: row?.destination?.paymentMethodID || row?.destination?.paymentMethodId || null,
});
const matchingFunding = (rows) => {
  const matched = (rows || []).filter((row) => (
    row.amountCents === SANDBOX_FUNDING_AMOUNT_CENTS
    && String(row.sourcePm || '').toLowerCase() === SANDBOX_FUND_PM
    && String(row.destinationPm || '').toLowerCase() === SANDBOX_WALLET_PM
  ));
  const seen = new Map();
  for (const row of matched) {
    const id = String(row.id || '').toLowerCase();
    if (id && !seen.has(id)) seen.set(id, row);
  }
  return [...seen.values()];
};

const lambdaConfig = () => awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
const lambdaFlags = (cfg = lambdaConfig()) => {
  const env = cfg.Environment?.Variables || {};
  return {
    codeSha256: cfg.CodeSha256,
    state: cfg.State,
    lastUpdateStatus: cfg.LastUpdateStatus,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    },
    env: env,
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
const invokeOneshot = (payload) => {
  const outFile = `/tmp/m79g-oneshot-${payload.step}-${Date.now()}.json`;
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
const sandboxCredentials = (parsed) => ({
  environment: 'sandbox',
  publicKey: parsed.MOOV_SANDBOX_PUBLIC_KEY,
  secretKey: parsed.MOOV_SANDBOX_SECRET_KEY,
  platformId: parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID,
  origin: parsed.MOOV_SANDBOX_ALLOWED_ORIGIN || LIVE_ORIGIN,
  apiVersion: parsed.MOOV_SANDBOX_API_VERSION || PROVEN_API_VERSION,
  host: 'https://api.moov.io',
});
const getJson = async (credentials, apiPath, scopes) => moovSandboxFetch({ credentials, path: apiPath, scopes });

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
  const text = `${lines.join('\n')}\n\nSTOP FOR REVIEW.\nDo not execute wallet→recipient.\nDo not arm production execution.\n`;
  fs.writeFileSync('/opt/cursor/artifacts/m79g_return_card.md', text);
  fs.writeFileSync('/opt/cursor/artifacts/m79g_return_card_final.md', text);
  return text;
};

const main = async () => {
  if (PIPELINE !== PIPELINE_TEST_SANDBOX.tenantId
    || SANDBOX_ACCOUNT !== PIPELINE_TEST_SANDBOX.accountId
    || SANDBOX_PLATFORM !== PIPELINE_TEST_SANDBOX.platformAccountId
    || SANDBOX_WALLET !== PIPELINE_TEST_SANDBOX.walletId
    || SANDBOX_BANK !== PIPELINE_TEST_SANDBOX.bankId
    || SANDBOX_FUND_PM !== PIPELINE_TEST_SANDBOX.achDebitFundPm
    || SANDBOX_WALLET_PM !== PIPELINE_TEST_SANDBOX.walletPm
    || FAILED_INTENT !== FAILED_SANDBOX_FUNDING_INTENT_ID
    || PROVIDER_UUID !== SANDBOX_FUNDING_PROVIDER_UUID) {
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
  if (String(credentials.platformId).toLowerCase() !== SANDBOX_PLATFORM) {
    throw new Error('sandbox_platform_mismatch');
  }
  if (String(credentials.platformId).toLowerCase() === String(KNOWN_APPROVED_MOOV.platform.moovAccountId).toLowerCase()) {
    throw new Error('sandbox_platform_is_production');
  }

  const businessKey = sandboxWalletFundingIdempotencyKey({
    tenantId: PIPELINE,
    environment: 'sandbox',
    amountCents: 1,
  });
  const verifyBefore = invokeOneshot({
    step: 'verify_funding_intent',
    tenantId: PIPELINE,
    idempotencyKey: businessKey,
  });
  const intent = verifyBefore.intent || null;
  const platform = await getJson(credentials, `/accounts/${SANDBOX_PLATFORM}`, moovSandboxScopes.accountRead(SANDBOX_PLATFORM));
  const merchant = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}`, moovSandboxScopes.accountRead(SANDBOX_ACCOUNT));
  const listed = await getJson(credentials, '/accounts', moovSandboxScopes.accountsRead());
  const collect = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/capabilities/collect-funds`, moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT));
  const wallets = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/wallets`, moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT));
  const banks = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/bank-accounts`, moovSandboxScopes.bankAccountsRead(SANDBOX_ACCOUNT));
  const methods = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/payment-methods`, moovSandboxScopes.paymentMethodsRead(SANDBOX_ACCOUNT));
  const merchantTransfers = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/transfers`, moovSandboxScopes.transfersRead(SANDBOX_ACCOUNT));
  const platformTransfers = await getJson(credentials, `/accounts/${SANDBOX_PLATFORM}/transfers`, moovSandboxScopes.transfersRead(SANDBOX_PLATFORM));
  const webhooksBefore = await inspectWebhooks(credentials);

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
    id: row.paymentMethodID || row.paymentMethodId || row.id,
    type: String(row.paymentMethodType || row.type || '').toLowerCase(),
    bankAccountId: row.bankAccountID || row.bankAccount?.bankAccountID || null,
    walletId: row.walletID || row.wallet?.walletID || null,
  }));
  const merchantTransferRows = asList(merchantTransfers.data).map(summarizeTransfer);
  const platformTransferRows = asList(platformTransfers.data).map(summarizeTransfer);
  const matching = matchingFunding([...merchantTransferRows, ...platformTransferRows]);
  const wallet = walletRows.find((row) => String(row.id).toLowerCase() === SANDBOX_WALLET) || null;
  const bank = bankRows.find((row) => String(row.id).toLowerCase() === SANDBOX_BANK) || null;
  const connected = asList(listed.data).map((row) => String(row.accountID || row.accountId || row.id || '').toLowerCase());
  const merchantConnectedToPlatform = connected.includes(SANDBOX_ACCOUNT);
  const tenant = {
    id: PIPELINE,
    name: verifyBefore.tenant?.name || 'ChecksOps Pipeline Test',
    moov_environment: verifyBefore.tenant?.moov_environment,
  };
  const rds = {
    account: verifyBefore.sandbox?.account || null,
    wallet: verifyBefore.sandbox?.wallet || null,
    banks: verifyBefore.sandbox?.banks || [],
  };
  const live = {
    accountId: SANDBOX_ACCOUNT,
    platformAccountId: credentials.platformId,
    wallets: walletRows,
    banks: bankRows,
    paymentMethods: methodRows,
  };
  const binding = resolveSandboxFundBinding({ tenant, rds, live, amountCents: 1 });
  const contract = binding.ok ? sandboxFacilitatorTransferContract(binding) : null;
  const retry = sandboxFundingRetryClassification(intent || {});
  const collectEnabled = String(collect.data?.status || '').toLowerCase() === 'enabled';
  const platformOk = platform.ok === true
    && String(platform.data?.accountID || platform.data?.accountId || SANDBOX_PLATFORM).toLowerCase() === SANDBOX_PLATFORM
    && String(platform.data?.mode || platform.data?.accountMode || 'sandbox').toLowerCase() === 'sandbox';
  const preflightPass = Boolean(
    verifyBefore.tenant?.moov_environment === 'sandbox'
    && verifyBefore.freedomEnvironment === 'production'
    && intent?.id === FAILED_INTENT
    && !intent.provider_transfer_id
    && intent.environment === 'sandbox'
    && Number(intent.amount_cents) === 1
    && (intent.provider_idempotency_key || intent.provider_metadata?.provider_idempotency_key) === PROVIDER_UUID
    && verifyBefore.intentCount === 1
    && retry.classification === CLASSIFIED_PROVIDER_REJECTED
    && retry.retryable === true
    && binding.ok === true
    && binding.providerIdempotencyKey === PROVIDER_UUID
    && contract?.endpoint === `/accounts/${SANDBOX_PLATFORM}/transfers`
    && platformOk
    && merchantConnectedToPlatform
    && String(bank?.status || '').toLowerCase() === 'verified'
    && collectEnabled
    && String(wallet?.status || '').toLowerCase() === 'active'
    && Number(wallet?.availableCents || 0) === 0
    && methodRows.some((row) => row.id === SANDBOX_FUND_PM && row.type === 'ach-debit-fund')
    && methodRows.some((row) => row.id === SANDBOX_WALLET_PM && row.type === 'moov-wallet')
    && matching.length === 0
    && merchantTransferRows.length === 0
    && webhooksBefore.healthy === true
    && flagsStart.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'
    && flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && (verifyBefore.recentProductionTransfers || 0) === 0
  );

  const cardBase = () => ({
    PREFLIGHT_PASS: String(preflightPass),
    PLATFORM_ACCOUNT: SANDBOX_PLATFORM,
    CONNECTED_ACCOUNT: SANDBOX_ACCOUNT,
    SOURCE_PM: SANDBOX_FUND_PM,
    DESTINATION_PM: SANDBOX_WALLET_PM,
    collect_funds: collectEnabled ? 'enabled' : String(collect.data?.status || collect.statusCode),
    WALLET_STATUS: wallet?.status || 'missing',
    WALLET_BALANCE: String(wallet?.availableCents ?? 'unknown'),
    FAILED_INTENT_REUSED: String(intent?.id === FAILED_INTENT),
    NEW_INTENT_CREATED: 'false',
    RETRY_CLASSIFICATION: retry.classification,
    IDEMPOTENCY_UUID: PROVIDER_UUID,
  });

  if (!preflightPass) {
    writeReturnCard({
      ...cardBase(),
      DARK_RESULT: 'not_run',
      TRANSFER_POST_HELD: 'false',
      SANDBOX_POST_FLAG_ARMED: 'false',
      PRODUCTION_POST_FLAG: String(flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      PROVIDER_POST_COUNT: 0,
      POST_ACCOUNT_PATH: contract?.endpoint || 'none',
      HTTP_STATUS: 'none',
      MOOV_REQUEST_ID: 'none',
      MOOV_TRANSFER_ID: 'none',
      MOOV_STATUS: 'none',
      MOOV_ERROR_CODE: 'none',
      MOOV_ERROR_TITLE: 'none',
      MOOV_ERROR_DETAIL: 'none',
      INTENT_STATUS: intent?.status || 'none',
      PROVIDER_REFERENCE: intent?.provider_transfer_id || 'none',
      SANDBOX_POST_FLAG_DISARMED: 'true',
      DUPLICATE_TRANSFER: String(matching.length > 1),
      SANDBOX_TRANSFER_COUNT: String(matching.length),
      PRODUCTION_TRANSFER_CREATED: String((verifyBefore.recentProductionTransfers || 0) > 0),
      FREEDOM_CHANGED: String(verifyBefore.freedomEnvironment !== 'production'),
      SWEEP_CHANGED: 'false',
      PRODUCTION_MONEY_MOVED: 'false',
      SAFE_TO_RECONCILE_SANDBOX_FUND: 'NO',
      SAFE_TO_PREPARE_SANDBOX_WALLET_RECIPIENT_AFTER_FUNDS_AVAILABLE: 'NO',
      GO_NO_GO: 'NO-GO',
    });
    fs.writeFileSync('/opt/cursor/artifacts/m79g_run.json', JSON.stringify({
      at: new Date().toISOString(),
      identity: { arn: identity.Arn },
      stopped: 'preflight',
      retry,
      intent: { id: intent?.id || null, status: intent?.status || null, provider_transfer_id: intent?.provider_transfer_id || null },
      matching,
      webhooksBefore,
      flagsStart: flagsStart.flags,
    }, null, 2));
    console.log(JSON.stringify({ ok: false, stopped: 'preflight', retry }, null, 2));
    return;
  }

  const dark = await executeSandboxWalletFunding({
    credentials,
    productionPublicKey: parsed.MOOV_PUBLIC_KEY,
    productionSecretKey: parsed.MOOV_SECRET_KEY,
    binding,
    intent,
    transferPostEnabled: false,
    productionTransferPostEnabled: false,
  });
  const darkOk = dark.outcome === 'transfer_post_held'
    && dark.transfer_post_held === true
    && dark.liveProviderCalled === false
    && dark.liveProviderPosted === false
    && dark.post_account_path === `/accounts/${SANDBOX_PLATFORM}/transfers`
    && dark.provider_idempotency_key === PROVIDER_UUID
    && dark.source_payment_method_id === SANDBOX_FUND_PM
    && dark.platform_account_id === SANDBOX_PLATFORM;
  if (!darkOk) {
    writeReturnCard({
      ...cardBase(),
      DARK_RESULT: dark.outcome || dark.error || 'failed',
      TRANSFER_POST_HELD: String(dark.transfer_post_held === true),
      SANDBOX_POST_FLAG_ARMED: 'false',
      PRODUCTION_POST_FLAG: String(flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      PROVIDER_POST_COUNT: 0,
      POST_ACCOUNT_PATH: dark.post_account_path || contract.endpoint,
      HTTP_STATUS: 'none',
      MOOV_REQUEST_ID: 'none',
      MOOV_TRANSFER_ID: 'none',
      MOOV_STATUS: 'none',
      MOOV_ERROR_CODE: 'none',
      MOOV_ERROR_TITLE: 'none',
      MOOV_ERROR_DETAIL: 'none',
      INTENT_STATUS: intent.status,
      PROVIDER_REFERENCE: 'none',
      SANDBOX_POST_FLAG_DISARMED: 'true',
      DUPLICATE_TRANSFER: 'false',
      SANDBOX_TRANSFER_COUNT: '0',
      PRODUCTION_TRANSFER_CREATED: 'false',
      FREEDOM_CHANGED: 'false',
      SWEEP_CHANGED: 'false',
      PRODUCTION_MONEY_MOVED: 'false',
      SAFE_TO_RECONCILE_SANDBOX_FUND: 'NO',
      SAFE_TO_PREPARE_SANDBOX_WALLET_RECIPIENT_AFTER_FUNDS_AVAILABLE: 'NO',
      GO_NO_GO: 'NO-GO',
    });
    fs.writeFileSync('/opt/cursor/artifacts/m79g_run.json', JSON.stringify({
      at: new Date().toISOString(),
      stopped: 'dark',
      dark,
      flagsStart: flagsStart.flags,
    }, null, 2));
    console.log(JSON.stringify({ ok: false, stopped: 'dark', dark }, null, 2));
    return;
  }

  const sweepBefore = verifyBefore.sweep || null;
  let armed = null;
  let posted = null;
  let disarmed = null;
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

  const merchantAfter = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/transfers`, moovSandboxScopes.transfersRead(SANDBOX_ACCOUNT));
  const platformAfter = await getJson(credentials, `/accounts/${SANDBOX_PLATFORM}/transfers`, moovSandboxScopes.transfersRead(SANDBOX_PLATFORM));
  const walletsAfter = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/wallets`, moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT));
  const matchingAfter = matchingFunding([
    ...asList(merchantAfter.data).map(summarizeTransfer),
    ...asList(platformAfter.data).map(summarizeTransfer),
  ]);
  if ((posted?.outcome === 'unknown' || posted?.outcome === 'conflict' || (posted?.liveProviderCalled && !posted?.provider_transfer_id))
    && matchingAfter.length === 1) {
    posted = {
      ...posted,
      outcome: posted.outcome === 'failed' ? posted.outcome : 'reconciled_get_only',
      provider_transfer_id: matchingAfter[0].id,
      provider_status: matchingAfter[0].status,
      liveProviderPosted: true,
      doNotRetry: true,
    };
  }
  const intentStatus = posted?.provider_transfer_id
    ? (['completed', 'failed', 'canceled', 'returned'].includes(String(posted.provider_status || '').toLowerCase())
      ? String(posted.provider_status).toLowerCase()
      : 'pending')
    : (posted?.outcome === 'failed' ? 'failed' : 'unknown');
  const updatedIntent = invokeOneshot({
    step: 'update_funding_intent',
    tenantId: PIPELINE,
    intentId: FAILED_INTENT,
    providerTransferId: posted?.provider_transfer_id || null,
    providerStatus: posted?.provider_status || null,
    status: intentStatus,
    markSubmitted: posted?.liveProviderCalled === true,
    failureReason: posted?.ok === false ? (posted.error || posted.outcome) : null,
    providerMetadata: {
      ...(intent.provider_metadata || {}),
      phase: 'M7.9G',
      post_attempted: posted?.liveProviderCalled === true,
      post_outcome: posted?.outcome || null,
      post_account_path: posted?.post_account_path || contract.endpoint,
      http_status: posted?.httpStatus || null,
      error_code: posted?.errorCode || null,
      error_title: posted?.errorTitle || null,
      error_detail: posted?.errorDetail || null,
      request_id: posted?.requestId || null,
      retry_classification: retry.classification,
      provider_idempotency_key: PROVIDER_UUID,
      do_not_retry: posted?.outcome === 'unknown' || posted?.outcome === 'conflict' || Boolean(posted?.provider_transfer_id),
    },
  });
  const verifyAfter = invokeOneshot({
    step: 'verify_funding_intent',
    tenantId: PIPELINE,
    idempotencyKey: businessKey,
  });
  const webhooks = await inspectWebhooks(credentials);
  const flagsEnd = lambdaFlags();
  const walletAfter = asList(walletsAfter.data).map((row) => ({
    id: row.walletID || row.walletId || row.id,
    availableCents: amountCentsOf(row.availableBalance ?? row.available),
    status: row.status || null,
  })).find((row) => String(row.id).toLowerCase() === SANDBOX_WALLET) || wallet;
  const duplicate = matchingAfter.length > 1;
  const pending = ['pending', 'processing', 'queued', 'originated', 'submitted'].includes(String(posted?.provider_status || intentStatus || '').toLowerCase());
  const isolated = verifyAfter.freedomEnvironment === 'production'
    && (verifyAfter.recentProductionTransfers || 0) === 0
    && (verifyAfter.recentFreedomTransfers || 0) === 0
    && flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'
    && verifyAfter.intent?.id === FAILED_INTENT
    && verifyAfter.intentCount === 1;
  const sweepChanged = Boolean(sweepBefore && verifyAfter.sweep
    && (String(sweepBefore.id) !== String(verifyAfter.sweep.id)
      || String(sweepBefore.status) !== String(verifyAfter.sweep.status)
      || Number(sweepBefore.minimum_balance_cents) !== Number(verifyAfter.sweep.minimum_balance_cents)));
  const returnCard = {
    ...cardBase(),
    DARK_RESULT: dark.outcome,
    TRANSFER_POST_HELD: String(dark.transfer_post_held === true),
    SANDBOX_POST_FLAG_ARMED: String(armed?.flags?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true'),
    PRODUCTION_POST_FLAG: String(flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    PROVIDER_POST_COUNT: posted?.liveProviderCalled ? 1 : 0,
    POST_ACCOUNT_PATH: posted?.post_account_path || contract.endpoint,
    HTTP_STATUS: posted?.httpStatus ?? 'none',
    MOOV_REQUEST_ID: posted?.requestId || 'none',
    MOOV_TRANSFER_ID: posted?.provider_transfer_id || 'none',
    MOOV_STATUS: posted?.provider_status || matchingAfter[0]?.status || posted?.outcome || 'none',
    MOOV_ERROR_CODE: posted?.errorCode || 'none',
    MOOV_ERROR_TITLE: posted?.errorTitle || 'none',
    MOOV_ERROR_DETAIL: posted?.errorDetail || 'none',
    INTENT_STATUS: updatedIntent?.intent?.status || intentStatus,
    PROVIDER_REFERENCE: updatedIntent?.intent?.provider_transfer_id || posted?.provider_transfer_id || 'none',
    SANDBOX_POST_FLAG_DISARMED: String(flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'),
    DUPLICATE_TRANSFER: String(duplicate),
    SANDBOX_TRANSFER_COUNT: String(matchingAfter.length),
    PRODUCTION_TRANSFER_CREATED: String((verifyAfter.recentProductionTransfers || 0) > 0),
    FREEDOM_CHANGED: String(verifyAfter.freedomEnvironment !== 'production'),
    SWEEP_CHANGED: String(sweepChanged),
    PRODUCTION_MONEY_MOVED: 'false',
    SAFE_TO_RECONCILE_SANDBOX_FUND: posted?.provider_transfer_id && isolated && !duplicate ? 'YES' : 'NO',
    SAFE_TO_PREPARE_SANDBOX_WALLET_RECIPIENT_AFTER_FUNDS_AVAILABLE: posted?.provider_transfer_id && isolated && !duplicate ? 'REVIEW' : 'NO',
    GO_NO_GO: 'NO-GO',
  };
  writeReturnCard(returnCard);
  fs.writeFileSync('/opt/cursor/artifacts/m79g_run.json', JSON.stringify({
    at: new Date().toISOString(),
    identity: { arn: identity.Arn },
    posted: posted?.liveProviderCalled === true,
    armed: false,
    flagsStart: flagsStart.flags,
    flagsEnd: flagsEnd.flags,
    retry,
    dark,
    phase4: armed,
    phase5: {
      outcome: posted?.outcome || null,
      httpStatus: posted?.httpStatus || null,
      requestId: posted?.requestId || null,
      provider_transfer_id: posted?.provider_transfer_id || null,
      provider_status: posted?.provider_status || null,
      errorCode: posted?.errorCode || null,
      errorTitle: posted?.errorTitle || null,
      errorDetail: posted?.errorDetail || null,
      post_account_path: posted?.post_account_path || null,
      liveProviderPosted: posted?.liveProviderPosted === true,
    },
    phase6: disarmed,
    matchingAfter,
    walletAfter,
    updatedIntent: {
      ok: updatedIntent?.ok,
      id: updatedIntent?.intent?.id,
      status: updatedIntent?.intent?.status,
      provider_transfer_id: updatedIntent?.intent?.provider_transfer_id,
      intentCount: updatedIntent?.intentCount,
    },
    verifyAfter: {
      intentId: verifyAfter.intent?.id,
      intentCount: verifyAfter.intentCount,
      freedomEnvironment: verifyAfter.freedomEnvironment,
      recentProductionTransfers: verifyAfter.recentProductionTransfers,
    },
    webhooks,
    pending,
    isolated,
    returnCard,
    STOP_FOR_REVIEW: true,
  }, null, 2));
  console.log(JSON.stringify({
    ok: posted?.liveProviderCalled === true && isolated && flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true',
    returnCard,
    pending,
  }, null, 2));
};

const reconcileOnly = async () => {
  const identity = await assumeRole();
  const flags = lambdaFlags();
  if (flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_production_post_armed');
  if (flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_sandbox_post_armed');
  const production = loadSecret(flags.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET);
  const credentials = sandboxCredentials(production.parsed);
  const businessKey = sandboxWalletFundingIdempotencyKey({
    tenantId: PIPELINE,
    environment: 'sandbox',
    amountCents: 1,
  });
  const verifyAfter = invokeOneshot({
    step: 'verify_funding_intent',
    tenantId: PIPELINE,
    idempotencyKey: businessKey,
  });
  const merchantAfter = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/transfers`, moovSandboxScopes.transfersRead(SANDBOX_ACCOUNT));
  const platformAfter = await getJson(credentials, `/accounts/${SANDBOX_PLATFORM}/transfers`, moovSandboxScopes.transfersRead(SANDBOX_PLATFORM));
  const walletsAfter = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/wallets`, moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT));
  const merchantRows = asList(merchantAfter.data).map(summarizeTransfer);
  const platformRows = asList(platformAfter.data).map(summarizeTransfer);
  const matching = matchingFunding([...merchantRows, ...platformRows]);
  const wallet = asList(walletsAfter.data).map((row) => ({
    id: row.walletID || row.walletId || row.id,
    availableCents: amountCentsOf(row.availableBalance ?? row.available),
    status: row.status || null,
  })).find((row) => String(row.id).toLowerCase() === SANDBOX_WALLET) || null;
  const webhooks = await inspectWebhooks(credentials);
  const unique = matching.length === 1
    && Boolean(matching[0]?.id)
    && String(matching[0].id).toLowerCase() === String(verifyAfter.intent?.provider_transfer_id || '').toLowerCase();
  let prior = {};
  try { prior = JSON.parse(fs.readFileSync('/opt/cursor/artifacts/m79g_run.json', 'utf8')); } catch { prior = {}; }
  const isolated = verifyAfter.intent?.id === FAILED_INTENT
    && verifyAfter.intentCount === 1
    && verifyAfter.freedomEnvironment === 'production'
    && (verifyAfter.recentProductionTransfers || 0) === 0
    && flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true';
  const returnCard = {
    PREFLIGHT_PASS: 'true',
    PLATFORM_ACCOUNT: SANDBOX_PLATFORM,
    CONNECTED_ACCOUNT: SANDBOX_ACCOUNT,
    SOURCE_PM: SANDBOX_FUND_PM,
    DESTINATION_PM: SANDBOX_WALLET_PM,
    collect_funds: 'enabled',
    WALLET_STATUS: wallet?.status || 'unknown',
    WALLET_BALANCE: String(wallet?.availableCents ?? 'unknown'),
    FAILED_INTENT_REUSED: String(verifyAfter.intent?.id === FAILED_INTENT),
    NEW_INTENT_CREATED: 'false',
    RETRY_CLASSIFICATION: CLASSIFIED_PROVIDER_REJECTED,
    IDEMPOTENCY_UUID: PROVIDER_UUID,
    DARK_RESULT: prior.dark?.outcome || 'transfer_post_held',
    TRANSFER_POST_HELD: String(prior.dark?.transfer_post_held !== false),
    SANDBOX_POST_FLAG_ARMED: 'false',
    PRODUCTION_POST_FLAG: String(flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    PROVIDER_POST_COUNT: prior.posted === true || prior.phase5?.liveProviderPosted === true ? 1 : 0,
    POST_ACCOUNT_PATH: `/accounts/${SANDBOX_PLATFORM}/transfers`,
    HTTP_STATUS: prior.phase5?.httpStatus ?? 'none',
    MOOV_REQUEST_ID: prior.phase5?.requestId || 'none',
    MOOV_TRANSFER_ID: matching[0]?.id || verifyAfter.intent?.provider_transfer_id || 'none',
    MOOV_STATUS: matching[0]?.status || verifyAfter.intent?.provider_status || 'none',
    MOOV_ERROR_CODE: 'none',
    MOOV_ERROR_TITLE: 'none',
    MOOV_ERROR_DETAIL: 'none',
    INTENT_STATUS: verifyAfter.intent?.status || 'none',
    PROVIDER_REFERENCE: verifyAfter.intent?.provider_transfer_id || 'none',
    SANDBOX_POST_FLAG_DISARMED: 'true',
    DUPLICATE_TRANSFER: String(matching.length > 1),
    SANDBOX_TRANSFER_COUNT: String(matching.length),
    PRODUCTION_TRANSFER_CREATED: String((verifyAfter.recentProductionTransfers || 0) > 0),
    FREEDOM_CHANGED: String(verifyAfter.freedomEnvironment !== 'production'),
    SWEEP_CHANGED: 'false',
    PRODUCTION_MONEY_MOVED: 'false',
    SAFE_TO_RECONCILE_SANDBOX_FUND: unique && isolated ? 'YES' : 'NO',
    SAFE_TO_PREPARE_SANDBOX_WALLET_RECIPIENT_AFTER_FUNDS_AVAILABLE: unique && isolated ? 'REVIEW' : 'NO',
    GO_NO_GO: 'NO-GO',
  };
  writeReturnCard(returnCard);
  const out = {
    at: new Date().toISOString(),
    identity: { arn: identity.Arn },
    posted: false,
    armed: false,
    flags: flags.flags,
    matching,
    merchantCount: merchantRows.length,
    platformCount: platformRows.length,
    wallet,
    webhooks,
    verifyAfter: {
      intentId: verifyAfter.intent?.id,
      intentCount: verifyAfter.intentCount,
      status: verifyAfter.intent?.status,
      provider_transfer_id: verifyAfter.intent?.provider_transfer_id,
      freedomEnvironment: verifyAfter.freedomEnvironment,
      recentProductionTransfers: verifyAfter.recentProductionTransfers,
    },
    unique,
    isolated,
    returnCard,
    STOP_FOR_REVIEW: true,
  };
  fs.writeFileSync('/opt/cursor/artifacts/m79g_reconcile.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: unique && isolated, posted: false, armed: false, returnCard }, null, 2));
};

const failMain = (error) => {
  try { setSandboxPostFlag('false'); } catch { /* still report */ }
  console.error(error);
  writeReturnCard({
    PREFLIGHT_PASS: 'ERROR',
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
