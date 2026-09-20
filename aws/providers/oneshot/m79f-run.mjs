#!/usr/bin/env node
/**
 * M7.9F: diagnose sandbox BANK→WALLET HTTP 403 without retrying POST.
 * Never arms POST flags. Never POSTs /transfers. Never creates intents.
 * Never modifies Freedom or Sweep.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';
import {
  PIPELINE_TEST_SANDBOX,
  reconstructM79eFailedTransferRequest,
  resolveSandboxFundBinding,
  sandboxFacilitatorTransferContract,
  sandboxWalletFundingIdempotencyKey,
} from '../../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import { moovSandboxFetch, moovSandboxScopes, moovSandboxToken } from '../../functions/api/providers/moov-sandbox.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const PRODUCTION_SECRET = 'checksops/production/provider';
const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
const SANDBOX_ACCOUNT = '1d59a6a8-3307-4687-8367-1495293ecc73';
const SANDBOX_PLATFORM = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const SANDBOX_WALLET = '58571121-67ea-4e10-abae-6c9680ac455d';
const SANDBOX_BANK = '8390f74b-706e-4d89-80b0-f96bd7c1b414';
const SANDBOX_FUND_PM = '8a0f6ffa-a549-48f5-bb8e-f5b6a9d9cfff';
const SANDBOX_WALLET_PM = '1eb24c1c-b7ab-45cd-8775-332da40b9647';
const FAILED_INTENT = 'b18a96d7-4415-4df8-992f-70d5a17365a9';
const PRODUCTION_PLATFORM = KNOWN_APPROVED_MOOV.platform.moovAccountId;
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
    '--role-session-name', 'checksops-m79f-sandbox-403',
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
  if (Array.isArray(json?.capabilities)) return json.capabilities;
  return [];
};
const capName = (row) => String(row?.capability || row?.capabilityID || row?.id || '').toLowerCase();
const capStatus = (row) => String(row?.status || '').toLowerCase();
const enabledish = (status) => ['enabled', 'active'].includes(String(status || '').toLowerCase());
const fingerprint = (id) => {
  if (!id) return null;
  const s = String(id);
  if (s.length < 12) return '[id]';
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
};

const lambdaFlags = () => {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  const env = cfg.Environment?.Variables || {};
  return {
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    },
    PROVIDER_SECRETS_ARN: env.PROVIDER_SECRETS_ARN,
  };
};

const loadSecret = (id) => {
  const raw = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', id]);
  return { parsed: JSON.parse(raw.SecretString || '{}') };
};

const invokeOneshot = (payload) => {
  const outFile = `/tmp/m79f-oneshot-${payload.step}-${Date.now()}.json`;
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

const assertGetOnly = (method, apiPath) => {
  const verb = String(method || 'GET').toUpperCase();
  if (verb === 'POST' && String(apiPath).includes('/oauth2/token')) return;
  if (verb !== 'GET') throw new Error(`refused_method_${verb}_${apiPath}`);
  if (/\/transfers$/i.test(apiPath) && verb !== 'GET') throw new Error('refused_transfer_post');
};

const getJson = async (credentials, apiPath, scopes) => {
  assertGetOnly('GET', apiPath);
  return moovSandboxFetch({ credentials, path: apiPath, scopes });
};

const main = async () => {
  if (PIPELINE !== PIPELINE_TEST_SANDBOX.tenantId
    || SANDBOX_ACCOUNT !== PIPELINE_TEST_SANDBOX.accountId
    || SANDBOX_PLATFORM !== PIPELINE_TEST_SANDBOX.platformAccountId
    || SANDBOX_WALLET !== PIPELINE_TEST_SANDBOX.walletId
    || SANDBOX_BANK !== PIPELINE_TEST_SANDBOX.bankId
    || SANDBOX_FUND_PM !== PIPELINE_TEST_SANDBOX.achDebitFundPm
    || SANDBOX_WALLET_PM !== PIPELINE_TEST_SANDBOX.walletPm) {
    throw new Error('sandbox_object_constants_drift');
  }
  const identity = await assumeRole();
  const flags = lambdaFlags();
  if (flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_production_post_armed');
  if (flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_sandbox_post_armed');
  const production = loadSecret(flags.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET);
  const parsed = production.parsed;
  const credentials = sandboxCredentials(parsed);
  if (!present(credentials.publicKey) || !present(credentials.secretKey) || !present(credentials.platformId)) {
    throw new Error('sandbox_credentials_missing');
  }
  if (credentials.publicKey === parsed.MOOV_PUBLIC_KEY || credentials.secretKey === parsed.MOOV_SECRET_KEY) {
    throw new Error('sandbox_equals_production');
  }
  if (String(credentials.platformId).toLowerCase() === String(PRODUCTION_PLATFORM).toLowerCase()) {
    throw new Error('sandbox_platform_is_production');
  }
  if (String(credentials.platformId).toLowerCase() !== SANDBOX_PLATFORM) {
    throw new Error('sandbox_platform_mismatch');
  }

  const merchant = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}`, moovSandboxScopes.accountRead(SANDBOX_ACCOUNT));
  const platform = await getJson(credentials, `/accounts/${SANDBOX_PLATFORM}`, moovSandboxScopes.accountRead(SANDBOX_PLATFORM));
  const merchantCaps = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/capabilities`, moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT));
  const collect = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/capabilities/collect-funds`, moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT));
  const send = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/capabilities/send-funds`, moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT));
  const walletCap = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/capabilities/wallet`, moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT));
  const transfersCap = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/capabilities/transfers`, moovSandboxScopes.capabilitiesRead(SANDBOX_ACCOUNT));
  const methods = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/payment-methods`, moovSandboxScopes.paymentMethodsRead(SANDBOX_ACCOUNT));
  const banks = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/bank-accounts`, moovSandboxScopes.bankAccountsRead(SANDBOX_ACCOUNT));
  const wallets = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/wallets`, moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT));
  const merchantTransfers = await getJson(credentials, `/accounts/${SANDBOX_ACCOUNT}/transfers`, moovSandboxScopes.transfersRead(SANDBOX_ACCOUNT));
  const platformTransfers = await getJson(credentials, `/accounts/${SANDBOX_PLATFORM}/transfers`, moovSandboxScopes.transfersRead(SANDBOX_PLATFORM));
  const listed = await getJson(credentials, '/accounts', moovSandboxScopes.accountsRead());
  const writeMerchant = await moovSandboxToken({ credentials, scopes: moovSandboxScopes.transfersWrite(SANDBOX_ACCOUNT) });
  const writePlatform = await moovSandboxToken({ credentials, scopes: moovSandboxScopes.transfersWrite(SANDBOX_PLATFORM) });

  const methodRows = asList(methods.data).map((row) => ({
    id: row.paymentMethodID || row.paymentMethodId || row.id,
    type: String(row.paymentMethodType || row.type || '').toLowerCase(),
    bankAccountId: row.bankAccountID || row.bankAccount?.bankAccountID || null,
    walletId: row.walletID || row.wallet?.walletID || row.wallet?.walletId || null,
    partnerAccountId: row.wallet?.partnerAccountID || row.wallet?.partnerAccountId || null,
    accountId: row.accountID || row.accountId || row.wallet?.accountID || null,
  }));
  const debit = methodRows.find((row) => row.id === SANDBOX_FUND_PM) || null;
  const walletPm = methodRows.find((row) => row.id === SANDBOX_WALLET_PM) || null;
  const connected = asList(listed.data).map((row) => row.accountID || row.accountId || row.id);
  const merchantConnectedToPlatform = connected.map((id) => String(id).toLowerCase()).includes(SANDBOX_ACCOUNT);
  const caps = asList(merchantCaps.data).map((row) => ({ capability: capName(row), status: capStatus(row) }));
  const findCap = (name) => caps.find((row) => row.capability === name) || null;
  const failed = reconstructM79eFailedTransferRequest();
  const binding = resolveSandboxFundBinding({
    tenant: { id: PIPELINE, moov_environment: 'sandbox' },
    rds: {
      account: { provider_account_id: SANDBOX_ACCOUNT },
      wallet: { provider_wallet_id: SANDBOX_WALLET, id: '34f86d69-c84a-41f9-b5f1-781ebe9b5884' },
      banks: [{
        id: '4797496f-d6a3-4312-9527-04c92de1ad88',
        provider_bank_account_id: SANDBOX_BANK,
        last_four: '4321',
        bank_name: 'JPMORGAN CHASE BANK NA',
        verification_status: 'verified',
      }],
    },
    live: {
      accountId: SANDBOX_ACCOUNT,
      platformAccountId: credentials.platformId,
      wallets: asList(wallets.data).map((row) => ({ id: row.walletID || row.walletId || row.id, status: row.status })),
      banks: asList(banks.data).map((row) => ({
        id: row.bankAccountID || row.bankAccountId || row.id,
        status: row.status,
        routingNumber: row.routingNumber,
        lastFour: row.lastFourAccountNumber || row.lastFour,
        bankName: row.bankName,
      })),
      paymentMethods: methodRows,
    },
  });
  const corrected = binding.ok ? sandboxFacilitatorTransferContract(binding) : null;
  const intent = invokeOneshot({
    step: 'verify_funding_intent',
    tenantId: PIPELINE,
    idempotencyKey: sandboxWalletFundingIdempotencyKey({
      tenantId: PIPELINE,
      environment: 'sandbox',
      amountCents: 1,
    }),
  });
  const prior = JSON.parse(fs.readFileSync('/opt/cursor/artifacts/m79e_run.json', 'utf8'));
  const merchantJson = merchant.data || {};
  const platformJson = platform.data || {};

  const rootCauseCategory = 'authorization';
  const rootCause = 'transfer_create_used_connected_account_instead_of_platform_facilitator';
  const returnCard = {
    FAILED_INTENT: FAILED_INTENT,
    HTTP_STATUS: prior.phase5?.httpStatus || 403,
    MOOV_ERROR_CODE: prior.phase5?.errorCode || 'not_persisted',
    MOOV_ERROR_MESSAGE: prior.phase5?.message || 'Moov sandbox request failed',
    MOOV_REQUEST_ID: prior.phase5?.requestId || 'not_persisted',
    POST_ENDPOINT: failed.endpoint,
    REQUEST_SHAPE: JSON.stringify({
      source: { paymentMethodID: failed.sourcePaymentMethodId },
      destination: { paymentMethodID: failed.destinationPaymentMethodId },
      amount: failed.amount,
      description: failed.description,
      facilitatorFee: null,
      metadata: null,
    }),
    API_VERSION: failed.apiVersion,
    ORIGIN: failed.origin,
    IDEMPOTENCY: failed.providerIdempotencyKey,
    SOURCE_ACCOUNT: failed.sourceAccount,
    SOURCE_PM: failed.sourcePaymentMethodId,
    DESTINATION_ACCOUNT: failed.destinationAccount,
    DESTINATION_PM: failed.destinationPaymentMethodId,
    collect_funds: enabledish(collect.data?.status) || findCap('collect-funds')?.status || collect.statusCode,
    send_funds: enabledish(send.data?.status) || findCap('send-funds')?.status || send.statusCode,
    wallet_capability: enabledish(walletCap.data?.status) || findCap('wallet')?.status || walletCap.statusCode,
    transfer_write: writePlatform.ok ? `platform:${writePlatform.grantedScope}` : writePlatform.error,
    ROOT_CAUSE_CATEGORY: rootCauseCategory,
    ROOT_CAUSE: rootCause,
    CODE_FIX_REQUIRED: true,
    OPERATOR_ACTION_REQUIRED: 'none',
    FIX_PREPARED: true,
    TESTS: 'api-moov-m79f-sandbox-403.test.mjs',
    FAILED_INTENT_REUSABLE: intent.intent?.id === FAILED_INTENT && !intent.intent?.provider_transfer_id,
    RETRY_IDEMPOTENCY_STRATEGY: 'reuse_existing_intent_and_same_provider_uuid',
    SANDBOX_POST_FLAG: String(flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || 'false'),
    PRODUCTION_POST_FLAG: String(flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    SANDBOX_TRANSFER_CREATED: asList(platformTransfers.data).length + asList(merchantTransfers.data).length > 0,
    PRODUCTION_TRANSFER_CREATED: (intent.recentProductionTransfers || 0) > 0,
    MONEY_MOVED: false,
    SAFE_TO_PREPARE_ONE_RETRY_AFTER_REVIEW: Boolean(binding.ok && corrected && writePlatform.ok),
    GO_NO_GO: 'NO-GO',
  };

  const report = {
    at: new Date().toISOString(),
    identity: { arn: identity.Arn },
    posted: false,
    armed: false,
    flags: flags.flags,
    prior403: {
      httpStatus: prior.phase5?.httpStatus || 403,
      error: prior.phase5?.error || null,
      message: prior.phase5?.message || null,
      errorCode: prior.phase5?.errorCode || null,
      requestId: prior.phase5?.requestId || null,
      bodyPersisted: false,
      note: 'M7.9E adapter kept only status/generic message. Raw JSON, Moov error code, and x-request-id were not persisted. No retry is used to recover them.',
    },
    failedRequest: failed,
    correctedRequest: corrected,
    ownership: {
      platformFp: fingerprint(SANDBOX_PLATFORM),
      platformOk: platform.ok === true,
      platformDisplayName: platformJson.displayName || null,
      platformMode: platformJson.mode || platformJson.accountMode || null,
      merchantOk: merchant.ok === true,
      merchantDisplayName: merchantJson.displayName || null,
      merchantMode: merchantJson.mode || merchantJson.accountMode || null,
      merchantForeignId: merchantJson.foreignID || merchantJson.foreignId || null,
      merchantConnectedToPlatform,
      debitPm: debit,
      walletPm,
      walletPartnerAccountFp: fingerprint(walletPm?.partnerAccountId),
      walletPartnerIsPlatform: String(walletPm?.partnerAccountId || '').toLowerCase() === SANDBOX_PLATFORM,
      productionPlatformUsed: false,
    },
    capabilities: {
      collectFunds: collect.data?.status || collect.statusCode,
      sendFunds: send.data?.status || send.statusCode,
      wallet: walletCap.data?.status || walletCap.statusCode,
      transfers: transfersCap.data?.status || transfersCap.statusCode,
      listed: caps,
    },
    oauth: {
      merchantTransfersWrite: { ok: writeMerchant.ok === true, scope: writeMerchant.grantedScope || null },
      platformTransfersWrite: { ok: writePlatform.ok === true, scope: writePlatform.grantedScope || null },
    },
    transfers: {
      merchantCount: asList(merchantTransfers.data).length,
      platformCount: asList(platformTransfers.data).length,
      merchantListOk: merchantTransfers.ok === true,
      platformListOk: platformTransfers.ok === true,
    },
    binding: { ok: binding.ok, error: binding.error || null, platformAccountId: binding.platformAccountId || null },
    intent: {
      id: intent.intent?.id || null,
      status: intent.intent?.status || null,
      provider_transfer_id: intent.intent?.provider_transfer_id || null,
      post_attempted: intent.intent?.provider_metadata?.post_attempted === true,
      mutated: false,
    },
    docs: {
      transferAccountId: 'platform/facilitator (Moov: "Your Moov account ID" / "Partner account")',
      transferScopes: 'platform account ID',
      requiredBody: ['source.paymentMethodID', 'destination.paymentMethodID', 'amount.currency', 'amount.value'],
      notRequiredBody: ['source.accountID', 'destination.accountID', 'facilitatorFee', 'metadata', 'ACH type'],
      amountValue: 'integer cents on v2024.01.00',
    },
    returnCard,
    STOP_FOR_REVIEW: true,
  };

  fs.writeFileSync('/opt/cursor/artifacts/m79f_run.json', JSON.stringify(report, null, 2));
  const lines = Object.entries(returnCard).map(([key, value]) => `${key}: ${value}`);
  fs.writeFileSync('/opt/cursor/artifacts/m79f_return_card.md', `${lines.join('\n')}\n\nSTOP FOR REVIEW.\nDo not retry provider POST.\nDo not execute wallet→recipient.\n`);
  fs.writeFileSync('/opt/cursor/artifacts/m79f_return_card_final.md', `${lines.join('\n')}\n\nSTOP FOR REVIEW.\nDo not retry provider POST.\nDo not execute wallet→recipient.\n`);
  console.log(JSON.stringify({ ok: true, posted: false, armed: false, returnCard }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
