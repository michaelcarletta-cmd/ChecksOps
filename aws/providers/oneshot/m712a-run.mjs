#!/usr/bin/env node
/**
 * M7.12A: GET-only reconcile of the EXISTING automated sandbox funding leg.
 * Never POSTs /transfers. Never creates an operation, funding intent, or payout intent.
 * Never arms POST flags. Never POSTs payout even if PAYOUT_READY=true.
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
import { normalizeMoovStatus } from '../../functions/api/providers/moov-lifecycle.mjs';
import { moovSandboxFetch, moovSandboxScopes } from '../../functions/api/providers/moov-sandbox.mjs';
import {
  M712_FUNDING_INTENT_ID,
  M712_FUNDING_TRANSFER_ID,
  M712_OPERATION_ID,
  M712_PAYOUT_INTENT_ID,
  evaluateSandboxFundingResumeGate,
  executeSandboxPayoutE2e,
  m712PayoutOperationId,
} from '../../functions/api/providers/production/moov-sandbox-payout-e2e.mjs';

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
const DEST_PM = '7a5ef572-501e-4eac-8c1b-7a4794296a85';
const OPERATION = '69704e23-9ddd-52f8-a2b1-d48bdb500926';
const FUNDING_INTENT_ID = '985f487b-74f2-4d9f-8e6f-7cad9ae10c97';
const PAYOUT_INTENT_ID = 'df6e3d55-ccc9-43cd-b275-8cde8e24c343';
const FUNDING_TRANSFER_ID = 'e42635e8-7a75-4d25-ad2f-dd0e5696372d';
const LIVE_ORIGIN = PRODUCTION_MOOV_ORIGIN;
const PROVEN_API_VERSION = PRODUCTION_MOOV_API_VERSION;
const PENDING = new Set(['pending', 'processing', 'queued', 'originated', 'submitted', 'created']);
const FAILED = new Set(['failed', 'returned', 'canceled', 'cancelled', 'unknown']);

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
    '--role-session-name', 'checksops-m712a-sandbox-funding-recon',
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
  createdOn: row?.createdOn || row?.createdAt || null,
  completedOn: row?.completedOn || row?.completedAt
    || row?.source?.achDetails?.completedOn
    || row?.destination?.achDetails?.completedOn
    || null,
  originatedOn: row?.source?.achDetails?.originatedOn
    || row?.destination?.achDetails?.originatedOn
    || row?.originatedOn
    || null,
  achStatus: row?.source?.achDetails?.status || row?.destination?.achDetails?.status || null,
  failureReason: row?.failureReason || row?.failure?.reason || row?.returnCode || null,
});
const matchingFunding = (rows) => {
  const matched = (rows || []).filter((row) => (
    row.amountCents === 1
    && String(row.sourcePm || '').toLowerCase() === SANDBOX_FUND_PM
    && String(row.destinationPm || '').toLowerCase() === SANDBOX_WALLET_PM
    && String(row.id || '').toLowerCase() === FUNDING_TRANSFER_ID
  ));
  const seen = new Map();
  for (const row of matched) {
    const id = String(row.id || '').toLowerCase();
    if (id && !seen.has(id)) seen.set(id, row);
  }
  return [...seen.values()];
};
const matchingPayout = (rows) => {
  const matched = (rows || []).filter((row) => (
    row.amountCents === 1
    && String(row.sourcePm || '').toLowerCase() === SANDBOX_WALLET_PM
    && String(row.destinationPm || '').toLowerCase() === DEST_PM
    && String(row.id || '').toLowerCase() !== 'dec24b01-e559-4014-b072-af1ac0e4d013'
    && String(row.id || '').toLowerCase() !== 'c2d1078a-0261-4a3b-9782-777fad834af9'
  ));
  return matched.filter((row) => String(row.id || '').toLowerCase() !== FUNDING_TRANSFER_ID);
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

const lambdaConfig = () => awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
const lambdaFlags = (cfg = lambdaConfig()) => {
  const env = cfg.Environment?.Variables || {};
  return {
    codeSha256: cfg.CodeSha256 || null,
    lastModified: cfg.LastModified || null,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
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
  const staging = path.join(os.tmpdir(), 'checksops-m712a-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/77_moov_tenant_environment.sql'), path.join(staging, '77_moov_tenant_environment.sql'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/78_moov_recon_parity.sql'), path.join(staging, '78_moov_recon_parity.sql'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m712a-oneshot.zip');
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
  const outFile = `/tmp/m712a-oneshot-${payload.step}-${Date.now()}.json`;
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
    'MOOV FUNDING STATUS',
    'ORIGINATED_ON',
    'COMPLETED_ON',
    'FUNDING INTENT STATUS',
    'FUNDING PROVIDER STATUS',
    'FUNDING COMPLETED_AT',
    'FUNDING FAILURE_REASON',
    'LIVE WALLET AVAILABLE',
    'LIVE WALLET PENDING',
    'RDS WALLET AVAILABLE',
    'BALANCE PARITY',
    'PAYOUT OPERATION STATE',
    'PAYOUT INTENT STATUS',
    'PAYOUT_READY',
    'RELEASE CONDITIONS SATISFIED',
    'OPERATION COUNT',
    'FUNDING INTENT COUNT',
    'PAYOUT INTENT COUNT',
    'FUNDING TRANSFER COUNT',
    'PAYOUT TRANSFER COUNT',
    'PROVIDER POSTS THIS PHASE',
    'SECOND FUNDING POST',
    'PAYOUT POST',
    'SANDBOX POST FLAG',
    'PRODUCTION POST FLAG',
    'FREEDOM CHANGED',
    'SWEEP CHANGED',
    'PRODUCTION MONEY MOVED',
    'SAFE TO RESUME SAME OPERATION FOR PAYOUT',
    'GO/NO-GO',
  ];
  const lines = order.filter((key) => card[key] !== undefined).map((key) => `${key}: ${card[key]}`);
  const extra = Object.entries(card).filter(([key]) => !order.includes(key)).map(([key, value]) => `${key}: ${value}`);
  const text = `${[...lines, ...extra].join('\n')}\n\nSTOP FOR REVIEW.\nDo not POST the payout even if PAYOUT_READY=true.\nDo not arm either POST flag.\n`;
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/m712a_return_card.md', text);
  fs.writeFileSync('/opt/cursor/artifacts/m712a_return_card_final.md', text);
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
    || SANDBOX_RECIPIENT_ACCOUNT !== PIPELINE_TEST_SANDBOX.recipientAccountId) {
    throw new Error('sandbox_object_constants_drift');
  }
  if (m712PayoutOperationId() !== OPERATION) throw new Error('operation_id_drift');
  if (OPERATION !== M712_OPERATION_ID
    || FUNDING_INTENT_ID !== M712_FUNDING_INTENT_ID
    || PAYOUT_INTENT_ID !== M712_PAYOUT_INTENT_ID
    || FUNDING_TRANSFER_ID !== M712_FUNDING_TRANSFER_ID) {
    throw new Error('frozen_id_drift');
  }

  const identity = await assumeRole();
  const flagsBefore = lambdaFlags();
  if (flagsBefore.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_production_post_armed');
  if (flagsBefore.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_sandbox_post_armed');
  const production = JSON.parse(awsJson([
    'secretsmanager', 'get-secret-value',
    '--secret-id', flagsBefore.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET,
  ]).SecretString || '{}');
  const credentials = sandboxCredentials(production);
  if (!present(credentials.publicKey) || !present(credentials.secretKey) || !present(credentials.platformId)) {
    throw new Error('sandbox_credentials_missing');
  }
  if (credentials.publicKey === production.MOOV_PUBLIC_KEY || credentials.secretKey === production.MOOV_SECRET_KEY) {
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

  const verifyBefore = invokeOneshot({ step: 'verify', tenantId: PIPELINE });
  const listedBefore = invokeOneshot({
    step: 'list_orchestrator_operation',
    tenantId: PIPELINE,
    payoutOperationId: OPERATION,
  });
  const diagnoseFundingBefore = invokeOneshot({
    step: 'diagnose_funding_reconcile',
    tenantId: PIPELINE,
    transferId: FUNDING_TRANSFER_ID,
    intentId: FUNDING_INTENT_ID,
  });

  const liveTransfer = await getJson(
    credentials,
    `/accounts/${SANDBOX_PLATFORM}/transfers/${FUNDING_TRANSFER_ID}`,
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
  const fundingRows = matchingFunding([
    ...asList(merchantTransfers.data).map(summarizeTransfer),
    ...asList(platformTransfers.data).map(summarizeTransfer),
    transfer,
  ]);
  const payoutRows = matchingPayout([
    ...asList(merchantTransfers.data).map(summarizeTransfer),
    ...asList(platformTransfers.data).map(summarizeTransfer),
  ]).filter((row) => String(row.createdOn || '') >= '2026-09-21T13:38:00Z');
  const walletJson = liveWallet.data || {};
  const walletAvailable = amountCentsOf(walletJson.availableBalance ?? walletJson.available);
  const walletPending = amountCentsOf(walletJson.pendingBalance ?? walletJson.pending);
  const moovStatus = normalizeMoovStatus(transfer.status || transferJson.status);
  const moovCompletedAt = transfer.completedOn || null;
  const moovOriginatedAt = transfer.originatedOn || null;
  if (String(transfer.id || '').toLowerCase() !== FUNDING_TRANSFER_ID) throw new Error('unexpected_transfer_id');
  if (transfer.amountCents !== 1) throw new Error('unexpected_amount');
  if (String(transfer.sourcePm || '').toLowerCase() !== SANDBOX_FUND_PM) throw new Error('unexpected_source_pm');
  if (String(transfer.destinationPm || '').toLowerCase() !== SANDBOX_WALLET_PM) throw new Error('unexpected_destination_pm');

  const uniqueFunding = fundingRows.length === 1 && String(fundingRows[0]?.id || '').toLowerCase() === FUNDING_TRANSFER_ID;
  const uniquePayoutTransfers = payoutRows.length === 0;
  const readbackOnly = process.argv[2] === 'readback';

  let recon = {
    ok: true,
    skipped: readbackOnly ? 'readback' : (PENDING.has(moovStatus) ? 'pending' : null),
    createdPaymentTransfer: false,
    liveProviderPosted: false,
    mode: PENDING.has(moovStatus) ? 'pending_stop' : null,
  };
  if (!readbackOnly && moovStatus === 'completed') {
    if (!moovCompletedAt) throw new Error('provider_completed_on_missing');
    recon = invokeOneshot({
      step: 'reconcile_funding_parity',
      tenantId: PIPELINE,
      intentId: FUNDING_INTENT_ID,
      providerTransferId: FUNDING_TRANSFER_ID,
      providerWalletId: SANDBOX_WALLET,
      providerStatus: transfer.status || 'completed',
      completedAt: moovCompletedAt,
      availableCents: walletAvailable,
      pendingCents: walletPending,
      phase: 'm712a',
    });
    if (recon?.ok !== true) throw new Error(`funding_recon_failed:${recon?.error || 'unknown'}`);
  } else if (!readbackOnly && FAILED.has(moovStatus)) {
    recon = invokeOneshot({
      step: 'reconcile_funding_parity',
      tenantId: PIPELINE,
      intentId: FUNDING_INTENT_ID,
      providerTransferId: FUNDING_TRANSFER_ID,
      providerWalletId: SANDBOX_WALLET,
      providerStatus: transfer.status || moovStatus,
      failureReason: transfer.failureReason || transfer.achStatus || moovStatus,
      availableCents: walletAvailable,
      pendingCents: walletPending,
      phase: 'm712a',
    });
    const failedUpdate = invokeOneshot({
      step: 'update_orchestrator_intent',
      tenantId: PIPELINE,
      intentId: FUNDING_INTENT_ID,
      idempotencyKey: listedBefore.fundingRows?.[0]?.idempotency_key,
      providerTransferId: FUNDING_TRANSFER_ID,
      providerStatus: transfer.status || moovStatus,
      status: moovStatus === 'cancelled' ? 'canceled' : moovStatus,
      failureReason: transfer.failureReason || transfer.achStatus || moovStatus,
    });
    if (recon?.ok !== true && failedUpdate?.ok !== true) {
      throw new Error(`funding_fail_update_failed:${recon?.error || failedUpdate?.error || 'unknown'}`);
    }
    recon = { ...recon, failedUpdate, mode: 'update_existing_only' };
  }

  const listedAfter = invokeOneshot({
    step: 'list_orchestrator_operation',
    tenantId: PIPELINE,
    payoutOperationId: OPERATION,
  });
  const diagnoseFundingAfter = invokeOneshot({
    step: 'diagnose_funding_reconcile',
    tenantId: PIPELINE,
    transferId: FUNDING_TRANSFER_ID,
    intentId: FUNDING_INTENT_ID,
  });
  const verifyAfter = invokeOneshot({ step: 'verify', tenantId: PIPELINE });
  const fundingIntent = diagnoseFundingAfter.intent || listedAfter.fundingRows?.[0] || recon.intent || null;
  const payoutIntent = listedAfter.payoutRows?.[0] || listedBefore.payoutRows?.[0] || null;
  const rdsWallet = diagnoseFundingAfter.rdsWallet || recon.rdsWallet || verifyAfter.sandbox?.wallet || null;

  const existingOnlyStore = {
    async getIntent(key) {
      const got = invokeOneshot({
        step: 'get_orchestrator_intent',
        tenantId: PIPELINE,
        idempotencyKey: String(key),
        payoutOperationId: OPERATION,
      });
      return mapIntent(got.intent);
    },
    async putIntent() { throw new Error('new_intent_refused'); },
    async updateIntent(key, patch = {}) {
      const updated = invokeOneshot({
        step: 'update_orchestrator_intent',
        tenantId: PIPELINE,
        idempotencyKey: String(key),
        providerTransferId: patch.provider_transfer_id || FUNDING_TRANSFER_ID,
        providerStatus: patch.provider_status || null,
        status: patch.status || null,
        completedAt: patch.completed_at || null,
        failureReason: patch.failure_reason || null,
      });
      if (updated.ok !== true) return null;
      return mapIntent(updated.intent);
    },
  };
  const existingRows = [...(listedAfter.fundingRows || []), ...(listedAfter.payoutRows || [])].map(mapIntent);
  const evaluated = await executeSandboxPayoutE2e({
    tenantId: PIPELINE,
    tenantEnvironment: 'sandbox',
    liveAvailableCents: walletAvailable,
    rdsAvailableCents: rdsWallet?.available_cents ?? null,
    payoutCents: 1,
    recipientVerified: true,
    persistMoneyIntents: false,
    store: existingOnlyStore,
    existingRows,
    transferPostEnabled: false,
    productionTransferPostEnabled: false,
    operationId: OPERATION,
    haltAfterFundingAttempt: true,
    executeFunding: async () => { throw new Error('second_fund_forbidden'); },
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
    getTransfer: async (id) => {
      if (String(id || '').toLowerCase() !== FUNDING_TRANSFER_ID) {
        throw new Error('unexpected_get_transfer');
      }
      return transferJson;
    },
    refreshLiveWallet: async () => walletAvailable,
  });

  const gate = evaluateSandboxFundingResumeGate({
    fundingIntentStatus: fundingIntent?.status,
    providerStatus: moovStatus,
    liveAvailableCents: walletAvailable,
    payoutCents: 1,
  });
  const flagsEnd = lambdaFlags();
  const isolated = String(fundingIntent?.id || '') === FUNDING_INTENT_ID
    && String(payoutIntent?.id || '') === PAYOUT_INTENT_ID
    && String(fundingIntent?.provider_transfer_id || '').toLowerCase() === FUNDING_TRANSFER_ID
    && !payoutIntent?.provider_transfer_id
    && (listedAfter.operationFunding || 0) === 1
    && (listedAfter.operationPayout || 0) === 1
    && verifyAfter.freedomEnvironment === 'production'
    && (listedAfter.recentProduction || 0) === 0;
  const sweepChanged = Boolean(verifyBefore.sweep && (diagnoseFundingAfter.sweep || verifyAfter.sweep)
    && (String(verifyBefore.sweep.id) !== String((diagnoseFundingAfter.sweep || verifyAfter.sweep).id)
      || String(verifyBefore.sweep.status) !== String((diagnoseFundingAfter.sweep || verifyAfter.sweep).status)));
  const productionMoneyMoved = (listedAfter.recentProduction || 0) > 0
    || (listedAfter.recentFreedom || 0) > 0
    || verifyAfter.freedomEnvironment !== 'production';
  const balanceParity = Number(rdsWallet?.available_cents) === Number(walletAvailable);
  const pendingStop = PENDING.has(moovStatus) && String(fundingIntent?.status || '').toLowerCase() !== 'completed';
  const postsThisPhase = Number(evaluated.funding_provider_posts || 0) + Number(evaluated.payout_provider_posts || 0);
  const sameOperation = evaluated.payout_operation_id === OPERATION
    && (listedAfter.operationFunding || 0) === 1
    && (listedAfter.operationPayout || 0) === 1;
  const flagsSafe = flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true';
  const go = isolated
    && uniqueFunding
    && uniquePayoutTransfers
    && sameOperation
    && flagsSafe
    && productionMoneyMoved === false
    && sweepChanged === false
    && postsThisPhase === 0
    && evaluated.sandbox_provider_posts === 0
    && recon.createdPaymentTransfer !== true
    && recon.liveProviderPosted !== true
    && (pendingStop || gate.reason === 'payout_ready' || gate.reason === 'funding_completed_waiting_for_wallet' || gate.reason === 'payout_blocked');
  const operationState = `${gate.funding_state}/${gate.payout_state}`;
  const returnCard = {
    'MOOV FUNDING STATUS': moovStatus || String(transfer.status || 'none'),
    ORIGINATED_ON: moovOriginatedAt || 'none',
    COMPLETED_ON: moovCompletedAt || 'none',
    'FUNDING INTENT STATUS': String(fundingIntent?.status || 'none'),
    'FUNDING PROVIDER STATUS': String(fundingIntent?.provider_status || 'none'),
    'FUNDING COMPLETED_AT': fundingIntent?.completed_at_utc || fundingIntent?.completed_at || 'none',
    'FUNDING FAILURE_REASON': fundingIntent?.failure_reason == null ? 'null' : String(fundingIntent.failure_reason),
    'LIVE WALLET AVAILABLE': String(walletAvailable),
    'LIVE WALLET PENDING': String(walletPending),
    'RDS WALLET AVAILABLE': String(rdsWallet?.available_cents ?? 'none'),
    'BALANCE PARITY': String(balanceParity),
    'PAYOUT OPERATION STATE': operationState,
    'PAYOUT INTENT STATUS': String(payoutIntent?.status || 'none'),
    PAYOUT_READY: String(gate.payout_ready === true),
    'RELEASE CONDITIONS SATISFIED': String(gate.release_conditions_satisfied === true),
    'OPERATION COUNT': '1',
    'FUNDING INTENT COUNT': String(listedAfter.operationFunding ?? 0),
    'PAYOUT INTENT COUNT': String(listedAfter.operationPayout ?? 0),
    'FUNDING TRANSFER COUNT': String(fundingRows.length),
    'PAYOUT TRANSFER COUNT': String(payoutRows.length),
    'PROVIDER POSTS THIS PHASE': String(postsThisPhase),
    'SECOND FUNDING POST': 'false',
    'PAYOUT POST': 'false',
    'SANDBOX POST FLAG': String(flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || 'false'),
    'PRODUCTION POST FLAG': String(flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    'FREEDOM CHANGED': String(verifyAfter.freedomEnvironment !== 'production' || recon.freedomChanged === true),
    'SWEEP CHANGED': String(sweepChanged || recon.sweepChanged === true),
    'PRODUCTION MONEY MOVED': String(productionMoneyMoved),
    'SAFE TO RESUME SAME OPERATION FOR PAYOUT': gate.safe_to_resume_payout ? 'YES' : 'NO',
    'GO/NO-GO': go && !FAILED.has(moovStatus) ? 'GO' : 'NO-GO',
    GATE_REASON: gate.reason,
    PAYOUT_OPERATION_ID: OPERATION,
    FUNDING_INTENT_ID,
    PAYOUT_INTENT_ID,
    FUNDING_TRANSFER_ID,
  };
  writeReturnCard(returnCard);
  fs.writeFileSync('/opt/cursor/artifacts/m712a_run.json', JSON.stringify({
    at: new Date().toISOString(),
    identity: { arn: identity.Arn },
    posted: false,
    armed: false,
    secondFundingPost: false,
    payoutPost: false,
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
      failureReason: transfer.failureReason,
      environment: 'sandbox',
    },
    wallet: {
      availableCents: walletAvailable,
      pendingCents: walletPending,
      rdsAvailable: rdsWallet?.available_cents ?? null,
      rdsPending: rdsWallet?.pending_cents ?? null,
    },
    fundingBefore: snapshotOf(diagnoseFundingBefore.intent),
    fundingAfter: snapshotOf(fundingIntent),
    payoutIntent: snapshotOf(payoutIntent),
    listedBefore: {
      operationFunding: listedBefore.operationFunding,
      operationPayout: listedBefore.operationPayout,
    },
    listedAfter: {
      operationFunding: listedAfter.operationFunding,
      operationPayout: listedAfter.operationPayout,
      recentProduction: listedAfter.recentProduction,
      recentFreedom: listedAfter.recentFreedom,
    },
    recon: {
      ok: recon.ok,
      skipped: recon.skipped || null,
      mode: recon.mode || (pendingStop ? 'pending_stop' : null),
      createdPaymentTransfer: recon.createdPaymentTransfer === true,
      liveProviderPosted: recon.liveProviderPosted === true,
    },
    evaluated: {
      payout_operation_id: evaluated.payout_operation_id,
      decision: evaluated.decision,
      funding_state: evaluated.funding_state,
      payout_state: evaluated.payout_state,
      funding_provider_posts: evaluated.funding_provider_posts,
      payout_provider_posts: evaluated.payout_provider_posts,
      persist_money_intents: evaluated.persist_money_intents,
    },
    gate,
    isolated,
    uniqueFunding,
    uniquePayoutTransfers,
    pendingStop,
    go,
    returnCard,
    STOP_FOR_REVIEW: true,
  }, null, 2));
  console.log(JSON.stringify({
    ok: pendingStop ? true : go,
    posted: false,
    armed: false,
    pendingStop,
    moovStatus,
    gate,
    returnCard,
  }, null, 2));
  if (FAILED.has(moovStatus)) process.exitCode = 1;
  else if (!pendingStop && !go) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error);
  writeReturnCard({
    'MOOV FUNDING STATUS': 'error',
    'GO/NO-GO': 'NO-GO',
    ERROR: String(error?.message || error).slice(0, 400),
    'PROVIDER POSTS THIS PHASE': '0',
    'SECOND FUNDING POST': 'false',
    'PAYOUT POST': 'false',
    'PRODUCTION MONEY MOVED': 'false',
    'SAFE TO RESUME SAME OPERATION FOR PAYOUT': 'NO',
  });
  process.exitCode = 1;
});
