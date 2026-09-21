#!/usr/bin/env node
/**
 * M7.10: one controlled sandbox WALLET→RECIPIENT $0.01 POST.
 * Never creates BANK→WALLET funding. Never arms production POST.
 * Never overlays protected money writers. Immediate disarm after one attempt.
 * Timeout/unknown is never retried.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';
import { PIPELINE_TEST_SANDBOX } from '../../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import {
  ensureSandboxRecipientAchCredit,
  executeSandboxWalletDisbursement,
  persistSandboxPayoutIntent,
  planSandboxWalletDisbursement,
  resolveSandboxPayoutBinding,
  SANDBOX_PAYOUT_AMOUNT_CENTS,
  SANDBOX_PAYOUT_PROVIDER_UUID,
  sandboxWalletDisbursementIdempotencyKey,
} from '../../functions/api/providers/production/moov-sandbox-wallet-disburse.mjs';
import { moovSandboxFetch, moovSandboxScopes } from '../../functions/api/providers/moov-sandbox.mjs';

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
const SANDBOX_RECIPIENT_ACCOUNT = '90050a69-84f3-41bb-aa30-490ca7e7bf34';
const SANDBOX_RECIPIENT_BANK = '92e17650-94ed-43cb-8bff-14cf506c3988';
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
    '--role-session-name', 'checksops-m710-sandbox-payout',
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
  if (Array.isArray(json?.capabilities)) return json.capabilities;
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
const summarizeTransfer = (row) => ({
  id: row?.transferID || row?.transferId || row?.id || null,
  status: row?.status || null,
  amountCents: amountCentsOf(row?.amount),
  sourcePm: row?.source?.paymentMethodID || row?.source?.paymentMethodId || null,
  destinationPm: row?.destination?.paymentMethodID || row?.destination?.paymentMethodId || null,
});
const matchingPayout = (rows, destPm) => {
  const dest = String(destPm || '').toLowerCase();
  const matched = (rows || []).filter((row) => (
    row.amountCents === SANDBOX_PAYOUT_AMOUNT_CENTS
    && String(row.sourcePm || '').toLowerCase() === SANDBOX_WALLET_PM
    && String(row.destinationPm || '').toLowerCase() !== SANDBOX_WALLET_PM
    && String(row.destinationPm || '').toLowerCase() !== SANDBOX_FUND_PM
    && (!dest || String(row.destinationPm || '').toLowerCase() === dest)
  ));
  const seen = new Map();
  for (const row of matched) {
    const id = String(row.id || '').toLowerCase();
    if (id && !seen.has(id)) seen.set(id, row);
  }
  return [...seen.values()];
};
const matchingFunding = (rows) => {
  const matched = (rows || []).filter((row) => (
    row.amountCents === 1
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
    env,
    envKeys: Object.keys(env).sort(),
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
const packOneshot = () => {
  const staging = path.join(os.tmpdir(), 'checksops-m710-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/77_moov_tenant_environment.sql'), path.join(staging, '77_moov_tenant_environment.sql'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/78_moov_recon_parity.sql'), path.join(staging, '78_moov_recon_parity.sql'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m710-oneshot.zip');
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
const loadSecret = (id) => {
  const raw = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', id]);
  return { parsed: JSON.parse(raw.SecretString || '{}') };
};
const invokeOneshot = (payload) => {
  const outFile = `/tmp/m710-oneshot-${payload.step}-${Date.now()}.json`;
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
  const text = `${lines.join('\n')}\n\nSTOP FOR REVIEW.\nDo not arm production execution.\nDo not create another funding transfer.\n`;
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/m710_return_card.md', text);
  fs.writeFileSync('/opt/cursor/artifacts/m710_return_card_final.md', text);
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
    || SANDBOX_RECIPIENT_ACCOUNT !== PIPELINE_TEST_SANDBOX.recipientAccountId
    || SANDBOX_RECIPIENT_BANK !== PIPELINE_TEST_SANDBOX.recipientBankId) {
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

  const zip = packOneshot();
  const secretsList = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secretsList.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  ensureOneshot(zip, adminSecret.ARN, flagsStart.vpc);

  const businessKey = sandboxWalletDisbursementIdempotencyKey({
    tenantId: PIPELINE,
    environment: 'sandbox',
    amountCents: 1,
  });
  const verifyTenant = invokeOneshot({ step: 'verify', tenantId: PIPELINE });
  const verifyFunding = invokeOneshot({
    step: 'verify_funding_intent',
    tenantId: PIPELINE,
    idempotencyKey: 'checksops:m79e:sandbox_bank_to_wallet:env:sandbox:tenant:3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43:leg:wallet_funding:cents:1',
  });
  const verifyPayoutBefore = invokeOneshot({
    step: 'verify_payout_intent',
    tenantId: PIPELINE,
    idempotencyKey: businessKey,
  });
  const sendFunds = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/capabilities/send-funds`, moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT));
  const sendFundsAch = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/capabilities/send-funds.ach`, moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT));
  const wallets = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/wallets`, moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT));
  const payerMethods = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/payment-methods`, moovSandboxScopes.paymentMethodsRead(SANDBOX_ACCOUNT));
  const recipient = await getJson(credentials, `/accounts/${SANDBOX_RECIPIENT_ACCOUNT}`, moovSandboxScopes.accountRead(SANDBOX_RECIPIENT_ACCOUNT));
  const recipientBanks = await getJson(credentials, `/accounts/${SANDBOX_RECIPIENT_ACCOUNT}/bank-accounts`, moovSandboxScopes.bankAccountsRead(SANDBOX_RECIPIENT_ACCOUNT));
  const recipientMethods = await getJson(credentials, `/accounts/${SANDBOX_RECIPIENT_ACCOUNT}/payment-methods`, moovSandboxScopes.paymentMethodsRead(SANDBOX_RECIPIENT_ACCOUNT));
  const ensureRecipientPm = await ensureSandboxRecipientAchCredit({
    credentials,
    attempts: 10,
    delayMs: 2000,
  });
  const merchantTransfers = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/transfers`, moovSandboxScopes.transfersRead(SANDBOX_ACCOUNT));
  const platformTransfers = await getJson(credentials, `/accounts/${SANDBOX_PLATFORM}/transfers`, moovSandboxScopes.transfersRead(SANDBOX_PLATFORM));
  const webhooksBefore = await inspectWebhooks(credentials);

  const walletRows = asList(wallets.data).map((row) => ({
    id: row.walletID || row.walletId || row.id,
    status: row.status || null,
    availableCents: amountCentsOf(row.availableBalance ?? row.available),
    pendingCents: amountCentsOf(row.pendingBalance ?? row.pending),
  }));
  const payerMethodRows = asList(payerMethods.data).map((row) => ({
    id: pmIdOf(row),
    type: pmType(row),
    bankAccountId: row.bankAccountID || row.bankAccount?.bankAccountID || null,
    walletId: row.walletID || row.wallet?.walletID || null,
  }));
  const recipientBankRows = asList(recipientBanks.data).map((row) => ({
    id: row.bankAccountID || row.bankAccountId || row.id,
    status: row.status || null,
  }));
  const recipientMethodRows = asList(recipientMethods.data).map((row) => ({
    id: pmIdOf(row),
    type: pmType(row),
    bankAccountId: row.bankAccountID || row.bankAccount?.bankAccountID || null,
  }));
  if (ensureRecipientPm.ok === true) {
    for (const row of (ensureRecipientPm.methods || [])) {
      if (!recipientMethodRows.some((existing) => String(existing.id).toLowerCase() === String(row.id).toLowerCase())) {
        recipientMethodRows.push(row);
      }
    }
  }
  const merchantTransferRows = asList(merchantTransfers.data).map(summarizeTransfer);
  const platformTransferRows = asList(platformTransfers.data).map(summarizeTransfer);
  const allTransfers = [...merchantTransferRows, ...platformTransferRows];
  const fundingRows = matchingFunding(allTransfers);
  const wallet = walletRows.find((row) => String(row.id).toLowerCase() === SANDBOX_WALLET) || null;
  const sendFundsStatus = String(sendFunds.data?.status || '').toLowerCase();
  const sendFundsAchStatus = String(sendFundsAch.data?.status || '').toLowerCase();
  const sendFundsEnabled = sendFundsStatus === 'enabled' || sendFundsStatus === 'active'
    || sendFundsAchStatus === 'enabled' || sendFundsAchStatus === 'active';
  const tenant = {
    id: PIPELINE,
    name: verifyTenant.tenant?.name || 'ChecksOps Pipeline Test',
    moov_environment: verifyTenant.tenant?.moov_environment || verifyPayoutBefore.tenant?.moov_environment,
  };
  const rds = {
    account: verifyTenant.sandbox?.account || verifyPayoutBefore.sandbox?.account || null,
    wallet: verifyTenant.sandbox?.wallet || verifyPayoutBefore.sandbox?.wallet || null,
    banks: verifyTenant.sandbox?.banks || verifyPayoutBefore.sandbox?.banks || [],
    recipient: (verifyTenant.sandbox?.recipients || verifyPayoutBefore.sandbox?.recipients || [])
      .find((row) => String(row.provider_account_id || '').toLowerCase() === SANDBOX_RECIPIENT_ACCOUNT) || null,
  };
  const live = {
    accountId: SANDBOX_ACCOUNT,
    platformAccountId: credentials.platformId,
    walletAvailableCents: wallet?.availableCents,
    wallets: walletRows,
    payerPaymentMethods: payerMethodRows,
    paymentMethods: payerMethodRows,
    recipientAccountId: SANDBOX_RECIPIENT_ACCOUNT,
    recipientBanks: recipientBankRows,
    recipientPaymentMethods: recipientMethodRows,
    payerCapabilities: [
      { capability: 'send-funds', status: sendFunds.data?.status || sendFunds.statusCode },
      { capability: 'send-funds.ach', status: sendFundsAch.data?.status || sendFundsAch.statusCode },
    ],
  };
  const productionHintDenied = resolveSandboxPayoutBinding({
    tenant,
    rds,
    live,
    clientHints: { recipientAccountId: KNOWN_APPROVED_MOOV.recipient.moovAccountId, amountCents: 1 },
  });
  const binding = resolveSandboxPayoutBinding({
    tenant,
    rds,
    live,
    clientHints: { environment: 'production', accountId: SANDBOX_ACCOUNT, destinationPaymentMethodId: SANDBOX_RECIPIENT_BANK, amountCents: 1 },
  });
  const destPm = binding.destinationPaymentMethodId || null;
  const payoutRows = matchingPayout(allTransfers, destPm);
  const planned = binding.ok ? planSandboxWalletDisbursement(binding) : binding;
  const walletAvailableBefore = Number(wallet?.availableCents ?? 0);
  const recipientReady = Boolean(
    recipient.ok === true
    && recipientBankRows.some((row) => String(row.id).toLowerCase() === SANDBOX_RECIPIENT_BANK)
    && destPm
  );
  const preflightPass = Boolean(
    tenant.moov_environment === 'sandbox'
    && verifyTenant.freedomEnvironment === 'production'
    && walletAvailableBefore >= 1
    && walletAvailableBefore === 1
    && Number(wallet?.pendingCents || 0) === 0
    && sendFundsEnabled
    && recipientReady
    && binding.ok === true
    && binding.sourcePaymentMethodId === SANDBOX_WALLET_PM
    && binding.destinationPaymentMethodId === destPm
    && destPm !== SANDBOX_WALLET_PM
    && destPm !== SANDBOX_FUND_PM
    && destPm !== SANDBOX_RECIPIENT_BANK
    && binding.walletId === SANDBOX_WALLET
    && binding.recipientAccountId === SANDBOX_RECIPIENT_ACCOUNT
    && binding.amountCents === 1
    && binding.providerIdempotencyKey === SANDBOX_PAYOUT_PROVIDER_UUID
    && binding.post_account_path === `/accounts/${SANDBOX_PLATFORM}/transfers`
    && productionHintDenied.ok === false
    && payoutRows.length === 0
    && (verifyPayoutBefore.payoutIntentCount || 0) === 0
    && !verifyPayoutBefore.intent
    && webhooksBefore.healthy === true
    && flagsStart.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'
    && flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && (verifyPayoutBefore.recentProductionTransfers || verifyFunding.recentProductionTransfers || 0) === 0
  );

  const cardBase = () => ({
    'PREFLIGHT PASS': String(preflightPass),
    'WALLET AVAILABLE BEFORE': String(walletAvailableBefore),
    'RECIPIENT READY': String(recipientReady),
    'send-funds': sendFundsEnabled ? 'enabled' : String(sendFunds.data?.status || sendFunds.statusCode || 'missing'),
  });

  if (walletAvailableBefore < 1) {
    writeReturnCard({
      ...cardBase(),
      'PAYOUT INTENT ID': 'none',
      'INTENT COUNT': String(verifyPayoutBefore.payoutIntentCount || 0),
      IDEMPOTENCY: businessKey,
      'DARK RESULT': 'not_run',
      TRANSFER_POST_HELD: 'false',
      'SANDBOX POST FLAG ARMED': 'false',
      'PRODUCTION POST FLAG': String(flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      'PROVIDER POST COUNT': 0,
      'POST ACCOUNT PATH': `/accounts/${SANDBOX_PLATFORM}/transfers`,
      'HTTP STATUS': 'none',
      'MOOV REQUEST ID': 'none',
      'MOOV TRANSFER ID': 'none',
      'MOOV STATUS': 'none',
      'MOOV ERROR CODE': 'none',
      'MOOV ERROR TITLE': 'none',
      'MOOV ERROR DETAIL': 'none',
      'INTENT STATUS': 'none',
      'PROVIDER REFERENCE': 'none',
      'SANDBOX POST FLAG DISARMED': 'true',
      'DUPLICATE TRANSFER': 'false',
      'NEW FUNDING INTENT': 'false',
      'PRODUCTION TRANSFER CREATED': 'false',
      'FREEDOM CHANGED': 'false',
      'SWEEP CHANGED': 'false',
      'PRODUCTION MONEY MOVED': 'false',
      'WALLET AVAILABLE AFTER': String(walletAvailableBefore),
      'WALLET PENDING AFTER': String(wallet?.pendingCents ?? 'unknown'),
      'SAFE TO RECONCILE SANDBOX PAYOUT': 'NO',
      'SAFE TO RUN REPEATED SANDBOX END-TO-END TESTS AFTER THIS': 'NO',
      'GO/NO-GO': 'NO-GO',
    });
    fs.writeFileSync('/opt/cursor/artifacts/m710_run.json', JSON.stringify({
      at: new Date().toISOString(),
      stopped: 'wallet_available_insufficient',
      wallet,
      flagsStart: flagsStart.flags,
    }, null, 2));
    console.log(JSON.stringify({ ok: false, stopped: 'wallet_available_insufficient', walletAvailableBefore }, null, 2));
    return;
  }

  if (!preflightPass) {
    writeReturnCard({
      ...cardBase(),
      'PAYOUT INTENT ID': verifyPayoutBefore.intent?.id || 'none',
      'INTENT COUNT': String(verifyPayoutBefore.payoutIntentCount || 0),
      IDEMPOTENCY: businessKey,
      'DARK RESULT': 'not_run',
      TRANSFER_POST_HELD: 'false',
      'SANDBOX POST FLAG ARMED': 'false',
      'PRODUCTION POST FLAG': String(flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      'PROVIDER POST COUNT': 0,
      'POST ACCOUNT PATH': binding.post_account_path || `/accounts/${SANDBOX_PLATFORM}/transfers`,
      'HTTP STATUS': 'none',
      'MOOV REQUEST ID': 'none',
      'MOOV TRANSFER ID': payoutRows[0]?.id || 'none',
      'MOOV STATUS': payoutRows[0]?.status || 'none',
      'MOOV ERROR CODE': binding.ok ? 'none' : (binding.error || 'preflight'),
      'MOOV ERROR TITLE': 'none',
      'MOOV ERROR DETAIL': 'none',
      'INTENT STATUS': verifyPayoutBefore.intent?.status || 'none',
      'PROVIDER REFERENCE': verifyPayoutBefore.intent?.provider_transfer_id || 'none',
      'SANDBOX POST FLAG DISARMED': 'true',
      'DUPLICATE TRANSFER': String(payoutRows.length > 1),
      'NEW FUNDING INTENT': 'false',
      'PRODUCTION TRANSFER CREATED': String((verifyPayoutBefore.recentProductionTransfers || 0) > 0),
      'FREEDOM CHANGED': String(verifyTenant.freedomEnvironment !== 'production'),
      'SWEEP CHANGED': 'false',
      'PRODUCTION MONEY MOVED': 'false',
      'WALLET AVAILABLE AFTER': String(walletAvailableBefore),
      'WALLET PENDING AFTER': String(wallet?.pendingCents ?? 'unknown'),
      'SAFE TO RECONCILE SANDBOX PAYOUT': payoutRows.length === 1 ? 'YES' : 'NO',
      'SAFE TO RUN REPEATED SANDBOX END-TO-END TESTS AFTER THIS': 'NO',
      'GO/NO-GO': 'NO-GO',
    });
    fs.writeFileSync('/opt/cursor/artifacts/m710_run.json', JSON.stringify({
      at: new Date().toISOString(),
      identity: { arn: identity.Arn },
      stopped: 'preflight',
      binding,
      productionHintDenied: { ok: productionHintDenied.ok, error: productionHintDenied.error },
      wallet,
      destPm,
      ensureRecipientPm: {
        ok: ensureRecipientPm.ok,
        error: ensureRecipientPm.error || null,
        reused: ensureRecipientPm.reused === true,
        destinationPaymentMethodId: ensureRecipientPm.destinationPaymentMethodId || null,
        requested: ensureRecipientPm.requested || [],
        methodCount: (ensureRecipientPm.methods || recipientMethodRows).length,
      },
      payoutRows,
      fundingRows: fundingRows.map((row) => row.id),
      sendFunds: { status: sendFundsStatus, ach: sendFundsAchStatus },
      recipientReady,
      webhooksBefore,
      flagsStart: flagsStart.flags,
    }, null, 2));
    console.log(JSON.stringify({ ok: false, stopped: 'preflight', bindingError: binding.error || null, destPm }, null, 2));
    return;
  }

  const persist1 = invokeOneshot({
    step: 'persist_payout_intent',
    tenantId: PIPELINE,
    idempotencyKey: planned.idempotency_key,
    providerIdempotencyKey: planned.provider_idempotency_key,
    accountId: SANDBOX_ACCOUNT,
    walletId: SANDBOX_WALLET,
    recipientAccountId: SANDBOX_RECIPIENT_ACCOUNT,
    recipientBankId: SANDBOX_RECIPIENT_BANK,
    sourcePaymentMethodId: SANDBOX_WALLET_PM,
    destinationPaymentMethodId: destPm,
    providerMetadata: planned.provider_metadata,
  });
  const persist2 = invokeOneshot({
    step: 'persist_payout_intent',
    tenantId: PIPELINE,
    idempotencyKey: planned.idempotency_key,
    providerIdempotencyKey: planned.provider_idempotency_key,
    accountId: SANDBOX_ACCOUNT,
    walletId: SANDBOX_WALLET,
    recipientAccountId: SANDBOX_RECIPIENT_ACCOUNT,
    recipientBankId: SANDBOX_RECIPIENT_BANK,
    sourcePaymentMethodId: SANDBOX_WALLET_PM,
    destinationPaymentMethodId: destPm,
  });
  const memoryReplay = await persistSandboxPayoutIntent({
    async getIntent() { return persist1.intent; },
    async putIntent() { throw new Error('must_reuse'); },
  }, planned);
  const intent = persist2.intent || persist1.intent || null;
  const phase2Ok = persist1.ok === true
    && persist2.ok === true
    && persist2.reused === true
    && persist2.payoutIntentCount === 1
    && persist2.intentCount === 1
    && intent?.id
    && intent.environment === 'sandbox'
    && Number(intent.amount_cents) === 1
    && intent.leg_role === 'wallet_disbursement'
    && memoryReplay.reused === true
    && persist2.fundingIntentCount === (verifyFunding.fundingIntentCount || persist1.fundingIntentCount);

  if (!phase2Ok) {
    writeReturnCard({
      ...cardBase(),
      'PAYOUT INTENT ID': intent?.id || persist1.error || 'none',
      'INTENT COUNT': String(persist2.payoutIntentCount ?? persist1.payoutIntentCount ?? 0),
      IDEMPOTENCY: planned.idempotency_key,
      'DARK RESULT': 'not_run',
      TRANSFER_POST_HELD: 'false',
      'SANDBOX POST FLAG ARMED': 'false',
      'PRODUCTION POST FLAG': String(flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      'PROVIDER POST COUNT': 0,
      'POST ACCOUNT PATH': binding.post_account_path,
      'HTTP STATUS': 'none',
      'MOOV REQUEST ID': 'none',
      'MOOV TRANSFER ID': 'none',
      'MOOV STATUS': 'none',
      'MOOV ERROR CODE': persist1.error || persist2.error || 'none',
      'MOOV ERROR TITLE': 'none',
      'MOOV ERROR DETAIL': 'none',
      'INTENT STATUS': intent?.status || 'none',
      'PROVIDER REFERENCE': intent?.provider_transfer_id || 'none',
      'SANDBOX POST FLAG DISARMED': 'true',
      'DUPLICATE TRANSFER': 'false',
      'NEW FUNDING INTENT': String(persist2.fundingIntentCount !== (verifyFunding.fundingIntentCount || persist1.fundingIntentCount)),
      'PRODUCTION TRANSFER CREATED': String((persist2.recentProductionTransfers || 0) > 0),
      'FREEDOM CHANGED': 'false',
      'SWEEP CHANGED': 'false',
      'PRODUCTION MONEY MOVED': 'false',
      'WALLET AVAILABLE AFTER': String(walletAvailableBefore),
      'WALLET PENDING AFTER': String(wallet?.pendingCents ?? 'unknown'),
      'SAFE TO RECONCILE SANDBOX PAYOUT': 'NO',
      'SAFE TO RUN REPEATED SANDBOX END-TO-END TESTS AFTER THIS': 'NO',
      'GO/NO-GO': 'NO-GO',
    });
    fs.writeFileSync('/opt/cursor/artifacts/m710_run.json', JSON.stringify({
      at: new Date().toISOString(),
      stopped: 'persist',
      persist1: { ok: persist1.ok, error: persist1.error, intentId: persist1.intent?.id },
      persist2: { ok: persist2.ok, reused: persist2.reused, payoutIntentCount: persist2.payoutIntentCount },
      flagsStart: flagsStart.flags,
    }, null, 2));
    console.log(JSON.stringify({ ok: false, stopped: 'persist', persist1, persist2 }, null, 2));
    return;
  }

  const flagsDark = lambdaFlags();
  const dark = await executeSandboxWalletDisbursement({
    credentials,
    productionPublicKey: parsed.MOOV_PUBLIC_KEY,
    productionSecretKey: parsed.MOOV_SECRET_KEY,
    binding,
    intent,
    transferPostEnabled: flagsDark.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true',
    productionTransferPostEnabled: flagsDark.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true',
  });
  const walletsAfterDark = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/wallets`, moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT));
  const walletAfterDark = asList(walletsAfterDark.data).map((row) => ({
    id: row.walletID || row.walletId || row.id,
    availableCents: amountCentsOf(row.availableBalance ?? row.available),
    pendingCents: amountCentsOf(row.pendingBalance ?? row.pending),
  })).find((row) => String(row.id).toLowerCase() === SANDBOX_WALLET) || wallet;
  const darkOk = dark.ok === true
    && dark.outcome === 'transfer_post_held'
    && dark.transfer_post_held === true
    && dark.liveProviderCalled === false
    && dark.liveProviderPosted === false
    && dark.post_account_path === `/accounts/${SANDBOX_PLATFORM}/transfers`
    && dark.provider_idempotency_key === SANDBOX_PAYOUT_PROVIDER_UUID
    && dark.source_payment_method_id === SANDBOX_WALLET_PM
    && dark.destination_payment_method_id === destPm
    && dark.account_id === SANDBOX_ACCOUNT
    && dark.recipient_account_id === SANDBOX_RECIPIENT_ACCOUNT
    && Number(walletAfterDark?.availableCents) === 1;
  if (!darkOk) {
    writeReturnCard({
      ...cardBase(),
      'PAYOUT INTENT ID': intent.id,
      'INTENT COUNT': String(persist2.payoutIntentCount),
      IDEMPOTENCY: planned.idempotency_key,
      'DARK RESULT': dark.outcome || dark.error || 'failed',
      TRANSFER_POST_HELD: String(dark.transfer_post_held === true),
      'SANDBOX POST FLAG ARMED': 'false',
      'PRODUCTION POST FLAG': String(flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      'PROVIDER POST COUNT': 0,
      'POST ACCOUNT PATH': dark.post_account_path || binding.post_account_path,
      'HTTP STATUS': 'none',
      'MOOV REQUEST ID': 'none',
      'MOOV TRANSFER ID': 'none',
      'MOOV STATUS': 'none',
      'MOOV ERROR CODE': dark.error || 'none',
      'MOOV ERROR TITLE': 'none',
      'MOOV ERROR DETAIL': 'none',
      'INTENT STATUS': intent.status,
      'PROVIDER REFERENCE': 'none',
      'SANDBOX POST FLAG DISARMED': 'true',
      'DUPLICATE TRANSFER': 'false',
      'NEW FUNDING INTENT': 'false',
      'PRODUCTION TRANSFER CREATED': 'false',
      'FREEDOM CHANGED': 'false',
      'SWEEP CHANGED': 'false',
      'PRODUCTION MONEY MOVED': 'false',
      'WALLET AVAILABLE AFTER': String(walletAfterDark?.availableCents ?? 'unknown'),
      'WALLET PENDING AFTER': String(walletAfterDark?.pendingCents ?? 'unknown'),
      'SAFE TO RECONCILE SANDBOX PAYOUT': 'NO',
      'SAFE TO RUN REPEATED SANDBOX END-TO-END TESTS AFTER THIS': 'NO',
      'GO/NO-GO': 'NO-GO',
    });
    fs.writeFileSync('/opt/cursor/artifacts/m710_run.json', JSON.stringify({
      at: new Date().toISOString(),
      stopped: 'dark',
      dark,
      walletAfterDark,
      flagsStart: flagsStart.flags,
    }, null, 2));
    console.log(JSON.stringify({ ok: false, stopped: 'dark', dark }, null, 2));
    return;
  }

  const alreadyAttempted = Boolean(intent?.provider_transfer_id)
    || intent?.provider_metadata?.post_attempted === true
    || intent?.status === 'failed'
    || intent?.status === 'unknown';
  if (alreadyAttempted) {
    writeReturnCard({
      ...cardBase(),
      'PAYOUT INTENT ID': intent.id,
      'INTENT COUNT': String(persist2.payoutIntentCount),
      IDEMPOTENCY: planned.idempotency_key,
      'DARK RESULT': dark.outcome,
      TRANSFER_POST_HELD: String(dark.transfer_post_held === true),
      'SANDBOX POST FLAG ARMED': 'false',
      'PRODUCTION POST FLAG': String(flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      'PROVIDER POST COUNT': '1_prior_attempt_not_retried',
      'POST ACCOUNT PATH': binding.post_account_path,
      'HTTP STATUS': 'none',
      'MOOV REQUEST ID': 'none',
      'MOOV TRANSFER ID': intent.provider_transfer_id || 'none',
      'MOOV STATUS': intent.provider_status || 'none',
      'MOOV ERROR CODE': 'none',
      'MOOV ERROR TITLE': 'none',
      'MOOV ERROR DETAIL': 'none',
      'INTENT STATUS': intent.status,
      'PROVIDER REFERENCE': intent.provider_transfer_id || 'none',
      'SANDBOX POST FLAG DISARMED': 'true',
      'DUPLICATE TRANSFER': 'false',
      'NEW FUNDING INTENT': 'false',
      'PRODUCTION TRANSFER CREATED': 'false',
      'FREEDOM CHANGED': 'false',
      'SWEEP CHANGED': 'false',
      'PRODUCTION MONEY MOVED': 'false',
      'WALLET AVAILABLE AFTER': String(walletAfterDark?.availableCents ?? 'unknown'),
      'WALLET PENDING AFTER': String(walletAfterDark?.pendingCents ?? 'unknown'),
      'SAFE TO RECONCILE SANDBOX PAYOUT': intent.provider_transfer_id ? 'YES' : 'NO',
      'SAFE TO RUN REPEATED SANDBOX END-TO-END TESTS AFTER THIS': 'NO',
      'GO/NO-GO': 'NO-GO',
    });
    fs.writeFileSync('/opt/cursor/artifacts/m710_run.json', JSON.stringify({
      at: new Date().toISOString(),
      stopped: 'already_attempted_no_retry',
      intent: { id: intent.id, status: intent.status, provider_transfer_id: intent.provider_transfer_id },
      flagsStart: flagsStart.flags,
    }, null, 2));
    console.log(JSON.stringify({ ok: true, stopped: 'already_attempted_no_retry' }, null, 2));
    return;
  }

  const sweepBefore = verifyPayoutBefore.sweep || verifyFunding.sweep || verifyTenant.sweep || null;
  const fundingCountBefore = persist2.fundingIntentCount;
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
    posted = await executeSandboxWalletDisbursement({
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
  const payoutAfter = matchingPayout([
    ...asList(merchantAfter.data).map(summarizeTransfer),
    ...asList(platformAfter.data).map(summarizeTransfer),
  ], destPm);
  const fundingAfter = matchingFunding([
    ...asList(merchantAfter.data).map(summarizeTransfer),
    ...asList(platformAfter.data).map(summarizeTransfer),
  ]);
  if ((posted?.outcome === 'unknown' || posted?.outcome === 'conflict' || (posted?.liveProviderCalled && !posted?.provider_transfer_id))
    && payoutAfter.length === 1) {
    posted = {
      ...posted,
      outcome: posted.outcome === 'failed' ? posted.outcome : 'reconciled_get_only',
      provider_transfer_id: payoutAfter[0].id,
      provider_status: payoutAfter[0].status,
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
    step: 'update_payout_intent',
    tenantId: PIPELINE,
    intentId: intent.id,
    providerTransferId: posted?.provider_transfer_id || null,
    providerStatus: posted?.provider_status || null,
    status: intentStatus,
    markSubmitted: posted?.liveProviderCalled === true,
    failureReason: posted?.ok === false ? (posted.error || posted.outcome) : null,
    providerMetadata: {
      ...(planned.provider_metadata || {}),
      phase: 'M7.10',
      post_attempted: posted?.liveProviderCalled === true,
      post_outcome: posted?.outcome || null,
      post_account_path: posted?.post_account_path || binding.post_account_path,
      http_status: posted?.httpStatus || null,
      error_code: posted?.errorCode || null,
      error_title: posted?.errorTitle || null,
      error_detail: posted?.errorDetail || null,
      request_id: posted?.requestId || null,
      provider_idempotency_key: SANDBOX_PAYOUT_PROVIDER_UUID,
      do_not_retry: true,
    },
  });
  const verifyAfter = invokeOneshot({
    step: 'verify_payout_intent',
    tenantId: PIPELINE,
    idempotencyKey: businessKey,
  });
  const webhooks = await inspectWebhooks(credentials);
  const flagsEnd = lambdaFlags();
  const walletAfter = asList(walletsAfter.data).map((row) => ({
    id: row.walletID || row.walletId || row.id,
    availableCents: amountCentsOf(row.availableBalance ?? row.available),
    pendingCents: amountCentsOf(row.pendingBalance ?? row.pending),
    status: row.status || null,
  })).find((row) => String(row.id).toLowerCase() === SANDBOX_WALLET) || wallet;
  const duplicate = payoutAfter.length > 1;
  const pending = ['pending', 'processing', 'queued', 'originated', 'submitted'].includes(String(posted?.provider_status || intentStatus || '').toLowerCase());
  const isolated = verifyAfter.freedomEnvironment === 'production'
    && (verifyAfter.recentProductionTransfers || 0) === 0
    && (verifyAfter.recentFreedomTransfers || 0) === 0
    && flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'
    && verifyAfter.intent?.id === intent.id
    && verifyAfter.payoutIntentCount === 1
    && verifyAfter.fundingIntentCount === fundingCountBefore;
  const sweepChanged = Boolean(sweepBefore && verifyAfter.sweep
    && (String(sweepBefore.id) !== String(verifyAfter.sweep.id)
      || String(sweepBefore.status) !== String(verifyAfter.sweep.status)
      || Number(sweepBefore.minimum_balance_cents) !== Number(verifyAfter.sweep.minimum_balance_cents)));
  const newFunding = verifyAfter.fundingIntentCount !== fundingCountBefore || fundingAfter.length !== fundingRows.length;
  const completed = String(posted?.provider_status || '').toLowerCase() === 'completed';
  const safeReconcile = Boolean(posted?.provider_transfer_id && isolated && !duplicate);
  const returnCard = {
    ...cardBase(),
    'PAYOUT INTENT ID': intent.id,
    'INTENT COUNT': String(verifyAfter.payoutIntentCount ?? persist2.payoutIntentCount ?? 1),
    IDEMPOTENCY: planned.idempotency_key,
    'DARK RESULT': dark.outcome,
    TRANSFER_POST_HELD: String(dark.transfer_post_held === true),
    'SANDBOX POST FLAG ARMED': String(armed?.flags?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true'),
    'PRODUCTION POST FLAG': String(flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    'PROVIDER POST COUNT': posted?.liveProviderCalled ? 1 : 0,
    'POST ACCOUNT PATH': posted?.post_account_path || binding.post_account_path,
    'HTTP STATUS': posted?.httpStatus ?? 'none',
    'MOOV REQUEST ID': posted?.requestId || 'none',
    'MOOV TRANSFER ID': posted?.provider_transfer_id || 'none',
    'MOOV STATUS': posted?.provider_status || payoutAfter[0]?.status || posted?.outcome || 'none',
    'MOOV ERROR CODE': posted?.errorCode || 'none',
    'MOOV ERROR TITLE': posted?.errorTitle || 'none',
    'MOOV ERROR DETAIL': posted?.errorDetail || 'none',
    'INTENT STATUS': updatedIntent?.intent?.status || intentStatus,
    'PROVIDER REFERENCE': updatedIntent?.intent?.provider_transfer_id || posted?.provider_transfer_id || 'none',
    'SANDBOX POST FLAG DISARMED': String(flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'),
    'DUPLICATE TRANSFER': String(duplicate),
    'NEW FUNDING INTENT': String(newFunding),
    'PRODUCTION TRANSFER CREATED': String((verifyAfter.recentProductionTransfers || 0) > 0),
    'FREEDOM CHANGED': String(verifyAfter.freedomEnvironment !== 'production'),
    'SWEEP CHANGED': String(sweepChanged),
    'PRODUCTION MONEY MOVED': 'false',
    'WALLET AVAILABLE AFTER': String(walletAfter?.availableCents ?? 'unknown'),
    'WALLET PENDING AFTER': String(walletAfter?.pendingCents ?? 'unknown'),
    'SAFE TO RECONCILE SANDBOX PAYOUT': safeReconcile ? 'YES' : 'NO',
    'SAFE TO RUN REPEATED SANDBOX END-TO-END TESTS AFTER THIS': safeReconcile && completed && !pending ? 'REVIEW' : 'NO',
    'GO/NO-GO': safeReconcile && completed && !pending ? 'REVIEW' : 'NO-GO',
  };
  writeReturnCard(returnCard);
  fs.writeFileSync('/opt/cursor/artifacts/m710_run.json', JSON.stringify({
    at: new Date().toISOString(),
    identity: { arn: identity.Arn },
    posted: posted?.liveProviderCalled === true,
    armed: false,
    flagsStart: flagsStart.flags,
    flagsEnd: flagsEnd.flags,
    destPm,
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
    payoutAfter,
    fundingAfter: fundingAfter.map((row) => row.id),
    walletAfter,
    updatedIntent: {
      ok: updatedIntent?.ok,
      id: updatedIntent?.intent?.id,
      status: updatedIntent?.intent?.status,
      provider_transfer_id: updatedIntent?.intent?.provider_transfer_id,
      payoutIntentCount: updatedIntent?.payoutIntentCount,
      fundingIntentCount: updatedIntent?.fundingIntentCount,
    },
    verifyAfter: {
      intentId: verifyAfter.intent?.id,
      payoutIntentCount: verifyAfter.payoutIntentCount,
      fundingIntentCount: verifyAfter.fundingIntentCount,
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

const failMain = (error) => {
  try { setSandboxPostFlag('false'); } catch { /* still report */ }
  console.error(error);
  writeReturnCard({
    'PREFLIGHT PASS': 'ERROR',
    'GO/NO-GO': 'NO-GO',
    ERROR: String(error?.message || error).slice(0, 400),
    'PRODUCTION MONEY MOVED': 'false',
  });
  process.exitCode = 1;
};

main().catch(failMain);
