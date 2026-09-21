#!/usr/bin/env node
/**
 * M7.9H.3: GET-only reconcile of completed sandbox BANK→WALLET fund
 * dec24b01-e559-4014-b072-af1ac0e4d013 on intent
 * b18a96d7-4415-4df8-992f-70d5a17365a9.
 *
 * Never POSTs /transfers. Never creates an intent. Never arms POST flags.
 * Never updates the funding intent. Never executes wallet→recipient.
 * If Moov is completed and ChecksOps is still pending, diagnose the
 * webhook/reconciliation gap instead of forcing completed.
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
const PREFERRED_WEBHOOK_URL = 'https://checksops.com/prep/webhooks/moov';
const LIVE_ORIGIN = PRODUCTION_MOOV_ORIGIN;
const PROVEN_API_VERSION = PRODUCTION_MOOV_API_VERSION;
const COMPLETED = new Set(['completed']);

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
    '--role-session-name', 'checksops-m79h3-sandbox-fund-complete',
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
  completedOn: row?.completedOn || row?.completedAt || null,
  originatedOn: row?.source?.achDetails?.originatedOn || null,
  achStatus: row?.source?.achDetails?.status || null,
  initiatedOn: row?.source?.achDetails?.initiatedOn || null,
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
  const dryRunRaw = env.AWS_PROVIDER_WEBHOOK_DRY_RUN;
  const webhookDryRun = dryRunRaw === undefined || dryRunRaw === '' || String(dryRunRaw) !== 'false';
  return {
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
      AWS_PROVIDER_WEBHOOK_DRY_RUN: dryRunRaw === undefined ? null : dryRunRaw,
      AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED || null,
      AWS_PROVIDER_EXECUTION_ENABLED: env.AWS_PROVIDER_EXECUTION_ENABLED || null,
      AWS_FINANCIAL_PERMISSIONS_ACTIVATED: env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || null,
    },
    webhookDryRun,
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
  const staging = path.join(os.tmpdir(), 'checksops-m79h3-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/77_moov_tenant_environment.sql'), path.join(staging, '77_moov_tenant_environment.sql'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m79h3-oneshot.zip');
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
  const outFile = `/tmp/m79h3-oneshot-${payload.step}-${Date.now()}.json`;
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
    status: row.status || null,
    events: row.eventTypes || row.events || [],
    lastUsedOn: row.lastUsedOn || row.lastUsed || null,
    webhookID: row.webhookID || row.webhookId || row.id || null,
  }));
  const webhook = rows.find((row) => String(row.url || '').replace(/\/$/, '') === PREFERRED_WEBHOOK_URL.replace(/\/$/, ''));
  return {
    listed: res.ok === true,
    status: res.status,
    webhook: webhook || null,
    healthy: Boolean(webhook && webhook.disabled !== true),
    rows: rows.map((row) => ({
      url: row.url,
      disabled: row.disabled,
      status: row.status,
      events: row.events,
      lastUsedOn: row.lastUsedOn,
    })),
  };
};
const cloudWatchWebhook = (startMs) => {
  const groups = [
    '/aws/lambda/checksops-production-prep-api',
    '/aws/apigateway/checksops-production-prep-http',
  ];
  const patterns = ['moov_webhook', 'webhooks/moov', MOOV_TRANSFER_ID];
  const hits = [];
  for (const group of groups) {
    for (const pattern of patterns) {
      try {
        const out = awsJson([
          'logs', 'filter-log-events',
          '--log-group-name', group,
          '--start-time', String(startMs),
          '--filter-pattern', pattern,
          '--limit', '20',
        ]);
        for (const event of out.events || []) {
          hits.push({
            group,
            pattern,
            timestamp: event.timestamp || null,
            message: String(event.message || '').slice(0, 400),
          });
        }
      } catch (error) {
        hits.push({
          group,
          pattern,
          error: String(error?.stderr || error?.message || error).slice(0, 200),
        });
      }
    }
  }
  return hits.slice(0, 40);
};
const diagnoseGap = ({
  moovCompleted,
  intentCompleted,
  tenantReceipts,
  transferIdReceipts,
  events,
  webhookDryRun,
  webhookHealthy,
  webhookLastUsedOn,
  cloudWatchHits,
}) => {
  if (!moovCompleted) return 'moov_not_completed';
  if (intentCompleted) return 'none_intent_already_completed';
  const liveHits = (cloudWatchHits || []).filter((row) => /moov_webhook_accepted|applied":true/.test(row.message || ''));
  const rejectedHits = (cloudWatchHits || []).filter((row) => /invalid_signature|moov_webhook_verify/.test(row.message || ''));
  if ((tenantReceipts || []).some((row) => row.dry_run === true) && webhookDryRun) {
    return 'webhook_received_but_AWS_PROVIDER_WEBHOOK_DRY_RUN_prevents_apply';
  }
  if ((tenantReceipts || []).length > 0 && !(tenantReceipts || []).some((row) => row.dry_run === false)) {
    return 'tenant_receipts_exist_all_dry_run';
  }
  if ((tenantReceipts || []).some((row) => row.dry_run === false) && (events || []).length === 0) {
    return 'receipt_stored_live_but_payment_event_log_missing';
  }
  if ((transferIdReceipts || []).length === 0 && (tenantReceipts || []).length > 0) {
    return 'receipts_exist_for_tenant_but_keyed_by_event_uuid_not_transfer_id';
  }
  if ((tenantReceipts || []).length === 0 && liveHits.length === 0 && rejectedHits.length > 0) {
    return 'webhook_http_reached_lambda_but_signature_rejected';
  }
  if ((tenantReceipts || []).length === 0 && liveHits.length === 0) {
    if (!webhookHealthy) return 'preferred_webhook_subscription_missing_or_disabled';
    return `no_receipt_and_no_lambda_accept_log; subscription_lastUsedOn=${webhookLastUsedOn || 'none'}`;
  }
  return 'moov_completed_checksops_pending_unclassified';
};
const writeReturnCard = (card) => {
  const order = [
    'MOOV_STATUS',
    'ORIGINATED_ON',
    'COMPLETED_ON',
    'INTENT_STATUS',
    'WEBHOOK_RECEIPT',
    'WEBHOOK_APPLIED',
    'WALLET_AVAILABLE',
    'WALLET_PENDING',
    'TRANSFER_COUNT',
    'SECOND_POST',
    'SANDBOX_POST_FLAG',
    'PRODUCTION_POST_FLAG',
    'FREEDOM_CHANGED',
    'SWEEP_CHANGED',
    'PRODUCTION_MONEY_MOVED',
    'FUNDING_LEG_FULLY_RECONCILED',
    'SAFE_TO_PREPARE_WALLET_RECIPIENT',
    'GO_NO_GO',
  ];
  const lines = order.filter((key) => card[key] !== undefined).map((key) => `${key}: ${card[key]}`);
  const extra = Object.entries(card).filter(([key]) => !order.includes(key)).map(([key, value]) => `${key}: ${value}`);
  const text = `${[...lines, ...extra].join('\n')}\n\nSTOP FOR REVIEW.\nDo not execute wallet→recipient.\nDo not arm either POST flag.\n`;
  fs.writeFileSync('/opt/cursor/artifacts/m79h3_return_card.md', text);
  fs.writeFileSync('/opt/cursor/artifacts/m79h3_return_card_final.md', text);
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
  const flags = lambdaFlags();
  if (flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_production_post_armed');
  if (flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_sandbox_post_armed');
  const production = loadSecret(flags.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET);
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
  ensureOneshot(zip, adminSecret.ARN, flags.vpc);

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
  const webhooks = await inspectWebhooks(credentials);
  const receiptsById = invokeOneshot({
    step: 'webhook_receipts',
    eventIds: [MOOV_TRANSFER_ID, INTENT_ID],
  });
  const diagnose = invokeOneshot({
    step: 'diagnose_funding_reconcile',
    tenantId: PIPELINE,
    transferId: MOOV_TRANSFER_ID,
    intentId: INTENT_ID,
  });

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
  const originatedOn = transfer.originatedOn || transferJson.source?.achDetails?.originatedOn || null;
  const intent = diagnose.intent || verifyBefore.intent || null;
  const exactTransfer = String(transfer.id || '').toLowerCase() === MOOV_TRANSFER_ID
    && transfer.amountCents === 1
    && String(transfer.sourcePm || '').toLowerCase() === SANDBOX_FUND_PM
    && String(transfer.destinationPm || '').toLowerCase() === SANDBOX_WALLET_PM;
  const unique = matching.length === 1 && String(matching[0]?.id || '').toLowerCase() === MOOV_TRANSFER_ID;
  const isolated = intent?.id === INTENT_ID
    && intent?.environment === 'sandbox'
    && String(intent?.provider_transfer_id || '').toLowerCase() === MOOV_TRANSFER_ID
    && verifyBefore.intentCount === 1
    && verifyBefore.freedomEnvironment === 'production'
    && (verifyBefore.recentProductionTransfers || 0) === 0
    && flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true';

  const startMs = Date.parse(transferJson.createdOn || '2026-09-21T00:16:23Z') || Date.parse('2026-09-21T00:16:23Z');
  const cloudWatchHits = cloudWatchWebhook(startMs);
  const tenantReceipts = diagnose.tenantReceipts || [];
  const transferIdReceipts = [
    ...(receiptsById.rows || []),
    ...(diagnose.transferIdReceipts || []),
  ];
  const webhookFound = tenantReceipts.length > 0 || transferIdReceipts.length > 0;
  const webhookApplied = tenantReceipts.some((row) => row.dry_run === false && String(row.mapped_tenant_id || '') === PIPELINE)
    || transferIdReceipts.some((row) => row.dry_run === false && String(row.mapped_tenant_id || '') === PIPELINE);
  const intentCompleted = String(intent?.status || '').toLowerCase() === 'completed';
  const moovCompleted = COMPLETED.has(moovStatus) && exactTransfer;
  const gap = diagnoseGap({
    moovCompleted,
    intentCompleted,
    tenantReceipts,
    transferIdReceipts,
    events: diagnose.events || [],
    webhookDryRun: flags.webhookDryRun,
    webhookHealthy: webhooks.healthy,
    webhookLastUsedOn: webhooks.webhook?.lastUsedOn || null,
    cloudWatchHits,
  });

  const verifyAfter = invokeOneshot({
    step: 'verify_funding_intent',
    tenantId: PIPELINE,
    idempotencyKey: businessKey,
  });
  const flagsEnd = lambdaFlags();
  const rdsWallet = diagnose.rdsWallet || verifyAfter.sandbox?.wallet || verifyBefore.sandbox?.wallet || null;
  const intentAfter = verifyAfter.intent || intent;
  const intentStatus = intentAfter?.status || 'none';
  const fundingFullyReconciled = moovCompleted
    && exactTransfer
    && unique
    && isolated
    && String(intentStatus).toLowerCase() === 'completed'
    && walletAvailable >= 1;
  const sweepChanged = Boolean(verifyBefore.sweep && (diagnose.sweep || verifyAfter.sweep)
    && (String(verifyBefore.sweep.id) !== String((diagnose.sweep || verifyAfter.sweep).id)
      || String(verifyBefore.sweep.status) !== String((diagnose.sweep || verifyAfter.sweep).status)));
  const productionMoneyMoved = (verifyAfter.recentProductionTransfers || 0) > 0
    || verifyAfter.freedomEnvironment !== 'production';
  const returnCard = {
    MOOV_STATUS: moovStatus || transfer.status || 'unknown',
    ORIGINATED_ON: originatedOn || 'none',
    COMPLETED_ON: moovCompletedAt || 'none',
    INTENT_STATUS: intentStatus,
    WEBHOOK_RECEIPT: webhookFound ? 'true' : 'false',
    WEBHOOK_APPLIED: webhookApplied ? 'true' : 'false',
    WALLET_AVAILABLE: String(walletAvailable),
    WALLET_PENDING: String(walletPending),
    TRANSFER_COUNT: String(matching.length),
    SECOND_POST: 'false',
    SANDBOX_POST_FLAG: String(flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || 'false'),
    PRODUCTION_POST_FLAG: String(flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    FREEDOM_CHANGED: String(verifyAfter.freedomEnvironment !== 'production'),
    SWEEP_CHANGED: String(sweepChanged),
    PRODUCTION_MONEY_MOVED: String(productionMoneyMoved),
    FUNDING_LEG_FULLY_RECONCILED: String(fundingFullyReconciled),
    SAFE_TO_PREPARE_WALLET_RECIPIENT: fundingFullyReconciled ? 'REVIEW' : 'NO',
    GO_NO_GO: 'NO-GO',
    MOOV_TRANSFER: MOOV_TRANSFER_ID,
    INTENT_ID: INTENT_ID,
    ACH_STATUS: transfer.achStatus || transferJson.source?.achDetails?.status || 'none',
    INTENT_MUTATED: 'false',
    WEBHOOK_DRY_RUN: String(flagsEnd.webhookDryRun),
    WEBHOOK_GAP: gap,
    RDS_WALLET_AVAILABLE: String(rdsWallet?.available_cents ?? 'none'),
    UNIQUE_TRANSFER: String(unique),
  };
  writeReturnCard(returnCard);
  fs.writeFileSync('/opt/cursor/artifacts/m79h3_run.json', JSON.stringify({
    at: new Date().toISOString(),
    identity: { arn: identity.Arn },
    posted: false,
    armed: false,
    intentMutated: false,
    flags: flagsEnd.flags,
    webhookDryRun: flagsEnd.webhookDryRun,
    liveTransfer: {
      ok: liveTransfer.ok === true,
      statusCode: liveTransfer.statusCode || null,
      id: transfer.id,
      status: transfer.status,
      amountCents: transfer.amountCents,
      sourcePm: transfer.sourcePm,
      destinationPm: transfer.destinationPm,
      completedOn: moovCompletedAt,
      originatedOn,
      achStatus: transfer.achStatus,
      exactTransfer,
    },
    matching,
    wallet: {
      id: walletJson.walletID || walletJson.walletId || SANDBOX_WALLET,
      status: walletJson.status || null,
      availableCents: walletAvailable,
      pendingCents: walletPending,
      rdsAvailable: rdsWallet?.available_cents || null,
      rdsPending: rdsWallet?.pending_cents || null,
    },
    intent: {
      id: intentAfter?.id || null,
      status: intentStatus,
      provider_transfer_id: intentAfter?.provider_transfer_id || null,
      completed_at: intentAfter?.completed_at || null,
      provider_status: intentAfter?.provider_status || null,
      failure_reason: intentAfter?.failure_reason || null,
      intentCount: verifyAfter.intentCount,
      mutated: false,
    },
    webhooks,
    receiptsById: {
      ok: receiptsById.ok === true,
      count: (receiptsById.rows || []).length,
      eventTypes: (receiptsById.rows || []).map((row) => row.event_type),
    },
    diagnose: {
      tenantReceiptCount: tenantReceipts.length,
      transferIdReceiptCount: (diagnose.transferIdReceipts || []).length,
      eventCount: (diagnose.events || []).length,
      eventTypes: (diagnose.events || []).map((row) => row.event_type),
      tenantReceipts: tenantReceipts.map((row) => ({
        event_type: row.event_type,
        dry_run: row.dry_run,
        received_at: row.received_at,
        mapped_tenant_id: row.mapped_tenant_id,
      })),
      receiptSummary: diagnose.receiptSummary || [],
    },
    cloudWatchHits,
    gap,
    fundingFullyReconciled,
    isolated,
    unique,
    returnCard,
    STOP_FOR_REVIEW: true,
  }, null, 2));
  console.log(JSON.stringify({
    ok: liveTransfer.ok === true && isolated && unique && flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true',
    posted: false,
    armed: false,
    intentMutated: false,
    fundingFullyReconciled,
    gap,
    returnCard,
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  writeReturnCard({
    MOOV_STATUS: 'unknown',
    GO_NO_GO: 'NO-GO',
    ERROR: String(error?.message || error).slice(0, 400),
    SECOND_POST: 'false',
    PRODUCTION_MONEY_MOVED: 'false',
    INTENT_MUTATED: 'false',
  });
  process.exitCode = 1;
});
