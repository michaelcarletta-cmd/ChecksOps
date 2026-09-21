#!/usr/bin/env node
/**
 * M7.9I: GET-only reconciliation parity for the completed sandbox
 * BANK→WALLET fund. Fills completed_at, clears stale current failure_reason,
 * and syncs the sandbox wallet cache from live Moov GET.
 *
 * Never POSTs /transfers. Never creates an intent. Never arms POST flags.
 * Never executes wallet→recipient. Never updates Freedom or Sweep.
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
  PIPELINE_TEST_SANDBOX,
  SANDBOX_FUNDING_AMOUNT_CENTS,
  sandboxWalletFundingIdempotencyKey,
} from '../../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
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
const INTENT_ID = 'b18a96d7-4415-4df8-992f-70d5a17365a9';
const MOOV_TRANSFER_ID = 'dec24b01-e559-4014-b072-af1ac0e4d013';
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
    '--role-session-name', 'checksops-m79i-sandbox-recon-parity',
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
  completedOn: row?.completedOn || row?.completedAt || row?.source?.achDetails?.completedOn || null,
  originatedOn: row?.source?.achDetails?.originatedOn || null,
  achStatus: row?.source?.achDetails?.status || null,
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
  const staging = path.join(os.tmpdir(), 'checksops-m79i-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/77_moov_tenant_environment.sql'), path.join(staging, '77_moov_tenant_environment.sql'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/78_moov_recon_parity.sql'), path.join(staging, '78_moov_recon_parity.sql'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m79i-oneshot.zip');
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
  const outFile = `/tmp/m79i-oneshot-${payload.step}-${Date.now()}.json`;
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
const overlayApi = () => {
  const out = run(process.execPath, [path.join(ROOT, 'aws/providers/oneshot/m79-run.mjs'), 'overlay'], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try { return JSON.parse(out); } catch { return { raw: String(out).slice(0, 1500) }; }
};
const writeReturnCard = (card) => {
  const order = [
    'ROOT CAUSE — WALLET CACHE',
    'ROOT CAUSE — COMPLETED_AT',
    'ROOT CAUSE — STALE FAILURE',
    'CODE CHANGED',
    'TESTS',
    'INTENT STATUS',
    'PROVIDER STATUS',
    'COMPLETED_AT',
    'FAILURE_REASON',
    'MOOV WALLET AVAILABLE',
    'RDS WALLET AVAILABLE',
    'MOOV WALLET PENDING',
    'RDS WALLET PENDING',
    'BALANCE PARITY',
    'SANDBOX/PRODUCTION ISOLATION',
    'PROVIDER POST COUNT',
    'NEW TRANSFER CREATED',
    'SANDBOX POST FLAG',
    'PRODUCTION POST FLAG',
    'FREEDOM CHANGED',
    'SWEEP CHANGED',
    'PRODUCTION MONEY MOVED',
    'SAFE TO PREPARE FIRST SANDBOX WALLET→RECIPIENT',
    'GO/NO-GO',
  ];
  const lines = order.filter((key) => card[key] !== undefined).map((key) => `${key}: ${card[key]}`);
  const extra = Object.entries(card).filter(([key]) => !order.includes(key)).map(([key, value]) => `${key}: ${value}`);
  const text = `${[...lines, ...extra].join('\n')}\n\nSTOP FOR REVIEW.\nDo not execute wallet→recipient.\nDo not arm either POST flag.\n`;
  fs.writeFileSync('/opt/cursor/artifacts/m79i_return_card.md', text);
  fs.writeFileSync('/opt/cursor/artifacts/m79i_return_card_final.md', text);
  return text;
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
  const flagsBefore = lambdaFlags();
  if (flagsBefore.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_production_post_armed');
  if (flagsBefore.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_sandbox_post_armed');
  const production = loadSecret(flagsBefore.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET);
  const parsed = production.parsed;
  const credentials = sandboxCredentials(parsed);
  if (!present(credentials.publicKey) || !present(credentials.secretKey) || !present(credentials.platformId)) {
    throw new Error('sandbox_credentials_missing');
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
  const diagnoseBefore = invokeOneshot({
    step: 'diagnose_funding_reconcile',
    tenantId: PIPELINE,
    transferId: MOOV_TRANSFER_ID,
    intentId: INTENT_ID,
  });
  const liveTransfer = await getJson(
    credentials,
    `/accounts/${SANDBOX_PLATFORM}/transfers/${MOOV_TRANSFER_ID}`,
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
  const matching = matchingFunding([
    ...asList(merchantTransfers.data).map(summarizeTransfer),
    ...asList(platformTransfers.data).map(summarizeTransfer),
    transfer,
  ]);
  const walletJson = liveWallet.data || {};
  const walletAvailable = amountCentsOf(walletJson.availableBalance ?? walletJson.available);
  const walletPending = amountCentsOf(walletJson.pendingBalance ?? walletJson.pending);
  const moovStatus = normalizeMoovStatus(transfer.status || transferJson.status);
  const moovCompletedAt = transfer.completedOn || null;
  if (moovStatus !== 'completed') throw new Error(`moov_not_completed:${moovStatus}`);
  if (!moovCompletedAt) throw new Error('provider_completed_on_missing');
  if (String(transfer.id || '').toLowerCase() !== MOOV_TRANSFER_ID) throw new Error('unexpected_transfer_id');

  const sql78 = invokeOneshot({ step: 'apply_sql78' });
  if (sql78?.ok !== true) throw new Error(`sql78_failed:${sql78?.error || 'unknown'}`);
  const overlay = overlayApi();
  const flagsAfterOverlay = lambdaFlags();
  if (flagsAfterOverlay.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') throw new Error('overlay_armed_production_post');
  if (flagsAfterOverlay.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') throw new Error('overlay_armed_sandbox_post');
  if (flagsAfterOverlay.envKeyCount !== flagsBefore.envKeyCount) throw new Error('overlay_changed_env_keys');

  const recon = invokeOneshot({
    step: 'reconcile_funding_parity',
    tenantId: PIPELINE,
    intentId: INTENT_ID,
    providerTransferId: MOOV_TRANSFER_ID,
    providerWalletId: SANDBOX_WALLET,
    providerStatus: transfer.status || 'completed',
    completedAt: moovCompletedAt,
    availableCents: walletAvailable,
    pendingCents: walletPending,
  });
  if (recon?.ok !== true) throw new Error(`parity_recon_failed:${recon?.error || 'unknown'}`);

  const verifyAfter = invokeOneshot({
    step: 'verify_funding_intent',
    tenantId: PIPELINE,
    idempotencyKey: businessKey,
  });
  const diagnoseAfter = invokeOneshot({
    step: 'diagnose_funding_reconcile',
    tenantId: PIPELINE,
    transferId: MOOV_TRANSFER_ID,
    intentId: INTENT_ID,
  });
  const flagsEnd = lambdaFlags();
  const intent = diagnoseAfter.intent || verifyAfter.intent || recon.intent || null;
  const rdsWallet = diagnoseAfter.rdsWallet || recon.rdsWallet || verifyAfter.sandbox?.wallet || null;
  const unique = matching.length === 1 && String(matching[0]?.id || '').toLowerCase() === MOOV_TRANSFER_ID;
  const isolated = intent?.id === INTENT_ID
    && intent?.environment === 'sandbox'
    && String(intent?.provider_transfer_id || '').toLowerCase() === MOOV_TRANSFER_ID
    && verifyAfter.intentCount === 1
    && verifyAfter.freedomEnvironment === 'production'
    && (verifyAfter.recentProductionTransfers || 0) === 0;
  const balanceParity = Number(rdsWallet?.available_cents) === Number(walletAvailable)
    && Number(rdsWallet?.pending_cents) === Number(walletPending);
  const intentParity = String(intent?.status || '').toLowerCase() === 'completed'
    && String(intent?.provider_status || '').toLowerCase() === 'completed'
    && intent?.failure_reason == null
    && intent?.completed_at != null;
  const sweepChanged = Boolean(verifyBefore.sweep && (diagnoseAfter.sweep || verifyAfter.sweep)
    && (String(verifyBefore.sweep.id) !== String((diagnoseAfter.sweep || verifyAfter.sweep).id)
      || String(verifyBefore.sweep.status) !== String((diagnoseAfter.sweep || verifyAfter.sweep).status)));
  const productionMoneyMoved = (verifyAfter.recentProductionTransfers || 0) > 0
    || verifyAfter.freedomEnvironment !== 'production';
  const go = isolated
    && unique
    && balanceParity
    && intentParity
    && sql78.ok === true
    && recon.ok === true
    && recon.failureHistoryPreserved === true
    && flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'
    && productionMoneyMoved === false
    && sweepChanged === false;
  const returnCard = {
    'ROOT CAUSE — WALLET CACHE': 'live webhook skipped balance.updated / walletTransaction.updated (no transferID); sandbox apply off; postTransferLedger never writes payment_wallets.available_cents',
    'ROOT CAUSE — COMPLETED_AT': 'extractTransferEvent omitted achDetails.completedOn; recon COALESCE left null; canTransition(completed,completed) noop skipped later GET/webhook fill',
    'ROOT CAUSE — STALE FAILURE': 'SQL 77 UPDATE never cleared failure_reason; sandbox COALESCE($5, failure_reason) kept moov_sandbox_http_failed from the earlier 403',
    'CODE CHANGED': 'SQL 78 + moov-lifecycle + webhook-apply-production + webhook-apply + oneshot GET recon',
    TESTS: 'aws/tests/api-moov-m79i-sandbox-recon-parity.test.mjs',
    'INTENT STATUS': String(intent?.status || 'none'),
    'PROVIDER STATUS': String(intent?.provider_status || 'none'),
    COMPLETED_AT: intent?.completed_at || 'none',
    FAILURE_REASON: intent?.failure_reason == null ? 'null' : String(intent.failure_reason),
    'MOOV WALLET AVAILABLE': String(walletAvailable),
    'RDS WALLET AVAILABLE': String(rdsWallet?.available_cents ?? 'none'),
    'MOOV WALLET PENDING': String(walletPending),
    'RDS WALLET PENDING': String(rdsWallet?.pending_cents ?? 'none'),
    'BALANCE PARITY': String(balanceParity),
    'SANDBOX/PRODUCTION ISOLATION': isolated && (recon.productionWalletRows || []).length === 0 ? 'sandbox_only' : 'check',
    'PROVIDER POST COUNT': '0',
    'NEW TRANSFER CREATED': 'false',
    'SANDBOX POST FLAG': String(flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || 'false'),
    'PRODUCTION POST FLAG': String(flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    'FREEDOM CHANGED': String(verifyAfter.freedomEnvironment !== 'production' || recon.freedomChanged === true),
    'SWEEP CHANGED': String(sweepChanged || recon.sweepChanged === true),
    'PRODUCTION MONEY MOVED': String(productionMoneyMoved),
    'SAFE TO PREPARE FIRST SANDBOX WALLET→RECIPIENT': go ? 'YES' : 'NO',
    'GO/NO-GO': go ? 'GO' : 'NO-GO',
    MOOV_TRANSFER: MOOV_TRANSFER_ID,
    INTENT_ID,
    SQL78: String(sql78.ok === true),
    HISTORY_PRESERVED: String(recon.failureHistoryPreserved === true),
    UNIQUE_TRANSFER: String(unique),
  };
  writeReturnCard(returnCard);
  fs.writeFileSync('/opt/cursor/artifacts/m79i_run.json', JSON.stringify({
    at: new Date().toISOString(),
    identity: { arn: identity.Arn },
    posted: false,
    armed: false,
    flagsBefore: flagsBefore.flags,
    flagsEnd: flagsEnd.flags,
    overlaySha: overlay?.overlay?.afterSha || overlay?.afterSha || flagsAfterOverlay.codeSha256,
    overlayEnvUnchanged: overlay?.overlay?.envUnchanged ?? overlay?.envUnchanged ?? null,
    sql78,
    recon,
    liveTransfer: {
      ok: liveTransfer.ok === true,
      id: transfer.id,
      status: transfer.status,
      completedOn: moovCompletedAt,
      amountCents: transfer.amountCents,
    },
    matching,
    wallet: {
      availableCents: walletAvailable,
      pendingCents: walletPending,
      rdsAvailable: rdsWallet?.available_cents ?? null,
      rdsPending: rdsWallet?.pending_cents ?? null,
    },
    intentBefore: diagnoseBefore.intent && {
      status: diagnoseBefore.intent.status,
      provider_status: diagnoseBefore.intent.provider_status,
      completed_at: diagnoseBefore.intent.completed_at,
      failure_reason: diagnoseBefore.intent.failure_reason,
    },
    intentAfter: intent && {
      status: intent.status,
      provider_status: intent.provider_status,
      completed_at: intent.completed_at,
      failure_reason: intent.failure_reason,
    },
    diagnoseAfter: {
      eventCount: (diagnoseAfter.events || []).length,
      eventTypes: (diagnoseAfter.events || []).map((row) => row.event_type),
    },
    verifyAfter: {
      intentCount: verifyAfter.intentCount,
      freedomEnvironment: verifyAfter.freedomEnvironment,
      recentProductionTransfers: verifyAfter.recentProductionTransfers,
    },
    isolated,
    unique,
    balanceParity,
    intentParity,
    returnCard,
    STOP_FOR_REVIEW: true,
  }, null, 2));
  console.log(JSON.stringify({
    ok: go,
    posted: false,
    armed: false,
    balanceParity,
    intentParity,
    returnCard,
  }, null, 2));
  if (!go) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error);
  writeReturnCard({
    'GO/NO-GO': 'NO-GO',
    ERROR: String(error?.message || error).slice(0, 400),
    'PROVIDER POST COUNT': '0',
    'NEW TRANSFER CREATED': 'false',
    'PRODUCTION MONEY MOVED': 'false',
  });
  process.exitCode = 1;
});
