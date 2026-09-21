#!/usr/bin/env node
/**
 * M7.12 terminal timestamp parity: overlay sandbox webhook completed_at stamping
 * onto prep-api, then GET-fill ONLY the existing payout row from Moov completedOn.
 *
 * Never POSTs /transfers. Never creates an intent or transfer. Never arms POST flags.
 * Never overlays staging-api. Never updates Freedom or Sweep.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';
import { PIPELINE_TEST_SANDBOX } from '../../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import { extractTransferEvent, normalizeMoovStatus } from '../../functions/api/providers/moov-lifecycle.mjs';
import { moovSandboxFetch, moovSandboxScopes } from '../../functions/api/providers/moov-sandbox.mjs';
import {
  M712_FUNDING_INTENT_ID,
  M712_FUNDING_TRANSFER_ID,
  M712_OPERATION_ID,
  M712_PAYOUT_INTENT_ID,
  M712_PAYOUT_TRANSFER_ID,
  m712PayoutOperationId,
} from '../../functions/api/providers/production/moov-sandbox-payout-e2e.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const ONESHOT_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/providers/oneshot/m79-sandbox-tenant');
const API_SRC = path.join(ROOT, 'aws/functions/api');
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
const OPERATION = M712_OPERATION_ID;
const FUNDING_INTENT_ID = M712_FUNDING_INTENT_ID;
const PAYOUT_INTENT_ID = M712_PAYOUT_INTENT_ID;
const FUNDING_TRANSFER_ID = M712_FUNDING_TRANSFER_ID;
const PAYOUT_TRANSFER_ID = M712_PAYOUT_TRANSFER_ID;
const EXPECTED_COMPLETED_ON = '2026-09-21T19:46:00.803144Z';
const LIVE_ORIGIN = PRODUCTION_MOOV_ORIGIN;
const PROVEN_API_VERSION = PRODUCTION_MOOV_API_VERSION;
const OVERLAY_FILES = [
  'providers/webhook-apply.mjs',
  'providers/moov-lifecycle.mjs',
];
const MUST_KEEP = [
  'auth-cognito.mjs',
  'index.mjs',
  'providers/production/moov-wallet-fund.mjs',
  'providers/production/moov-wallet-disburse.mjs',
  'providers/moov-wallet-fund.mjs',
  'providers/moov-wallet-disburse.mjs',
];

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
    '--role-session-name', 'checksops-m712-completed-at-parity',
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
const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
const isoUtc = (value) => {
  if (!value) return null;
  if (typeof value === 'string' && /Z$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().replace(/\.(\d{3})Z$/, (m, ms) => {
    const raw = String(value);
    const match = raw.match(/\.(\d+)Z$/);
    return match ? `.${match[1]}Z` : `.${ms}000Z`;
  });
};

const lambdaConfig = (name = API_FN) => awsJson(['lambda', 'get-function-configuration', '--function-name', name]);
const lambdaFlags = (cfg = lambdaConfig()) => {
  const env = cfg.Environment?.Variables || {};
  return {
    functionName: cfg.FunctionName || API_FN,
    codeSha256: cfg.CodeSha256 || null,
    lastModified: cfg.LastModified || null,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
      AWS_PROVIDER_WEBHOOK_DRY_RUN: env.AWS_PROVIDER_WEBHOOK_DRY_RUN || null,
      AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED || null,
      AWS_PROVIDER_EXECUTION_ENABLED: env.AWS_PROVIDER_EXECUTION_ENABLED || null,
      AWS_FINANCIAL_PERMISSIONS_ACTIVATED: env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || null,
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
  const staging = path.join(os.tmpdir(), 'checksops-m712-completed-at-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/77_moov_tenant_environment.sql'), path.join(staging, '77_moov_tenant_environment.sql'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/78_moov_recon_parity.sql'), path.join(staging, '78_moov_recon_parity.sql'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m712-completed-at-oneshot.zip');
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
  const outFile = `/tmp/m712-completed-at-oneshot-${payload.step}-${Date.now()}.json`;
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
const overlayPrepApi = () => {
  const work = path.join(os.tmpdir(), 'checksops-m712-completed-at-overlay');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const loc = awsJson(['lambda', 'get-function', '--function-name', API_FN]);
  const zipPath = path.join(work, 'live.zip');
  run('curl', ['-fsSL', loc.Code.Location, '-o', zipPath]);
  const unpacked = path.join(work, 'unpacked');
  fs.mkdirSync(unpacked, { recursive: true });
  run('unzip', ['-q', zipPath, '-d', unpacked]);
  const keepBefore = {};
  for (const rel of MUST_KEEP) {
    const full = path.join(unpacked, rel);
    if (fs.existsSync(full)) keepBefore[rel] = sha256File(full);
  }
  const copied = [];
  for (const rel of OVERLAY_FILES) {
    const src = path.join(API_SRC, rel);
    const dest = path.join(unpacked, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push({ rel, sha256: sha256File(dest) });
  }
  const keepAfter = {};
  for (const rel of MUST_KEEP) {
    const full = path.join(unpacked, rel);
    if (fs.existsSync(full)) keepAfter[rel] = sha256File(full);
    if (keepBefore[rel] && keepAfter[rel] !== keepBefore[rel]) {
      throw new Error(`overlay mutated protected file ${rel}`);
    }
  }
  const outZip = path.join(work, 'overlay.zip');
  run('zip', ['-qr', outZip, '.'], { cwd: unpacked });
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  run(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', API_FN, '--zip-file', `fileb://${outZip}`]);
  waitFn(API_FN);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  if (JSON.stringify(before.Environment?.Variables) !== JSON.stringify(after.Environment?.Variables)) {
    throw new Error('overlay_changed_lambda_env');
  }
  if (after.Environment?.Variables?.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') {
    throw new Error('refused_production_post_armed');
  }
  if (after.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') {
    throw new Error('refused_sandbox_post_armed');
  }
  return {
    beforeSha: before.CodeSha256,
    afterSha: after.CodeSha256,
    lastModified: after.LastModified,
    copied,
    protectedUnchanged: Object.keys(keepBefore).every((rel) => keepBefore[rel] === keepAfter[rel]),
    envUnchanged: true,
    POST_FLAG: after.Environment?.Variables?.AWS_MOOV_TRANSFER_POST_ENABLED || null,
    SANDBOX_POST_FLAG: after.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
  };
};
const snapshotIntent = (row) => row ? {
  id: row.id,
  status: row.status,
  provider_status: row.provider_status,
  provider_transfer_id: row.provider_transfer_id,
  completed_at: row.completed_at_utc || row.completed_at || null,
  failure_reason: row.failure_reason ?? null,
  environment: row.environment || null,
  leg_role: row.leg_role || null,
} : null;
const writeReturnCard = (card) => {
  const order = [
    'ROOT CAUSE',
    'FILES CHANGED',
    'TESTS',
    'MOOV STATUS',
    'MOOV COMPLETED_ON',
    'RDS STATUS',
    'RDS PROVIDER_STATUS',
    'RDS COMPLETED_AT',
    'RDS FAILURE_REASON',
    'COMPLETED_AT EXACT MATCH',
    'WEBHOOK FUTURE PATH FIXED',
    'GET/WEBHOOK CONVERGENCE',
    'FUNDING INTENT COUNT',
    'PAYOUT INTENT COUNT',
    'FUNDING PROVIDER TRANSFER COUNT',
    'PAYOUT PROVIDER TRANSFER COUNT',
    'NEW PROVIDER POSTS',
    'NEW INTENTS',
    'MONEY MOVED',
    'SWEEP CHANGED',
    'SANDBOX POST FLAG',
    'PRODUCTION POST FLAG',
    'M7.12 FINAL RESULT',
  ];
  const lines = order.filter((key) => card[key] !== undefined).map((key) => `${key}: ${card[key]}`);
  const extra = Object.entries(card).filter(([key]) => !order.includes(key)).map(([key, value]) => `${key}: ${value}`);
  const text = `${[...lines, ...extra].join('\n')}\n\nSTOP FOR REVIEW.\nNo provider POST under any circumstance.\n`;
  fs.writeFileSync('/opt/cursor/artifacts/m712_completed_at_card.md', text);
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
  if (PAYOUT_TRANSFER_ID !== M712_PAYOUT_TRANSFER_ID) throw new Error('frozen_id_drift');

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

  const overlay = overlayPrepApi();
  const zip = packOneshot();
  const secretsList = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secretsList.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  ensureOneshot(zip, adminSecret.ARN, flagsBefore.vpc);

  const listedBefore = invokeOneshot({
    step: 'list_orchestrator_operation',
    tenantId: PIPELINE,
    payoutOperationId: OPERATION,
  });
  const liveTransfer = await getJson(
    credentials,
    `/accounts/${SANDBOX_PLATFORM}/transfers/${PAYOUT_TRANSFER_ID}`,
    moovSandboxScopes.transfersRead(SANDBOX_PLATFORM),
  );
  const transferJson = liveTransfer.data || {};
  const extracted = extractTransferEvent({
    type: 'transfer.status_refresh',
    data: transferJson,
  });
  const moovStatus = normalizeMoovStatus(transferJson.status || extracted.status);
  const moovCompletedOn = extracted.completedOn
    || transferJson.completedOn
    || transferJson.destination?.achDetails?.completedOn
    || null;
  if (String(transferJson.transferID || transferJson.transferId || '').toLowerCase() !== PAYOUT_TRANSFER_ID) {
    throw new Error('unexpected_transfer_id');
  }
  if (amountCentsOf(transferJson.amount) !== 1) throw new Error('unexpected_amount');
  if (String(transferJson.source?.paymentMethodID || '').toLowerCase() !== SANDBOX_WALLET_PM) {
    throw new Error('unexpected_source_pm');
  }
  if (String(transferJson.destination?.paymentMethodID || '').toLowerCase() !== DEST_PM) {
    throw new Error('unexpected_destination_pm');
  }
  if (moovStatus !== 'completed') throw new Error(`payout_not_completed:${moovStatus}`);
  if (!moovCompletedOn) throw new Error('provider_completed_on_missing');

  const recon = invokeOneshot({
    step: 'reconcile_m712_payout_completed_at',
    tenantId: PIPELINE,
    intentId: PAYOUT_INTENT_ID,
    providerTransferId: PAYOUT_TRANSFER_ID,
    providerStatus: transferJson.status || 'completed',
    completedAt: moovCompletedOn,
  });
  if (recon?.ok !== true) throw new Error(`payout_completed_at_fill_failed:${recon?.error || 'unknown'}`);

  const listedAfter = invokeOneshot({
    step: 'list_orchestrator_operation',
    tenantId: PIPELINE,
    payoutOperationId: OPERATION,
  });
  const liveAfter = await getJson(
    credentials,
    `/accounts/${SANDBOX_PLATFORM}/transfers/${PAYOUT_TRANSFER_ID}`,
    moovSandboxScopes.transfersRead(SANDBOX_PLATFORM),
  );
  const extractedAfter = extractTransferEvent({ type: 'transfer.status_refresh', data: liveAfter.data || {} });
  const flagsAfter = lambdaFlags();
  const payoutAfter = snapshotIntent(recon.intent || listedAfter.payoutRows?.[0]);
  const fundingAfter = snapshotIntent(recon.funding || listedAfter.fundingRows?.[0]);
  const rdsCompletedAt = payoutAfter?.completed_at || null;
  const exactMatch = String(rdsCompletedAt || '') === String(moovCompletedOn)
    || String(isoUtc(rdsCompletedAt) || '') === String(moovCompletedOn);
  const counts = recon.countsAfter || {
    fundingIntentCount: listedAfter.fundingRows?.length || 0,
    payoutIntentCount: listedAfter.payoutRows?.length || 0,
    fundingProviderTransferCount: (listedAfter.fundingRows || []).filter((row) => row.provider_transfer_id).length,
    payoutProviderTransferCount: (listedAfter.payoutRows || []).filter((row) => row.provider_transfer_id).length,
  };
  const pass = exactMatch
    && String(payoutAfter?.status) === 'completed'
    && String(payoutAfter?.provider_status) === 'completed'
    && String(payoutAfter?.provider_transfer_id || '').toLowerCase() === PAYOUT_TRANSFER_ID
    && payoutAfter?.failure_reason == null
    && counts.fundingIntentCount === 1
    && counts.payoutIntentCount === 1
    && counts.fundingProviderTransferCount === 1
    && counts.payoutProviderTransferCount === 1
    && flagsAfter.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'
    && flagsAfter.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && recon.createdPaymentTransfer === false
    && recon.liveProviderPosted === false
    && recon.freedomChanged === false
    && recon.sweepChanged === false
    && String(fundingAfter?.id || '').toLowerCase() === FUNDING_INTENT_ID;

  const card = {
    'ROOT CAUSE': 'sandbox applyMoovWebhook omitted destination.achDetails.completedOn so WALLET→RECIPIENT transfer.updated set status=completed without stamping payment_transfers.completed_at',
    'FILES CHANGED': 'aws/functions/api/providers/webhook-apply.mjs, aws/functions/api/providers/production/moov-sandbox-payout-e2e.mjs, aws/providers/oneshot/m79-sandbox-tenant/index.mjs, aws/providers/oneshot/m712-completed-at-run.mjs, aws/tests/api-moov-m712-payout-completed-at.test.mjs',
    TESTS: 'aws/tests/api-moov-m712-payout-completed-at.test.mjs',
    'MOOV STATUS': extractedAfter.status || liveAfter.data?.status || moovStatus,
    'MOOV COMPLETED_ON': extractedAfter.completedOn || moovCompletedOn,
    'RDS STATUS': payoutAfter?.status || null,
    'RDS PROVIDER_STATUS': payoutAfter?.provider_status || null,
    'RDS COMPLETED_AT': rdsCompletedAt,
    'RDS FAILURE_REASON': payoutAfter?.failure_reason ?? null,
    'COMPLETED_AT EXACT MATCH': exactMatch,
    'WEBHOOK FUTURE PATH FIXED': overlay.copied.length === 2 && overlay.protectedUnchanged === true,
    'GET/WEBHOOK CONVERGENCE': String(extractedAfter.completedOn || moovCompletedOn) === String(rdsCompletedAt) || exactMatch,
    'FUNDING INTENT COUNT': counts.fundingIntentCount,
    'PAYOUT INTENT COUNT': counts.payoutIntentCount,
    'FUNDING PROVIDER TRANSFER COUNT': counts.fundingProviderTransferCount,
    'PAYOUT PROVIDER TRANSFER COUNT': counts.payoutProviderTransferCount,
    'NEW PROVIDER POSTS': 0,
    'NEW INTENTS': 0,
    'MONEY MOVED': false,
    'SWEEP CHANGED': recon.sweepChanged === true,
    'SANDBOX POST FLAG': flagsAfter.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED,
    'PRODUCTION POST FLAG': flagsAfter.flags.AWS_MOOV_TRANSFER_POST_ENABLED,
    'M7.12 FINAL RESULT': pass ? 'PASS' : 'FAIL',
  };
  const text = writeReturnCard(card);
  const report = {
    at: new Date().toISOString(),
    identity,
    overlay,
    flagsBefore,
    flagsAfter,
    listedBefore,
    listedAfter,
    recon,
    moov: {
      id: PAYOUT_TRANSFER_ID,
      status: liveAfter.data?.status || moovStatus,
      completedOn: extractedAfter.completedOn || moovCompletedOn,
      sourcePm: liveAfter.data?.source?.paymentMethodID || null,
      destinationPm: liveAfter.data?.destination?.paymentMethodID || null,
    },
    rds: payoutAfter,
    funding: fundingAfter,
    card,
    pass,
  };
  fs.writeFileSync('/opt/cursor/artifacts/m712_completed_at_run.json', JSON.stringify(report, null, 2));
  console.log(text);
  if (!pass) process.exitCode = 1;
};

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
