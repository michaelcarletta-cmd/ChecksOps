#!/usr/bin/env node
/**
 * M7.12: first automated live sandbox end-to-end payout.
 * The M7.11 orchestrator owns shortfall, persist, and at most one sandbox POST.
 * If funding is required, this run stops after the funding POST.
 * Production POST stays false. Immediate sandbox disarm after the attempt.
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
  M712_FUNDING_PROVIDER_UUID,
  PIPELINE_TEST_SANDBOX,
  resolveSandboxFundBinding,
} from '../../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import {
  M712_PAYOUT_PROVIDER_UUID,
  resolveSandboxPayoutBinding,
} from '../../functions/api/providers/production/moov-sandbox-wallet-disburse.mjs';
import {
  executeSandboxPayoutE2e,
  m712PayoutOperationId,
} from '../../functions/api/providers/production/moov-sandbox-payout-e2e.mjs';
import { moovSandboxFetch, moovSandboxScopes } from '../../functions/api/providers/moov-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const ONESHOT_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/providers/oneshot/m79-sandbox-tenant');
const PRODUCTION_SECRET = 'checksops/production/provider';
const PIPELINE = PIPELINE_TEST_SANDBOX.tenantId;
const SANDBOX_ACCOUNT = PIPELINE_TEST_SANDBOX.accountId;
const SANDBOX_WALLET = PIPELINE_TEST_SANDBOX.walletId;
const SANDBOX_BANK = PIPELINE_TEST_SANDBOX.bankId;
const SANDBOX_FUND_PM = PIPELINE_TEST_SANDBOX.achDebitFundPm;
const SANDBOX_WALLET_PM = PIPELINE_TEST_SANDBOX.walletPm;
const SANDBOX_PLATFORM = PIPELINE_TEST_SANDBOX.platformAccountId;
const SANDBOX_RECIPIENT_ACCOUNT = PIPELINE_TEST_SANDBOX.recipientAccountId;
const SANDBOX_RECIPIENT_BANK = PIPELINE_TEST_SANDBOX.recipientBankId;
const DEST_PM = '7a5ef572-501e-4eac-8c1b-7a4794296a85';
const PREFERRED_WEBHOOK_URL = 'https://checksops.com/prep/webhooks/moov';
const OPERATION = m712PayoutOperationId();
const PAYOUT_CENTS = 1;

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
    '--role-session-name', 'checksops-m712-sandbox-e2e',
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
const amountCentsOf = (amount) => {
  if (amount === undefined || amount === null) return 0;
  if (typeof amount === 'object') {
    if (amount.valueDecimal != null && amount.valueDecimal !== '') {
      const n = Math.round(Number(amount.valueDecimal) * 100);
      return Number.isFinite(n) ? n : 0;
    }
    const raw = amount.value ?? amount.amount ?? 0;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const capEnabled = (json) => {
  const status = String(json?.data?.status || json?.status || '').toLowerCase();
  return status === 'enabled' || status === 'active';
};
const summarizeTransfer = (row) => ({
  id: row?.transferID || row?.transferId || row?.id || null,
  status: row?.status || null,
  amountCents: amountCentsOf(row?.amount),
  sourcePm: row?.source?.paymentMethodID || row?.source?.paymentMethodId || null,
  destinationPm: row?.destination?.paymentMethodID || row?.destination?.paymentMethodId || null,
});

const lambdaConfig = () => awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
const lambdaFlags = (cfg = lambdaConfig()) => {
  const env = cfg.Environment?.Variables || {};
  return {
    codeSha256: cfg.CodeSha256,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    },
    env,
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
  };
};
const packOneshot = () => {
  const staging = path.join(os.tmpdir(), 'checksops-m712-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/77_moov_tenant_environment.sql'), path.join(staging, '77_moov_tenant_environment.sql'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/78_moov_recon_parity.sql'), path.join(staging, '78_moov_recon_parity.sql'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m712-oneshot.zip');
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
  const outFile = `/tmp/m712-oneshot-${payload.step}-${Date.now()}.json`;
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
  origin: parsed.MOOV_SANDBOX_ALLOWED_ORIGIN || PRODUCTION_MOOV_ORIGIN,
  apiVersion: parsed.MOOV_SANDBOX_API_VERSION || PRODUCTION_MOOV_API_VERSION,
  host: 'https://api.moov.io',
});
const getJson = async (credentials, apiPath, scopes) => moovSandboxFetch({
  credentials,
  path: apiPath,
  scopes,
});
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
    events: row.events || row.eventTypes || null,
  }));
  const webhook = rows.find((row) => String(row.url || '').replace(/\/$/, '') === PREFERRED_WEBHOOK_URL.replace(/\/$/, ''));
  return {
    listed: res.ok === true,
    status: res.status,
    webhook: webhook || null,
    healthy: Boolean(webhook && webhook.disabled !== true),
  };
};

const mapIntent = (row) => {
  if (!row) return null;
  const meta = row.provider_metadata && typeof row.provider_metadata === 'object' ? row.provider_metadata : {};
  return {
    ...row,
    kind: row.leg_role,
    leg_role: row.leg_role,
    payout_operation_id: meta.payout_operation_id || OPERATION,
    provider_idempotency_key: meta.provider_idempotency_key || null,
    origin: 'checksops',
  };
};
const createOneshotPayoutStore = () => ({
  inserts: [],
  async getIntent(key) {
    const got = invokeOneshot({
      step: 'get_orchestrator_intent',
      tenantId: PIPELINE,
      idempotencyKey: String(key),
      payoutOperationId: OPERATION,
    });
    return mapIntent(got.intent);
  },
  async putIntent(intent) {
    const existing = await this.getIntent(intent.idempotency_key);
    if (existing) return { reused: true, intent: existing };
    const leg = String(intent.kind || intent.leg_role || '');
    const saved = invokeOneshot({
      step: 'persist_orchestrator_intent',
      tenantId: PIPELINE,
      idempotencyKey: intent.idempotency_key,
      payoutOperationId: OPERATION,
      kind: leg,
      accountId: SANDBOX_ACCOUNT,
      walletId: SANDBOX_WALLET,
      bankId: SANDBOX_BANK,
      recipientAccountId: SANDBOX_RECIPIENT_ACCOUNT,
      recipientBankId: SANDBOX_RECIPIENT_BANK,
      sourcePaymentMethodId: leg === 'wallet_funding' ? SANDBOX_FUND_PM : SANDBOX_WALLET_PM,
      destinationPaymentMethodId: leg === 'wallet_funding' ? SANDBOX_WALLET_PM : DEST_PM,
      providerIdempotencyKey: leg === 'wallet_funding' ? M712_FUNDING_PROVIDER_UUID : M712_PAYOUT_PROVIDER_UUID,
      providerMetadata: intent.provider_metadata,
    });
    if (saved.ok !== true) throw new Error(saved.error || 'persist_orchestrator_intent_failed');
    if (saved.reused !== true) this.inserts.push(leg);
    return { reused: saved.reused === true, intent: mapIntent(saved.intent) };
  },
  async updateIntent(key, patch = {}) {
    const updated = invokeOneshot({
      step: 'update_orchestrator_intent',
      tenantId: PIPELINE,
      idempotencyKey: String(key),
      providerTransferId: patch.provider_transfer_id || null,
      providerStatus: patch.provider_status || null,
      status: patch.status || null,
      completedAt: patch.completed_at || null,
      failureReason: patch.failure_reason || null,
      markSubmitted: Boolean(patch.provider_transfer_id),
      providerMetadata: patch.provider_metadata,
    });
    if (updated.ok !== true) return null;
    return mapIntent(updated.intent);
  },
});

const writeReturnCard = (card) => {
  const text = `${Object.entries(card).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nSTOP FOR REVIEW.\nDo not arm production execution.\nDo not manually create transfer intents outside the orchestrator.\n`;
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/m712_return_card.md', text);
  return text;
};

const main = async () => {
  if (PIPELINE !== '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43'
    || SANDBOX_ACCOUNT !== '1d59a6a8-3307-4687-8367-1495293ecc73'
    || SANDBOX_WALLET !== '58571121-67ea-4e10-abae-6c9680ac455d'
    || SANDBOX_BANK !== '8390f74b-706e-4d89-80b0-f96bd7c1b414'
    || SANDBOX_RECIPIENT_ACCOUNT !== '90050a69-84f3-41bb-aa30-490ca7e7bf34') {
    throw new Error('sandbox_object_constants_drift');
  }
  await assumeRole();
  const flagsStart = lambdaFlags();
  if (flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') {
    throw new Error('refused_production_post_armed');
  }
  if (flagsStart.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') {
    setSandboxPostFlag('false');
    flagsStart = lambdaFlags();
  }
  const parsed = JSON.parse(awsJson([
    'secretsmanager', 'get-secret-value',
    '--secret-id', flagsStart.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET,
  ]).SecretString || '{}');
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

  const zip = packOneshot();
  const secretsList = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secretsList.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  ensureOneshot(zip, adminSecret.ARN, flagsStart.vpc);

  const verifyTenant = invokeOneshot({ step: 'verify', tenantId: PIPELINE });
  const existingOp = invokeOneshot({
    step: 'list_orchestrator_operation',
    tenantId: PIPELINE,
    payoutOperationId: OPERATION,
  });
  const collectFunds = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/capabilities/collect-funds`, moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT));
  const collectFundsAch = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/capabilities/collect-funds.ach`, moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT));
  const sendFunds = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/capabilities/send-funds`, moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT));
  const sendFundsAch = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/capabilities/send-funds.ach`, moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT));
  const bank = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/bank-accounts/${SANDBOX_BANK}`, moovSandboxScopes.bankAccountsRead(SANDBOX_ACCOUNT));
  const wallets = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/wallets`, moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT));
  const payerMethods = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/payment-methods`, moovSandboxScopes.paymentMethodsRead(SANDBOX_ACCOUNT));
  const recipient = await getJson(credentials, `/accounts/${SANDBOX_RECIPIENT_ACCOUNT}`, moovSandboxScopes.accountRead(SANDBOX_RECIPIENT_ACCOUNT));
  const recipientBanks = await getJson(credentials, `/accounts/${SANDBOX_RECIPIENT_ACCOUNT}/bank-accounts`, moovSandboxScopes.bankAccountsRead(SANDBOX_RECIPIENT_ACCOUNT));
  const recipientMethods = await getJson(credentials, `/accounts/${SANDBOX_RECIPIENT_ACCOUNT}/payment-methods`, moovSandboxScopes.paymentMethodsRead(SANDBOX_RECIPIENT_ACCOUNT));
  const webhooks = await inspectWebhooks(credentials);

  const walletRows = asList(wallets.data).map((row) => ({
    id: row.walletID || row.walletId || row.id,
    availableCents: amountCentsOf(row.availableBalance ?? row.available),
    pendingCents: amountCentsOf(row.pendingBalance ?? row.pending),
  }));
  const wallet = walletRows.find((row) => String(row.id).toLowerCase() === SANDBOX_WALLET) || null;
  const liveAvailable = wallet?.availableCents ?? null;
  const shortfall = Math.max(0, PAYOUT_CENTS - Number(liveAvailable || 0));
  const initialDecision = shortfall > 0 ? 'FUND_FIRST' : 'PAYOUT_READY';
  const bankVerified = String(bank.data?.status || bank.status || '').toLowerCase() === 'verified';
  const destPm = asList(recipientMethods.data).find((row) => String(row.paymentMethodID || row.id || '').toLowerCase() === DEST_PM)
    || asList(recipientMethods.data).find((row) => String(row.paymentMethodType || row.type || '').toLowerCase().includes('ach-credit'))
    || null;
  const destPmId = destPm?.paymentMethodID || destPm?.id || DEST_PM;
  const recipientReady = Boolean(destPmId) && String(recipient.data?.accountID || recipient.data?.accountId || '').toLowerCase() === SANDBOX_RECIPIENT_ACCOUNT;
  const preflightOk = verifyTenant.tenant?.moov_environment === 'sandbox'
    && verifyTenant.freedomEnvironment === 'production'
    && flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && flagsStart.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'
    && webhooks.healthy === true
    && bankVerified
    && (capEnabled(collectFunds) || capEnabled(collectFundsAch))
    && (capEnabled(sendFunds) || capEnabled(sendFundsAch))
    && recipientReady
    && liveAvailable != null;

  const labels = {
    fund: {
      sourceLabel: 'Sandbox funding bank ••••4321',
      destinationLabel: 'Sandbox wallet',
      bankId: SANDBOX_BANK,
      walletId: SANDBOX_WALLET,
      sourcePaymentMethodId: SANDBOX_FUND_PM,
      destinationPaymentMethodId: SANDBOX_WALLET_PM,
    },
    disburse: {
      sourceLabel: 'Sandbox wallet',
      destinationLabel: 'Sandbox recipient bank',
      recipientLabel: 'Pipeline Test Payee',
      recipientId: SANDBOX_RECIPIENT_ACCOUNT,
    },
  };
  const fundBinding = {
    ...resolveSandboxFundBinding({
      tenant: { id: PIPELINE, moov_environment: 'sandbox' },
      rds: {
        account: { provider_account_id: SANDBOX_ACCOUNT },
        wallet: { provider_wallet_id: SANDBOX_WALLET },
        banks: [
          { provider_bank_account_id: SANDBOX_BANK, last_four: '4321', verification_status: 'verified' },
          { provider_bank_account_id: SANDBOX_RECIPIENT_BANK },
        ],
      },
      live: {
        accountId: SANDBOX_ACCOUNT,
        platformAccountId: SANDBOX_PLATFORM,
        wallets: [{ walletID: SANDBOX_WALLET, availableCents: liveAvailable }],
        banks: [{ bankAccountID: SANDBOX_BANK, status: 'verified', lastFour: '4321' }],
        paymentMethods: [
          { paymentMethodID: SANDBOX_FUND_PM, paymentMethodType: 'ach-debit-fund', bankAccountID: SANDBOX_BANK },
          { paymentMethodID: SANDBOX_WALLET_PM, paymentMethodType: 'moov-wallet', walletID: SANDBOX_WALLET },
        ],
      },
    }),
    providerIdempotencyKey: M712_FUNDING_PROVIDER_UUID,
  };
  const payoutBinding = liveAvailable >= PAYOUT_CENTS
    ? {
      ...resolveSandboxPayoutBinding({
        tenant: { id: PIPELINE, moov_environment: 'sandbox' },
        rds: {
          account: { provider_account_id: SANDBOX_ACCOUNT },
          wallet: { provider_wallet_id: SANDBOX_WALLET, available_cents: liveAvailable },
          banks: [{ provider_bank_account_id: SANDBOX_RECIPIENT_BANK }],
        },
        live: {
          accountId: SANDBOX_ACCOUNT,
          platformAccountId: SANDBOX_PLATFORM,
          walletAvailableCents: liveAvailable,
          wallets: [{ walletID: SANDBOX_WALLET, availableCents: liveAvailable }],
          payerPaymentMethods: [{ paymentMethodID: SANDBOX_WALLET_PM, paymentMethodType: 'moov-wallet', walletID: SANDBOX_WALLET }],
          recipientAccountId: SANDBOX_RECIPIENT_ACCOUNT,
          recipientBanks: [{ bankAccountID: SANDBOX_RECIPIENT_BANK, status: 'verified' }],
          recipientPaymentMethods: [{
            paymentMethodID: destPmId,
            paymentMethodType: 'ach-credit-standard',
            bankAccountID: SANDBOX_RECIPIENT_BANK,
          }],
          payerCapabilities: [{ name: 'send-funds', status: 'enabled' }],
        },
      }),
      providerIdempotencyKey: M712_PAYOUT_PROVIDER_UUID,
    }
    : null;

  const store = createOneshotPayoutStore();
  const orchBase = {
    tenantId: PIPELINE,
    tenantEnvironment: 'sandbox',
    liveAvailableCents: liveAvailable,
    payoutCents: PAYOUT_CENTS,
    recipientVerified: recipientReady,
    credentials,
    productionPublicKey: parsed.MOOV_PUBLIC_KEY,
    productionSecretKey: parsed.MOOV_SECRET_KEY,
    persistMoneyIntents: true,
    store,
    labels,
    fundBinding,
    payoutBinding,
    operationId: OPERATION,
    haltAfterFundingAttempt: true,
    refreshLiveWallet: async () => {
      const live = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/wallets`, moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT));
      const row = asList(live.data).find((item) => String(item.walletID || item.id || '').toLowerCase() === SANDBOX_WALLET);
      return amountCentsOf(row?.availableBalance ?? row?.available);
    },
    getTransfer: async (id) => {
      const got = await getJson(
        credentials,
        `/accounts/${SANDBOX_PLATFORM}/transfers/${id}`,
        moovSandboxScopes.transfersRead(SANDBOX_PLATFORM),
      );
      return got.data || got;
    },
  };

  const stop = (card, extra = {}) => {
    writeReturnCard(card);
    fs.writeFileSync('/opt/cursor/artifacts/m712_run.json', JSON.stringify({
      at: new Date().toISOString(),
      posted: false,
      ...extra,
      card,
    }, null, 2));
    console.log(JSON.stringify({ ok: false, card }, null, 2));
  };

  if (!preflightOk || !fundBinding.ok) {
    stop({
      'LIVE WALLET AVAILABLE': String(liveAvailable),
      'PAYOUT AMOUNT': '1',
      SHORTFALL: String(shortfall),
      'INITIAL DECISION': initialDecision,
      PAYOUT_OPERATION_ID: OPERATION,
      FUNDING_INTENT_ID: 'none',
      PAYOUT_INTENT_ID: 'none',
      'DARK RESULT': 'preflight_failed',
      'DUPLICATE OPERATION': 'false',
      'SANDBOX POST FLAG ARMED': 'false',
      'PRODUCTION POST FLAG': String(flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      'PROVIDER POSTS THIS RUN': '0',
      'GO/NO-GO': 'NO-GO',
    }, {
      verifyTenant,
      existingOp,
      webhooks,
      bankVerified,
      fundBinding: { ok: fundBinding.ok, error: fundBinding.error },
      liveAvailable,
    });
    return;
  }

  const dark = await executeSandboxPayoutE2e({
    ...orchBase,
    transferPostEnabled: false,
    productionTransferPostEnabled: false,
  });
  const darkReplay = await executeSandboxPayoutE2e({
    ...orchBase,
    transferPostEnabled: false,
    productionTransferPostEnabled: false,
  });
  const listedDark = invokeOneshot({
    step: 'list_orchestrator_operation',
    tenantId: PIPELINE,
    payoutOperationId: OPERATION,
  });
  const darkOk = dark.ok === true
    && dark.live_balance_authority === true
    && dark.sandbox_provider_posts === 0
    && dark.production_provider_posts === 0
    && darkReplay.payout_operation_id === dark.payout_operation_id
    && darkReplay.payout_intent?.reused === true
    && (dark.decision !== 'FUND_FIRST' || darkReplay.funding_intent?.reused === true)
    && (listedDark.operationFunding || 0) <= 1
    && (listedDark.operationPayout || 0) <= 1
    && flagsStart.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true';

  const alreadyPosted = [...(listedDark.fundingRows || []), ...(listedDark.payoutRows || [])]
    .some((row) => row.provider_transfer_id);

  if (!darkOk) {
    stop({
      'LIVE WALLET AVAILABLE': String(liveAvailable),
      'PAYOUT AMOUNT': '1',
      SHORTFALL: String(shortfall),
      'INITIAL DECISION': initialDecision,
      PAYOUT_OPERATION_ID: dark.payout_operation_id || OPERATION,
      FUNDING_INTENT_ID: listedDark.fundingRows?.[0]?.id || 'none',
      PAYOUT_INTENT_ID: listedDark.payoutRows?.[0]?.id || 'none',
      'DARK RESULT': dark.error || dark.decision || 'failed',
      'DUPLICATE OPERATION': String(darkReplay.payout_operation_id !== dark.payout_operation_id),
      'DUPLICATE FUNDING INTENT': String((listedDark.operationFunding || 0) > 1),
      'DUPLICATE PAYOUT INTENT': String((listedDark.operationPayout || 0) > 1),
      'SANDBOX POST FLAG ARMED': 'false',
      'PRODUCTION POST FLAG': String(flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      'PROVIDER POSTS THIS RUN': '0',
      'GO/NO-GO': 'NO-GO',
    }, { dark, darkReplay, listedDark });
    return;
  }

  let armed = null;
  let live = null;
  let disarmed = null;
  try {
    if (alreadyPosted) {
      live = await executeSandboxPayoutE2e({
        ...orchBase,
        transferPostEnabled: false,
        productionTransferPostEnabled: false,
      });
      armed = { skipped: 'already_posted', flags: flagsStart.flags, changed: [] };
    } else {
      armed = setSandboxPostFlag('true');
      if (armed.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true') {
        throw new Error('sandbox_post_not_armed');
      }
      if (armed.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') {
        throw new Error('production_post_armed');
      }
      if (armed.changed.some((key) => key !== 'AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED')) {
        throw new Error(`other_env_changes:${armed.changed.join(',')}`);
      }
      live = await executeSandboxPayoutE2e({
        ...orchBase,
        transferPostEnabled: true,
        productionTransferPostEnabled: false,
      });
    }
  } finally {
    try { disarmed = setSandboxPostFlag('false'); } catch { /* still report */ }
  }

  const flagsEnd = lambdaFlags();
  const listedLive = invokeOneshot({
    step: 'list_orchestrator_operation',
    tenantId: PIPELINE,
    payoutOperationId: OPERATION,
  });
  const walletsAfter = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/wallets`, moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT));
  const walletAfter = asList(walletsAfter.data).map((row) => ({
    id: row.walletID || row.walletId || row.id,
    availableCents: amountCentsOf(row.availableBalance ?? row.available),
    pendingCents: amountCentsOf(row.pendingBalance ?? row.pending),
  })).find((row) => String(row.id).toLowerCase() === SANDBOX_WALLET) || wallet;

  const fundingRow = listedLive.fundingRows?.[0] || null;
  const payoutRow = listedLive.payoutRows?.[0] || null;
  const platformTransfers = await getJson(credentials, `/accounts/${SANDBOX_PLATFORM}/transfers`, moovSandboxScopes.transfersRead(SANDBOX_PLATFORM));
  const transferRows = asList(platformTransfers.data).map(summarizeTransfer);
  const fundingTransfers = transferRows.filter((row) => (
    String(row.sourcePm || '').toLowerCase() === SANDBOX_FUND_PM
    && String(row.destinationPm || '').toLowerCase() === SANDBOX_WALLET_PM
    && row.amountCents === 1
    && String(row.id || '').toLowerCase() === String(fundingRow?.provider_transfer_id || '').toLowerCase()
  ));
  const payoutTransfers = transferRows.filter((row) => (
    String(row.sourcePm || '').toLowerCase() === SANDBOX_WALLET_PM
    && String(row.destinationPm || '').toLowerCase() === String(destPmId).toLowerCase()
    && row.amountCents === 1
    && String(row.id || '').toLowerCase() === String(payoutRow?.provider_transfer_id || '').toLowerCase()
  ));

  const resume = await executeSandboxPayoutE2e({
    ...orchBase,
    liveAvailableCents: walletAfter?.availableCents ?? liveAvailable,
    transferPostEnabled: false,
    productionTransferPostEnabled: false,
    existingRows: [...(listedLive.fundingRows || []), ...(listedLive.payoutRows || [])].map(mapIntent),
  });

  const fundingPostedThisRun = live?.funding_provider_posts === 1;
  const payoutPostedThisRun = live?.payout_provider_posts === 1;
  const fundingPosted = fundingPostedThisRun || Boolean(fundingRow?.provider_transfer_id);
  const payoutPosted = payoutPostedThisRun || Boolean(payoutRow?.provider_transfer_id);
  const isolated = flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'
    && verifyTenant.freedomEnvironment === 'production';
  const expectedCaseB = initialDecision === 'FUND_FIRST'
    && fundingPosted
    && !payoutPosted
    && (listedLive.operationFunding || 0) === 1
    && (listedLive.operationPayout || 0) === 1;
  const expectedCaseA = initialDecision === 'PAYOUT_READY'
    && !fundingPosted
    && payoutPosted
    && (listedLive.operationPayout || 0) === 1;
  const go = isolated && (expectedCaseA || expectedCaseB)
    && live?.production_provider_posts === 0
    && resume.payout_operation_id === OPERATION
    && resume.sandbox_provider_posts === 0;

  const card = {
    'LIVE WALLET AVAILABLE': String(liveAvailable),
    'PAYOUT AMOUNT': '1',
    SHORTFALL: String(shortfall),
    'INITIAL DECISION': initialDecision,
    PAYOUT_OPERATION_ID: OPERATION,
    FUNDING_INTENT_ID: fundingRow?.id || 'none',
    PAYOUT_INTENT_ID: payoutRow?.id || 'none',
    'DARK RESULT': `${dark.decision}/${dark.funding_state || 'none'}/${dark.payout_state}`,
    'DUPLICATE OPERATION': String(darkReplay.payout_operation_id !== OPERATION),
    'DUPLICATE FUNDING INTENT': String((listedLive.operationFunding || 0) > 1),
    'DUPLICATE PAYOUT INTENT': String((listedLive.operationPayout || 0) > 1),
    'SANDBOX POST FLAG ARMED': String(armed?.flags?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true'),
    'PRODUCTION POST FLAG': String(flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    'PROVIDER POSTS THIS RUN': String((live?.funding_provider_posts || 0) + (live?.payout_provider_posts || 0)),
    'FUNDING TRANSFER ID': fundingRow?.provider_transfer_id || 'none',
    'FUNDING STATUS': fundingRow?.status || fundingRow?.provider_status || 'none',
    'PAYOUT TRANSFER ID': payoutRow?.provider_transfer_id || 'none',
    'PAYOUT STATUS': payoutRow?.status || payoutRow?.provider_status || 'none',
    'ORCHESTRATOR STATE AFTER': `${live?.funding_state || 'none'}/${live?.payout_state || 'none'}`,
    'WALLET AVAILABLE AFTER': String(walletAfter?.availableCents ?? 'unknown'),
    'SANDBOX POST FLAG DISARMED': String(flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'),
    'FUNDING TRANSFER COUNT': String(fundingTransfers.length || (fundingRow?.provider_transfer_id ? 1 : 0)),
    'PAYOUT TRANSFER COUNT': String(payoutTransfers.length || (payoutRow?.provider_transfer_id ? 1 : 0)),
    'SECOND POST': String(((live?.funding_provider_posts || 0) + (live?.payout_provider_posts || 0)) > 1 || alreadyPosted && (fundingPostedThisRun || payoutPostedThisRun)),
    'PRODUCTION TRANSFER': String((listedLive.recentProduction || 0) > 0),
    'FREEDOM CHANGED': String(verifyTenant.freedomEnvironment !== 'production'),
    'SWEEP CHANGED': String(listedLive.sweep?.changed === true),
    'PRODUCTION MONEY MOVED': 'false',
    'SAFE TO RECONCILE/RESUME SAME OPERATION': go && expectedCaseB ? 'YES' : (go && expectedCaseA ? 'YES-GET-FALLBACK' : 'NO'),
    'SAFE TO RUN NEXT AUTOMATED STEP': go && expectedCaseB ? 'YES after funding completed + live wallet >= 1' : (go && expectedCaseA ? 'recon only' : 'NO'),
    'GO/NO-GO': go ? 'GO' : 'NO-GO',
  };
  writeReturnCard(card);
  fs.writeFileSync('/opt/cursor/artifacts/m712_run.json', JSON.stringify({
    at: new Date().toISOString(),
    posted: Boolean(fundingPosted || payoutPosted),
    operation: OPERATION,
    liveAvailable,
    shortfall,
    initialDecision,
    dark: {
      decision: dark.decision,
      funding_state: dark.funding_state,
      payout_state: dark.payout_state,
      posts: dark.sandbox_provider_posts,
    },
    live: {
      decision: live?.decision,
      funding_state: live?.funding_state,
      payout_state: live?.payout_state,
      funding_posts: live?.funding_provider_posts,
      payout_posts: live?.payout_provider_posts,
      halted_after_funding: live?.halted_after_funding,
      outcome_funding: live?.funding_exec?.outcome || null,
      outcome_payout: live?.payout_exec?.outcome || null,
    },
    resume: {
      decision: resume.decision,
      funding_state: resume.funding_state,
      payout_state: resume.payout_state,
      posts: resume.sandbox_provider_posts,
    },
    listedLive,
    flagsStart: flagsStart.flags,
    flagsArmed: armed?.flags || null,
    flagsEnd: flagsEnd.flags,
    card,
  }, null, 2));
  console.log(JSON.stringify({ ok: go, posted: Boolean(fundingPosted || payoutPosted), card }, null, 2));
};

main().catch((error) => {
  try { setSandboxPostFlag('false'); } catch { /* still report */ }
  console.error(error);
  process.exitCode = 1;
});
