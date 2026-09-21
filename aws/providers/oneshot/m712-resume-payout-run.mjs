#!/usr/bin/env node
/**
 * M7.12 resume: exactly one sandbox Moov POST for the EXISTING planned payout.
 * Never creates an operation, funding intent, funding transfer, or payout intent.
 * Production POST stays false. Sandbox POST is armed only for the one attempt,
 * then disarmed immediately. Unknown/pending never retries.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';
import { PIPELINE_TEST_SANDBOX } from '../../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import {
  M712_PAYOUT_PROVIDER_UUID,
  executeSandboxWalletDisbursement,
  resolveSandboxPayoutBinding,
} from '../../functions/api/providers/production/moov-sandbox-wallet-disburse.mjs';
import {
  M712_FUNDING_INTENT_ID,
  M712_FUNDING_TRANSFER_ID,
  M712_OPERATION_ID,
  M712_PAYOUT_INTENT_ID,
  executeSandboxPayoutE2e,
} from '../../functions/api/providers/production/moov-sandbox-payout-e2e.mjs';
import { moovSandboxFetch, moovSandboxScopes } from '../../functions/api/providers/moov-sandbox.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const STAGING_API = 'checksops-staging-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const PRODUCTION_SECRET = 'checksops/production/provider';
const PIPELINE = PIPELINE_TEST_SANDBOX.tenantId;
const SANDBOX_ACCOUNT = PIPELINE_TEST_SANDBOX.accountId;
const SANDBOX_WALLET = PIPELINE_TEST_SANDBOX.walletId;
const SANDBOX_WALLET_PM = PIPELINE_TEST_SANDBOX.walletPm;
const SANDBOX_PLATFORM = PIPELINE_TEST_SANDBOX.platformAccountId;
const SANDBOX_RECIPIENT_ACCOUNT = PIPELINE_TEST_SANDBOX.recipientAccountId;
const SANDBOX_RECIPIENT_BANK = PIPELINE_TEST_SANDBOX.recipientBankId;
const DEST_PM = '7a5ef572-501e-4eac-8c1b-7a4794296a85';
const OPERATION = M712_OPERATION_ID;
const FUNDING_INTENT_ID = M712_FUNDING_INTENT_ID;
const PAYOUT_INTENT_ID = M712_PAYOUT_INTENT_ID;
const FUNDING_TRANSFER_ID = M712_FUNDING_TRANSFER_ID;
const PROVIDER_UUID = M712_PAYOUT_PROVIDER_UUID;
const BUSINESS_KEY = `checksops:m77:wallet_disbursement:env:sandbox:op:${OPERATION}:cents:1`;
const M710_PAYOUT = 'c2d1078a-0261-4a3b-9782-777fad834af9';
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
    '--role-session-name', 'checksops-m712-resume-payout',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
  ]).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
};

const asList = (json) => {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.wallets)) return json.wallets;
  if (Array.isArray(json?.bankAccounts)) return json.bankAccounts;
  if (Array.isArray(json?.paymentMethods)) return json.paymentMethods;
  if (Array.isArray(json?.transfers)) return json.transfers;
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
    const n = Number(amount.value ?? amount.amount ?? 0);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const sameId = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

const lambdaConfig = (name = API_FN) => awsJson(['lambda', 'get-function-configuration', '--function-name', name]);
const lambdaFlags = (cfg = lambdaConfig()) => {
  const env = cfg.Environment?.Variables || {};
  return {
    name: cfg.FunctionName || API_FN,
    codeSha256: cfg.CodeSha256,
    lastModified: cfg.LastModified,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED ?? null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED ?? null,
    },
    env,
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
  const before = lambdaConfig(API_FN);
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
  const after = lambdaConfig(API_FN);
  return {
    changed: envDiff(before.Environment?.Variables || {}, after.Environment?.Variables || {}),
    flags: lambdaFlags(after).flags,
    codeShaUnchanged: after.CodeSha256 === before.CodeSha256,
  };
};

const invokeOneshot = (payload) => {
  const outFile = `/tmp/m712-resume-oneshot-${payload.step}-${Date.now()}.json`;
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
const summarizeTransfer = (row) => ({
  id: row?.transferID || row?.transferId || row?.id || null,
  status: row?.status || null,
  amountCents: amountCentsOf(row?.amount),
  sourcePm: row?.source?.paymentMethodID || row?.source?.paymentMethodId || null,
  destinationPm: row?.destination?.paymentMethodID || row?.destination?.paymentMethodId || null,
});
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

const createExistingOnlyStore = () => ({
  inserts: [],
  async getIntent(key) {
    const got = invokeOneshot({
      step: 'get_orchestrator_intent',
      tenantId: PIPELINE,
      idempotencyKey: String(key),
      payoutOperationId: OPERATION,
    });
    const intent = mapIntent(got.intent);
    if (intent && intent.id !== FUNDING_INTENT_ID && intent.id !== PAYOUT_INTENT_ID) {
      throw new Error(`unexpected_intent:${intent.id}`);
    }
    return intent;
  },
  async putIntent() {
    throw new Error('new_intent_refused');
  },
  async updateIntent(key, patch = {}) {
    if (String(key) !== BUSINESS_KEY && String(key) !== `checksops:m77:wallet_funding:env:sandbox:op:${OPERATION}:cents:1`) {
      throw new Error(`unexpected_update_key:${key}`);
    }
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

const writeArtifacts = (card, extra) => {
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  const text = `${Object.entries(card).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nSTOP FOR REVIEW.\nDo not make another provider POST even if the transfer remains pending.\n`;
  fs.writeFileSync('/opt/cursor/artifacts/m712_resume_payout_card.md', text);
  fs.writeFileSync('/opt/cursor/artifacts/m712_resume_payout_run.json', JSON.stringify({
    at: new Date().toISOString(),
    ...extra,
    card,
  }, null, 2) + '\n');
  return text;
};

const main = async () => {
  if (PIPELINE !== '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43'
    || SANDBOX_ACCOUNT !== '1d59a6a8-3307-4687-8367-1495293ecc73'
    || SANDBOX_WALLET !== '58571121-67ea-4e10-abae-6c9680ac455d'
    || SANDBOX_RECIPIENT_ACCOUNT !== '90050a69-84f3-41bb-aa30-490ca7e7bf34'
    || PROVIDER_UUID !== '4a0bf7c1-d022-4b77-972b-fdb241bfe757'
    || OPERATION !== '69704e23-9ddd-52f8-a2b1-d48bdb500926'
    || PAYOUT_INTENT_ID !== 'df6e3d55-ccc9-43cd-b275-8cde8e24c343') {
    throw new Error('sandbox_object_constants_drift');
  }

  await assumeRole();
  const flagsStart = lambdaFlags();
  const stagingFlags = lambdaFlags(lambdaConfig(STAGING_API));
  if (flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true'
    || stagingFlags.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') {
    throw new Error('refused_production_post_armed');
  }
  if (flagsStart.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') {
    setSandboxPostFlag('false');
  }

  const parsed = JSON.parse(awsJson([
    'secretsmanager', 'get-secret-value',
    '--secret-id', flagsStart.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET,
  ]).SecretString || '{}');
  const credentials = sandboxCredentials(parsed);
  if (!credentials.publicKey || !credentials.secretKey || !credentials.platformId) {
    throw new Error('sandbox_credentials_missing');
  }
  if (credentials.publicKey === parsed.MOOV_PUBLIC_KEY || credentials.secretKey === parsed.MOOV_SECRET_KEY) {
    throw new Error('sandbox_equals_production');
  }
  if (!sameId(credentials.platformId, SANDBOX_PLATFORM)) {
    throw new Error('sandbox_platform_mismatch');
  }

  const listedBefore = invokeOneshot({
    step: 'list_orchestrator_operation',
    tenantId: PIPELINE,
    payoutOperationId: OPERATION,
  });
  const verifyBefore = invokeOneshot({ step: 'verify', tenantId: PIPELINE });
  const payoutBefore = (listedBefore.payoutRows || []).find((row) => sameId(row.id, PAYOUT_INTENT_ID)) || null;
  const fundingBefore = (listedBefore.fundingRows || []).find((row) => sameId(row.id, FUNDING_INTENT_ID)) || null;

  const walletGet = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/wallets/${SANDBOX_WALLET}`, moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT));
  const transfersGet = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/transfers`, moovSandboxScopes.transfersRead(SANDBOX_ACCOUNT));
  const recipientGet = await getJson(credentials, `/accounts/${SANDBOX_RECIPIENT_ACCOUNT}`, moovSandboxScopes.accountRead(SANDBOX_RECIPIENT_ACCOUNT));
  const recipientBanksGet = await getJson(credentials, `/accounts/${SANDBOX_RECIPIENT_ACCOUNT}/bank-accounts`, moovSandboxScopes.bankAccountsRead(SANDBOX_RECIPIENT_ACCOUNT));
  const recipientMethodsGet = await getJson(credentials, `/accounts/${SANDBOX_RECIPIENT_ACCOUNT}/payment-methods`, moovSandboxScopes.paymentMethodsRead(SANDBOX_RECIPIENT_ACCOUNT));
  const payerMethodsGet = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/payment-methods`, moovSandboxScopes.paymentMethodsRead(SANDBOX_ACCOUNT));
  const accountGet = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}`, moovSandboxScopes.accountRead(SANDBOX_ACCOUNT));
  const liveCapabilities = asList(accountGet.data?.capabilities || accountGet.data);

  const liveAvailable = amountCentsOf(walletGet.data?.availableBalance ?? walletGet.data?.available);
  const livePending = amountCentsOf(walletGet.data?.pendingBalance ?? walletGet.data?.pending);
  const destPm = asList(recipientMethodsGet.data).find((row) => sameId(row.paymentMethodID || row.id, DEST_PM)) || null;
  const recBank = asList(recipientBanksGet.data).find((row) => sameId(row.bankAccountID || row.id, SANDBOX_RECIPIENT_BANK)) || null;
  const existingPayouts = asList(transfersGet.data).map(summarizeTransfer).filter((row) => (
    row.amountCents === 1
    && sameId(row.sourcePm, SANDBOX_WALLET_PM)
    && sameId(row.destinationPm, DEST_PM)
    && !sameId(row.id, M710_PAYOUT)
    && !sameId(row.id, FUNDING_TRANSFER_ID)
  ));
  const storedProviderKey = payoutBefore?.provider_metadata?.provider_idempotency_key || null;
  const recipientReady = Boolean(destPm)
    && (recipientGet.ok === true || recipientGet.statusCode === 200)
    && String(recBank?.status || '').toLowerCase() === 'verified';
  const prePostProviderTransferId = payoutBefore?.provider_transfer_id || null;
  const duplicateCheck = existingPayouts.length === 0 && !prePostProviderTransferId ? 'clear' : 'duplicate_or_already_posted';

  const stopWithoutPost = (reason, extra = {}) => {
    const flagsNow = lambdaFlags();
    const card = {
      OPERATION,
      'PAYOUT INTENT': PAYOUT_INTENT_ID,
      'PRE-POST LIVE AVAILABLE': `$${(liveAvailable / 100).toFixed(2)}`,
      'PRE-POST PROVIDER_TRANSFER_ID': String(prePostProviderTransferId || 'none'),
      'PRE-POST DUPLICATE CHECK': duplicateCheck,
      'SANDBOX FLAG ARMED': 'false',
      'PRODUCTION FLAG': String(flagsNow.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      'PROVIDER POST COUNT': '0',
      'HTTP RESULT': `STOPPED:${reason}`,
      'MOOV REQUEST ID': 'none',
      'MOOV TRANSFER ID': 'none',
      'MOOV STATUS': 'none',
      'RDS PAYOUT STATUS': payoutBefore?.status || 'unknown',
      'RDS PROVIDER_TRANSFER_ID': String(prePostProviderTransferId || 'none'),
      'POST-ATTEMPT LIVE AVAILABLE': `$${(liveAvailable / 100).toFixed(2)}`,
      'POST-ATTEMPT LIVE PENDING': `$${(livePending / 100).toFixed(2)}`,
      'SANDBOX FLAG DISARMED': String(flagsNow.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'),
      'PRODUCTION FLAG FINAL': String(flagsNow.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
      'NEW OPERATIONS': '0',
      'NEW FUNDING INTENTS': '0',
      'NEW FUNDING TRANSFERS': '0',
      'NEW PAYOUT INTENTS': '0',
      'SWEEP CHANGED': 'NO',
      'PRODUCTION MONEY MOVED': 'NO',
      'NEXT ACTION': 'GET/WEBHOOK RECONCILIATION ONLY',
    };
    writeArtifacts(card, { reason, posted: false, extra, listedBefore, flagsStart: flagsStart.flags });
    console.log(JSON.stringify({ ok: false, reason, card }, null, 2));
  };

  const conditions = {
    sameOperation: listedBefore.operationId === OPERATION,
    samePayoutIntent: sameId(payoutBefore?.id, PAYOUT_INTENT_ID),
    payoutStillPlanned: String(payoutBefore?.status || '') === 'planned' && !prePostProviderTransferId,
    fundingCompleted: sameId(fundingBefore?.id, FUNDING_INTENT_ID)
      && String(fundingBefore?.status || '') === 'completed'
      && sameId(fundingBefore?.provider_transfer_id, FUNDING_TRANSFER_ID),
    liveAvailableOk: liveAvailable >= PAYOUT_CENTS,
    recipientReady,
    noExistingProviderPayout: existingPayouts.length === 0,
    productionPostFalse: flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
      && stagingFlags.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true',
    sandboxCurrentlyFalse: lambdaFlags().flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true',
    providerUuidMatch: sameId(storedProviderKey, PROVIDER_UUID),
    businessKeyMatch: payoutBefore?.idempotency_key === BUSINESS_KEY,
    tenantSandbox: verifyBefore.tenant?.moov_environment === 'sandbox',
    freedomProduction: verifyBefore.freedomEnvironment === 'production',
    oneFundingOnePayout: (listedBefore.operationFunding || 0) === 1 && (listedBefore.operationPayout || 0) === 1,
  };
  if (Object.values(conditions).some((value) => value !== true)) {
    stopWithoutPost('pre_post_condition_changed', { conditions });
    return;
  }

  const payoutBinding = {
    ...resolveSandboxPayoutBinding({
      tenant: { id: PIPELINE, moov_environment: 'sandbox' },
      rds: {
        account: { provider_account_id: SANDBOX_ACCOUNT },
        wallet: { provider_wallet_id: SANDBOX_WALLET, available_cents: liveAvailable },
        banks: [{ provider_bank_account_id: SANDBOX_RECIPIENT_BANK, verification_status: recBank?.status }],
      },
      live: {
        accountId: SANDBOX_ACCOUNT,
        platformAccountId: SANDBOX_PLATFORM,
        walletAvailableCents: liveAvailable,
        wallets: [{ walletID: SANDBOX_WALLET, availableCents: liveAvailable }],
        payerPaymentMethods: asList(payerMethodsGet.data),
        recipientAccountId: SANDBOX_RECIPIENT_ACCOUNT,
        recipientBanks: asList(recipientBanksGet.data),
        recipientPaymentMethods: asList(recipientMethodsGet.data),
        payerCapabilities: liveCapabilities,
      },
    }),
    providerIdempotencyKey: PROVIDER_UUID,
  };
  if (payoutBinding.ok !== true) {
    stopWithoutPost(payoutBinding.error || 'payout_binding_failed', { payoutBinding });
    return;
  }

  const transferPosts = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    const pathOnly = String(url || '').split('?')[0];
    const isTransferPost = method === 'POST' && /\/transfers\/?$/.test(pathOnly);
    if (isTransferPost) {
      if (transferPosts.length >= 1) {
        throw new Error('second_provider_post_refused');
      }
      transferPosts.push({ at: new Date().toISOString(), url: pathOnly });
    }
    const res = await fetch(url, opts);
    if (isTransferPost) {
      transferPosts[0].httpStatus = res.status;
      transferPosts[0].requestId = res.headers?.get?.('x-request-id') || res.headers?.get?.('X-Request-Id') || null;
    }
    return res;
  };

  const store = createExistingOnlyStore();
  const existingRows = [...(listedBefore.fundingRows || []), ...(listedBefore.payoutRows || [])].map(mapIntent);
  const labels = {
    disburse: {
      sourceLabel: 'Sandbox wallet',
      destinationLabel: 'Sandbox recipient bank',
      recipientLabel: 'Pipeline Test Payee',
      recipientId: SANDBOX_RECIPIENT_ACCOUNT,
    },
  };

  let armed = null;
  let live = null;
  let disarmed = null;
  let executeError = null;
  try {
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
      tenantId: PIPELINE,
      tenantEnvironment: 'sandbox',
      liveAvailableCents: liveAvailable,
      rdsAvailableCents: Number(verifyBefore.sandbox?.wallet?.available_cents || liveAvailable),
      payoutCents: PAYOUT_CENTS,
      recipientVerified: true,
      credentials,
      productionPublicKey: parsed.MOOV_PUBLIC_KEY,
      productionSecretKey: parsed.MOOV_SECRET_KEY,
      transferPostEnabled: true,
      productionTransferPostEnabled: false,
      persistMoneyIntents: true,
      store,
      existingRows,
      labels,
      payoutBinding,
      operationId: OPERATION,
      haltAfterFundingAttempt: false,
      fetchImpl,
      executeFunding: async () => {
        throw new Error('second_fund_forbidden');
      },
      executePayout: async (args) => {
        const key = args?.intent?.provider_idempotency_key
          || args?.intent?.provider_metadata?.provider_idempotency_key
          || args?.binding?.providerIdempotencyKey;
        if (!sameId(key, PROVIDER_UUID)) {
          throw new Error(`provider_uuid_mismatch:${key}`);
        }
        if (!sameId(args?.intent?.id || args?.intent?.idempotency_key, PAYOUT_INTENT_ID)
          && args?.intent?.idempotency_key !== BUSINESS_KEY) {
          throw new Error('not_existing_payout_intent');
        }
        return executeSandboxWalletDisbursement(args);
      },
      refreshLiveWallet: async () => {
        const liveWallet = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/wallets/${SANDBOX_WALLET}`, moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT));
        return amountCentsOf(liveWallet.data?.availableBalance ?? liveWallet.data?.available);
      },
      getTransfer: async (id) => {
        const got = await getJson(
          credentials,
          `/accounts/${SANDBOX_PLATFORM}/transfers/${id}`,
          moovSandboxScopes.transfersRead(SANDBOX_PLATFORM),
        );
        return got.data || got;
      },
    });
  } catch (error) {
    executeError = String(error?.message || error);
  } finally {
    try { disarmed = setSandboxPostFlag('false'); } catch (error) {
      disarmed = { error: String(error?.message || error) };
    }
  }

  const flagsEnd = lambdaFlags();
  const stagingEnd = lambdaFlags(lambdaConfig(STAGING_API));
  const listedAfter = invokeOneshot({
    step: 'list_orchestrator_operation',
    tenantId: PIPELINE,
    payoutOperationId: OPERATION,
  });
  const verifyAfter = invokeOneshot({ step: 'verify', tenantId: PIPELINE });
  const payoutAfter = (listedAfter.payoutRows || []).find((row) => sameId(row.id, PAYOUT_INTENT_ID)) || null;
  const fundingAfter = (listedAfter.fundingRows || []).find((row) => sameId(row.id, FUNDING_INTENT_ID)) || null;
  const walletAfter = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/wallets/${SANDBOX_WALLET}`, moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT));
  const afterAvailable = amountCentsOf(walletAfter.data?.availableBalance ?? walletAfter.data?.available);
  const afterPending = amountCentsOf(walletAfter.data?.pendingBalance ?? walletAfter.data?.pending);

  const payoutExec = live?.payout_exec || null;
  const httpResult = payoutExec?.httpStatus
    || transferPosts[0]?.httpStatus
    || (executeError ? `ERROR:${executeError}` : (payoutExec?.outcome || live?.error || 'none'));
  const moovRequestId = payoutExec?.requestId || transferPosts[0]?.requestId || 'none';
  const moovTransferId = payoutExec?.provider_transfer_id || payoutAfter?.provider_transfer_id || 'none';
  const moovStatus = payoutExec?.provider_status || payoutAfter?.provider_status || payoutExec?.outcome || 'none';
  const newOps = listedAfter.operationId === OPERATION ? 0 : 1;
  const newFundingIntents = Math.max(0, (listedAfter.operationFunding || 0) - (listedBefore.operationFunding || 0));
  const newPayoutIntents = Math.max(0, (listedAfter.operationPayout || 0) - (listedBefore.operationPayout || 0));
  const newFundingTransfers = sameId(fundingAfter?.provider_transfer_id, FUNDING_TRANSFER_ID) ? 0 : 1;
  const sweepChanged = Boolean(
    verifyBefore.sweep && verifyAfter.sweep
    && (String(verifyBefore.sweep.id) !== String(verifyAfter.sweep.id)
      || String(verifyBefore.sweep.status) !== String(verifyAfter.sweep.status)),
  );
  const productionMoved = (listedAfter.recentProduction || 0) > 0
    || (listedAfter.recentFreedom || 0) > 0
    || verifyAfter.freedomEnvironment !== 'production'
    || flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true'
    || stagingEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true';

  const card = {
    OPERATION,
    'PAYOUT INTENT': PAYOUT_INTENT_ID,
    'PRE-POST LIVE AVAILABLE': `$${(liveAvailable / 100).toFixed(2)}`,
    'PRE-POST PROVIDER_TRANSFER_ID': String(prePostProviderTransferId || 'none'),
    'PRE-POST DUPLICATE CHECK': duplicateCheck,
    'SANDBOX FLAG ARMED': String(armed?.flags?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true'),
    'PRODUCTION FLAG': String(armed?.flags?.AWS_MOOV_TRANSFER_POST_ENABLED || flagsStart.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    'PROVIDER POST COUNT': String(transferPosts.length || live?.payout_provider_posts || 0),
    'HTTP RESULT': String(httpResult),
    'MOOV REQUEST ID': String(moovRequestId || 'none'),
    'MOOV TRANSFER ID': String(moovTransferId || 'none'),
    'MOOV STATUS': String(moovStatus || 'none'),
    'RDS PAYOUT STATUS': payoutAfter?.status || 'unknown',
    'RDS PROVIDER_TRANSFER_ID': String(payoutAfter?.provider_transfer_id || 'none'),
    'POST-ATTEMPT LIVE AVAILABLE': `$${(afterAvailable / 100).toFixed(2)}`,
    'POST-ATTEMPT LIVE PENDING': `$${(afterPending / 100).toFixed(2)}`,
    'SANDBOX FLAG DISARMED': String(flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'),
    'PRODUCTION FLAG FINAL': String(flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    'NEW OPERATIONS': String(newOps),
    'NEW FUNDING INTENTS': String(newFundingIntents),
    'NEW FUNDING TRANSFERS': String(newFundingTransfers),
    'NEW PAYOUT INTENTS': String(newPayoutIntents),
    'SWEEP CHANGED': sweepChanged ? 'YES' : 'NO',
    'PRODUCTION MONEY MOVED': productionMoved ? 'YES' : 'NO',
    'NEXT ACTION': 'GET/WEBHOOK RECONCILIATION ONLY',
  };
  writeArtifacts(card, {
    posted: transferPosts.length > 0 || live?.payout_provider_posts === 1,
    conditions,
    payoutBinding: { ok: payoutBinding.ok, destinationPaymentMethodId: payoutBinding.destinationPaymentMethodId },
    transferPosts,
    executeError,
    live: live && {
      ok: live.ok,
      decision: live.decision,
      funding_state: live.funding_state,
      payout_state: live.payout_state,
      payout_provider_posts: live.payout_provider_posts,
      funding_provider_posts: live.funding_provider_posts,
      payout_exec: payoutExec,
      blocked_reasons: live.blocked_reasons,
      unknown_no_retry: live.unknown_no_retry,
    },
    listedAfter,
    flagsStart: flagsStart.flags,
    flagsArmed: armed?.flags || null,
    flagsEnd: flagsEnd.flags,
    stagingEnd: stagingEnd.flags,
    verifyAfter: {
      freedomEnvironment: verifyAfter.freedomEnvironment,
      tenantEnvironment: verifyAfter.tenant?.moov_environment,
    },
  });
  console.log(JSON.stringify({ ok: true, card, executeError, transferPosts }, null, 2));
};

main().catch((error) => {
  try { setSandboxPostFlag('false'); } catch { /* still fail */ }
  console.error(String(error?.stderr || error?.stack || error));
  process.exit(1);
});
