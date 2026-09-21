#!/usr/bin/env node
/**
 * M7.10A: GET-only reconcile of the existing sandbox WALLET→RECIPIENT payout.
 * Never POSTs /transfers. Never creates an intent. Never arms POST flags.
 * Never creates funding. Never overlays the API. Never updates Freedom or Sweep.
 * Pending: STOP and report. Failed/returned: update the existing payout intent only.
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
  SANDBOX_PAYOUT_AMOUNT_CENTS,
  sandboxWalletDisbursementIdempotencyKey,
} from '../../functions/api/providers/production/moov-sandbox-wallet-disburse.mjs';
import { normalizeMoovStatus } from '../../functions/api/providers/moov-lifecycle.mjs';
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
const SANDBOX_DEST_PM = '7a5ef572-501e-4eac-8c1b-7a4794296a85';
const PAYOUT_INTENT_ID = '80f4648b-551c-4ec6-a9fc-921b85bc8320';
const PAYOUT_TRANSFER_ID = 'c2d1078a-0261-4a3b-9782-777fad834af9';
const FUNDING_INTENT_ID = 'b18a96d7-4415-4df8-992f-70d5a17365a9';
const FUNDING_TRANSFER_ID = 'dec24b01-e559-4014-b072-af1ac0e4d013';
const LIVE_ORIGIN = PRODUCTION_MOOV_ORIGIN;
const PROVEN_API_VERSION = PRODUCTION_MOOV_API_VERSION;
const PENDING = new Set(['pending', 'processing', 'queued', 'originated', 'submitted', 'created']);
const FAILED = new Set(['failed', 'returned', 'canceled', 'cancelled']);

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
    '--role-session-name', 'checksops-m710a-sandbox-payout-recon',
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
const summarizeTransfer = (row) => ({
  id: row?.transferID || row?.transferId || row?.id || null,
  status: row?.status || null,
  amountCents: amountCentsOf(row?.amount),
  sourcePm: row?.source?.paymentMethodID || row?.source?.paymentMethodId || null,
  destinationPm: row?.destination?.paymentMethodID || row?.destination?.paymentMethodId || null,
  completedOn: row?.completedOn || row?.completedAt
    || row?.destination?.achDetails?.completedOn
    || row?.source?.achDetails?.completedOn
    || null,
  originatedOn: row?.destination?.achDetails?.originatedOn
    || row?.source?.achDetails?.originatedOn
    || row?.originatedOn
    || null,
  achStatus: row?.destination?.achDetails?.status || row?.source?.achDetails?.status || null,
});
const matchingPayout = (rows) => {
  const matched = (rows || []).filter((row) => (
    row.amountCents === SANDBOX_PAYOUT_AMOUNT_CENTS
    && String(row.sourcePm || '').toLowerCase() === SANDBOX_WALLET_PM
    && String(row.destinationPm || '').toLowerCase() === SANDBOX_DEST_PM
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
const snapshotOf = (intent) => intent ? {
  id: intent.id,
  status: intent.status,
  provider_status: intent.provider_status,
  provider_transfer_id: intent.provider_transfer_id,
  completed_at: intent.completed_at || intent.completed_at_utc || null,
  failure_reason: intent.failure_reason ?? null,
  environment: intent.environment || null,
  leg_role: intent.leg_role || null,
} : null;
const fundingSame = (before, after) => Boolean(
  before
  && after
  && String(before.id) === String(after.id)
  && String(before.status) === String(after.status)
  && String(before.provider_status) === String(after.provider_status)
  && String(before.provider_transfer_id || '') === String(after.provider_transfer_id || '')
  && String(before.completed_at || '') === String(after.completed_at || '')
  && String(before.failure_reason || '') === String(after.failure_reason || '')
);

const lambdaConfig = () => awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
const lambdaFlags = (cfg = lambdaConfig()) => {
  const env = cfg.Environment?.Variables || {};
  return {
    codeSha256: cfg.CodeSha256 || null,
    lastModified: cfg.LastModified || null,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
      AWS_PROVIDER_WEBHOOK_DRY_RUN: env.AWS_PROVIDER_WEBHOOK_DRY_RUN || null,
      AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED || null,
      AWS_PROVIDER_EXECUTION_ENABLED: env.AWS_PROVIDER_EXECUTION_ENABLED || null,
    },
    envKeyCount: Object.keys(env).length,
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
const packOneshot = () => {
  const staging = path.join(os.tmpdir(), 'checksops-m710a-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/77_moov_tenant_environment.sql'), path.join(staging, '77_moov_tenant_environment.sql'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/78_moov_recon_parity.sql'), path.join(staging, '78_moov_recon_parity.sql'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m710a-oneshot.zip');
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
  const outFile = `/tmp/m710a-oneshot-${payload.step}-${Date.now()}.json`;
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
const writeReturnCard = (card) => {
  const order = [
    'MOOV PAYOUT STATUS',
    'ORIGINATED_ON',
    'COMPLETED_ON',
    'PAYOUT INTENT STATUS',
    'PROVIDER STATUS',
    'PROVIDER REFERENCE',
    'COMPLETED_AT',
    'FAILURE_REASON',
    'WEBHOOK RECEIPT',
    'WEBHOOK APPLIED',
    'WALLET AVAILABLE',
    'WALLET PENDING',
    'PAYOUT TRANSFER COUNT',
    'PAYOUT INTENT COUNT',
    'SECOND POST',
    'DUPLICATE PAYOUT',
    'FUNDING TRANSFER UNCHANGED',
    'SANDBOX POST FLAG',
    'PRODUCTION POST FLAG',
    'FREEDOM CHANGED',
    'SWEEP CHANGED',
    'PRODUCTION MONEY MOVED',
    'PAYOUT FULLY RECONCILED',
    'SANDBOX BANK→WALLET→RECIPIENT LOOP PROVEN',
    'SAFE TO BEGIN REPEATED SANDBOX END-TO-END TESTING',
    'GO/NO-GO',
  ];
  const lines = order.filter((key) => card[key] !== undefined).map((key) => `${key}: ${card[key]}`);
  const extra = Object.entries(card).filter(([key]) => !order.includes(key)).map(([key, value]) => `${key}: ${value}`);
  const text = `${[...lines, ...extra].join('\n')}\n\nSTOP FOR REVIEW.\nDo not POST anything.\nDo not arm either execution flag.\n`;
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/m710a_return_card.md', text);
  fs.writeFileSync('/opt/cursor/artifacts/m710a_return_card_final.md', text);
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
  const flagsBefore = lambdaFlags();
  if (flagsBefore.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_production_post_armed');
  if (flagsBefore.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_sandbox_post_armed');
  const production = loadSecret(flagsBefore.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET);
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
  ensureOneshot(zip, adminSecret.ARN, flagsBefore.vpc);

  const businessKey = sandboxWalletDisbursementIdempotencyKey({
    tenantId: PIPELINE,
    environment: 'sandbox',
    amountCents: 1,
  });
  const verifyBefore = invokeOneshot({
    step: 'verify_payout_intent',
    tenantId: PIPELINE,
    idempotencyKey: businessKey,
  });
  const diagnosePayoutBefore = invokeOneshot({
    step: 'diagnose_funding_reconcile',
    tenantId: PIPELINE,
    transferId: PAYOUT_TRANSFER_ID,
    intentId: PAYOUT_INTENT_ID,
  });
  const diagnoseFundingBefore = invokeOneshot({
    step: 'diagnose_funding_reconcile',
    tenantId: PIPELINE,
    transferId: FUNDING_TRANSFER_ID,
    intentId: FUNDING_INTENT_ID,
  });
  const receiptsBefore = invokeOneshot({
    step: 'webhook_receipts',
    eventIds: [PAYOUT_TRANSFER_ID, PAYOUT_INTENT_ID],
  });

  const liveTransfer = await getJson(
    credentials,
    `/accounts/${SANDBOX_PLATFORM}/transfers/${PAYOUT_TRANSFER_ID}`,
    moovSandboxScopes.transfersRead(SANDBOX_PLATFORM),
  );
  const liveWallet = await getJson(
    credentials,
    `/accounts/${SANDBOX_ACCOUNT}/wallets/${SANDBOX_WALLET}`,
    moovSandboxScopes.walletsRead(SANDBOX_ACCOUNT),
  );
  const merchantTransfers = await getJson(
    credentials,
    `/accounts/${SANDBOX_ACCOUNT}/transfers`,
    moovSandboxScopes.transfersRead(SANDBOX_ACCOUNT),
  );
  const platformTransfers = await getJson(
    credentials,
    `/accounts/${SANDBOX_PLATFORM}/transfers`,
    moovSandboxScopes.transfersRead(SANDBOX_PLATFORM),
  );

  const transferJson = liveTransfer.data || {};
  const transfer = summarizeTransfer(transferJson);
  const payouts = matchingPayout([
    ...asList(merchantTransfers.data).map(summarizeTransfer),
    ...asList(platformTransfers.data).map(summarizeTransfer),
    transfer,
  ]);
  const fundingRows = matchingFunding([
    ...asList(merchantTransfers.data).map(summarizeTransfer),
    ...asList(platformTransfers.data).map(summarizeTransfer),
  ]);
  const walletJson = liveWallet.data || {};
  const walletAvailable = amountCentsOf(walletJson.availableBalance ?? walletJson.available);
  const walletPending = amountCentsOf(walletJson.pendingBalance ?? walletJson.pending);
  const moovStatus = normalizeMoovStatus(transfer.status || transferJson.status);
  const moovCompletedAt = transfer.completedOn || null;
  const moovOriginatedAt = transfer.originatedOn || null;
  if (String(transfer.id || '').toLowerCase() !== PAYOUT_TRANSFER_ID) throw new Error('unexpected_transfer_id');
  if (transfer.amountCents !== 1) throw new Error('unexpected_amount');
  if (String(transfer.sourcePm || '').toLowerCase() !== SANDBOX_WALLET_PM) throw new Error('unexpected_source_pm');
  if (String(transfer.destinationPm || '').toLowerCase() !== SANDBOX_DEST_PM) throw new Error('unexpected_destination_pm');

  const uniquePayout = payouts.length === 1 && String(payouts[0]?.id || '').toLowerCase() === PAYOUT_TRANSFER_ID;
  const uniqueFunding = fundingRows.length === 1 && String(fundingRows[0]?.id || '').toLowerCase() === FUNDING_TRANSFER_ID;
  const fundingBefore = snapshotOf(diagnoseFundingBefore.intent);
  const payoutIntentBefore = diagnosePayoutBefore.intent || verifyBefore.intent || null;

  let recon = {
    ok: true,
    skipped: PENDING.has(moovStatus) ? 'pending' : null,
    createdPaymentTransfer: false,
    liveProviderPosted: false,
    fundingUnchanged: true,
  };
  if (moovStatus === 'completed') {
    if (!moovCompletedAt) throw new Error('provider_completed_on_missing');
    recon = invokeOneshot({
      step: 'reconcile_payout_parity',
      tenantId: PIPELINE,
      intentId: PAYOUT_INTENT_ID,
      providerTransferId: PAYOUT_TRANSFER_ID,
      providerWalletId: SANDBOX_WALLET,
      providerStatus: transfer.status || 'completed',
      completedAt: moovCompletedAt,
      availableCents: walletAvailable,
      pendingCents: walletPending,
    });
    if (recon?.ok !== true) throw new Error(`payout_recon_failed:${recon?.error || 'unknown'}`);
  } else if (FAILED.has(moovStatus)) {
    recon = invokeOneshot({
      step: 'reconcile_payout_parity',
      tenantId: PIPELINE,
      intentId: PAYOUT_INTENT_ID,
      providerTransferId: PAYOUT_TRANSFER_ID,
      providerWalletId: SANDBOX_WALLET,
      providerStatus: transfer.status || moovStatus,
      failureReason: transferJson.failureReason || transfer.achStatus || moovStatus,
      availableCents: walletAvailable,
      pendingCents: walletPending,
    });
    if (recon?.ok !== true) throw new Error(`payout_fail_update_failed:${recon?.error || 'unknown'}`);
  }

  const verifyAfter = invokeOneshot({
    step: 'verify_payout_intent',
    tenantId: PIPELINE,
    idempotencyKey: businessKey,
  });
  const diagnosePayoutAfter = invokeOneshot({
    step: 'diagnose_funding_reconcile',
    tenantId: PIPELINE,
    transferId: PAYOUT_TRANSFER_ID,
    intentId: PAYOUT_INTENT_ID,
  });
  const diagnoseFundingAfter = invokeOneshot({
    step: 'diagnose_funding_reconcile',
    tenantId: PIPELINE,
    transferId: FUNDING_TRANSFER_ID,
    intentId: FUNDING_INTENT_ID,
  });
  const receiptsAfter = invokeOneshot({
    step: 'webhook_receipts',
    eventIds: [PAYOUT_TRANSFER_ID, PAYOUT_INTENT_ID],
  });
  const flagsEnd = lambdaFlags();
  const intent = diagnosePayoutAfter.intent || verifyAfter.intent || recon.intent || payoutIntentBefore;
  const rdsWallet = diagnosePayoutAfter.rdsWallet || recon.rdsWallet || verifyAfter.sandbox?.wallet || null;
  const fundingAfter = snapshotOf(diagnoseFundingAfter.intent);
  const fundingUnchanged = fundingSame(fundingBefore, fundingAfter)
    && uniqueFunding
    && String(fundingAfter?.id || '').toLowerCase() === FUNDING_INTENT_ID
    && String(fundingAfter?.provider_transfer_id || '').toLowerCase() === FUNDING_TRANSFER_ID
    && String(fundingAfter?.status || '').toLowerCase() === 'completed';
  const receipts = [...(receiptsAfter.rows || []), ...(receiptsBefore.rows || []), ...(diagnosePayoutAfter.transferIdReceipts || [])];
  const receipt = receipts[0] || null;
  const appliedEvent = (diagnosePayoutAfter.events || []).find((row) => (
    String(row.provider_transfer_id || '').toLowerCase() === PAYOUT_TRANSFER_ID
    && ['completed', 'failed', 'returned', 'canceled'].includes(String(row.new_status || '').toLowerCase())
  ));
  const webhookApplied = Boolean(receipt && receipt.dry_run === false && appliedEvent)
    || (moovStatus === 'completed' && recon.skipped == null && String(intent?.status || '').toLowerCase() === 'completed' && appliedEvent);
  const isolated = intent?.id === PAYOUT_INTENT_ID
    && intent?.environment === 'sandbox'
    && String(intent?.provider_transfer_id || '').toLowerCase() === PAYOUT_TRANSFER_ID
    && String(intent?.leg_role || verifyAfter.intent?.leg_role || '') === 'wallet_disbursement'
    && verifyAfter.payoutIntentCount === 1
    && verifyAfter.freedomEnvironment === 'production'
    && (verifyAfter.recentProductionTransfers || 0) === 0;
  const sweepChanged = Boolean(verifyBefore.sweep && (diagnosePayoutAfter.sweep || verifyAfter.sweep)
    && (String(verifyBefore.sweep.id) !== String((diagnosePayoutAfter.sweep || verifyAfter.sweep).id)
      || String(verifyBefore.sweep.status) !== String((diagnosePayoutAfter.sweep || verifyAfter.sweep).status)));
  const productionMoneyMoved = (verifyAfter.recentProductionTransfers || 0) > 0
    || verifyAfter.freedomEnvironment !== 'production';
  const completedParity = moovStatus === 'completed'
    && String(intent?.status || '').toLowerCase() === 'completed'
    && String(intent?.provider_status || '').toLowerCase() === 'completed'
    && intent?.failure_reason == null
    && Boolean(intent?.completed_at || intent?.completed_at_utc)
    && Boolean(moovCompletedAt);
  const failedUpdated = FAILED.has(moovStatus)
    && FAILED.has(String(intent?.status || '').toLowerCase())
    && intent?.id === PAYOUT_INTENT_ID
    && verifyAfter.payoutIntentCount === 1;
  const pendingStop = PENDING.has(moovStatus);
  const fullyReconciled = isolated
    && uniquePayout
    && fundingUnchanged
    && flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'
    && productionMoneyMoved === false
    && sweepChanged === false
    && (completedParity || failedUpdated)
    && pendingStop === false;
  const loopProven = fullyReconciled && completedParity && uniqueFunding;
  const go = loopProven;
  const returnCard = {
    'MOOV PAYOUT STATUS': moovStatus || String(transfer.status || 'none'),
    ORIGINATED_ON: moovOriginatedAt || 'none',
    COMPLETED_ON: moovCompletedAt || 'none',
    'PAYOUT INTENT STATUS': String(intent?.status || 'none'),
    'PROVIDER STATUS': String(intent?.provider_status || 'none'),
    'PROVIDER REFERENCE': String(intent?.provider_transfer_id || PAYOUT_TRANSFER_ID),
    COMPLETED_AT: intent?.completed_at_utc || intent?.completed_at || 'none',
    FAILURE_REASON: intent?.failure_reason == null ? 'null' : String(intent.failure_reason),
    'WEBHOOK RECEIPT': receipt?.id || receipt?.external_event_id || (receipts.length ? String(receipts.length) : 'none'),
    'WEBHOOK APPLIED': webhookApplied
      ? 'true'
      : (pendingStop
        ? 'false'
        : (moovStatus === 'completed' ? 'false (GET recon)' : 'false')),
    'WALLET AVAILABLE': String(walletAvailable),
    'WALLET PENDING': String(walletPending),
    'PAYOUT TRANSFER COUNT': String(payouts.length),
    'PAYOUT INTENT COUNT': String(verifyAfter.payoutIntentCount ?? 0),
    'SECOND POST': 'false',
    'DUPLICATE PAYOUT': String(payouts.length > 1 || (verifyAfter.payoutIntentCount || 0) > 1),
    'FUNDING TRANSFER UNCHANGED': String(fundingUnchanged),
    'SANDBOX POST FLAG': String(flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || 'false'),
    'PRODUCTION POST FLAG': String(flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    'FREEDOM CHANGED': String(verifyAfter.freedomEnvironment !== 'production' || recon.freedomChanged === true),
    'SWEEP CHANGED': String(sweepChanged || recon.sweepChanged === true),
    'PRODUCTION MONEY MOVED': String(productionMoneyMoved),
    'PAYOUT FULLY RECONCILED': fullyReconciled ? 'true' : 'false',
    'SANDBOX BANK→WALLET→RECIPIENT LOOP PROVEN': loopProven ? 'true' : 'false',
    'SAFE TO BEGIN REPEATED SANDBOX END-TO-END TESTING': go ? 'YES' : 'NO',
    'GO/NO-GO': go ? 'GO' : 'NO-GO',
  };
  writeReturnCard(returnCard);
  fs.writeFileSync('/opt/cursor/artifacts/m710a_run.json', JSON.stringify({
    at: new Date().toISOString(),
    identity: { arn: identity.Arn },
    posted: false,
    armed: false,
    secondPost: false,
    flagsBefore: flagsBefore.flags,
    flagsEnd: flagsEnd.flags,
    liveTransfer: {
      ok: liveTransfer.ok === true,
      id: transfer.id,
      status: transfer.status,
      originatedOn: moovOriginatedAt,
      completedOn: moovCompletedAt,
      amountCents: transfer.amountCents,
      sourcePm: transfer.sourcePm,
      destinationPm: transfer.destinationPm,
      environment: 'sandbox',
    },
    payouts,
    fundingRows: fundingRows.map((row) => ({ id: row.id, status: row.status })),
    wallet: {
      availableCents: walletAvailable,
      pendingCents: walletPending,
      rdsAvailable: rdsWallet?.available_cents ?? null,
      rdsPending: rdsWallet?.pending_cents ?? null,
    },
    intentBefore: snapshotOf(payoutIntentBefore),
    intentAfter: snapshotOf(intent),
    fundingBefore,
    fundingAfter,
    receipts: {
      count: receipts.length,
      ids: receipts.map((row) => row.id || row.external_event_id),
      applied: webhookApplied,
    },
    recon: {
      ok: recon.ok,
      skipped: recon.skipped || null,
      mode: recon.mode || (pendingStop ? 'pending_stop' : null),
      createdPaymentTransfer: recon.createdPaymentTransfer === true,
      liveProviderPosted: recon.liveProviderPosted === true,
      fundingUnchanged: recon.fundingUnchanged,
    },
    verifyAfter: {
      payoutIntentCount: verifyAfter.payoutIntentCount,
      fundingIntentCount: verifyAfter.fundingIntentCount,
      freedomEnvironment: verifyAfter.freedomEnvironment,
      recentProductionTransfers: verifyAfter.recentProductionTransfers,
    },
    isolated,
    uniquePayout,
    uniqueFunding,
    fundingUnchanged,
    pendingStop,
    completedParity,
    failedUpdated,
    fullyReconciled,
    loopProven,
    returnCard,
    STOP_FOR_REVIEW: true,
  }, null, 2));
  console.log(JSON.stringify({
    ok: pendingStop ? true : go,
    posted: false,
    armed: false,
    pendingStop,
    moovStatus,
    returnCard,
  }, null, 2));
  if (!pendingStop && !go && !failedUpdated) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error);
  writeReturnCard({
    'MOOV PAYOUT STATUS': 'error',
    'GO/NO-GO': 'NO-GO',
    ERROR: String(error?.message || error).slice(0, 400),
    'SECOND POST': 'false',
    'PRODUCTION MONEY MOVED': 'false',
    'PAYOUT FULLY RECONCILED': 'false',
    'SANDBOX BANK→WALLET→RECIPIENT LOOP PROVEN': 'false',
    'SAFE TO BEGIN REPEATED SANDBOX END-TO-END TESTING': 'NO',
  });
  process.exitCode = 1;
});
