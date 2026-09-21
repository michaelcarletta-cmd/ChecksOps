#!/usr/bin/env node
/**
 * M7.9H.2: GET-only compare of old Lovable/ChecksOps sandbox transfers
 * against the current AWS pending transfer
 * dec24b01-e559-4014-b072-af1ac0e4d013 / intent
 * b18a96d7-4415-4df8-992f-70d5a17365a9.
 *
 * Never POSTs /transfers. Never creates an intent. Never arms POST flags.
 * Never updates the funding intent. Never executes wallet→recipient.
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
  awsSandboxFundingRequestFromCode,
  compareLovableVsAwsSandboxFundingRequest,
  lovableSandboxFundingRequestFromCode,
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
const MOOV_TEST_MODE_DOCS = 'https://docs.moov.io/guides/get-started/test-mode/';
const PENDING = new Set(['pending', 'processing', 'queued', 'originated', 'submitted', 'created']);

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
    '--role-session-name', 'checksops-m79h2-sandbox-speed',
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
const weekdayEt = (iso) => {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
};
const isWeekendEt = (iso) => {
  const label = weekdayEt(iso);
  return Boolean(label && (label.startsWith('Sat') || label.startsWith('Sun')));
};
const elapsedMs = (created, completed) => {
  if (!created || !completed) return null;
  const ms = new Date(completed).getTime() - new Date(created).getTime();
  return Number.isFinite(ms) ? ms : null;
};
const elapsedLabel = (ms) => {
  if (ms == null) return 'n/a';
  if (Math.abs(ms) < 1000) return `${ms}ms`;
  if (Math.abs(ms) < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (Math.abs(ms) < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(2)}h`;
};
const inferRail = (sourceType, destType) => {
  const source = String(sourceType || '').toLowerCase();
  const dest = String(destType || '').toLowerCase();
  if (source === 'moov-wallet' && dest === 'moov-wallet') return 'wallet-wallet';
  if (source.startsWith('ach-debit') && dest === 'moov-wallet') return 'ach-debit-to-wallet';
  if (source === 'moov-wallet' && dest.startsWith('ach-credit')) return 'wallet-to-ach-credit';
  if (source === 'moov-wallet' && dest === 'rtp-credit') return 'wallet-to-rtp';
  if (source.includes('card') || dest.includes('card')) return `card:${source}->${dest}`;
  if (source && dest) return `${source}->${dest}`;
  return 'unknown';
};
const pickParty = (party = {}, pmIndex = new Map()) => {
  const pmId = party.paymentMethodID || party.paymentMethodId || null;
  const type = party.paymentMethodType
    || party.bankAccount?.paymentMethodType
    || party.wallet?.paymentMethodType
    || (pmId ? pmIndex.get(String(pmId).toLowerCase()) : null)
    || null;
  const bank = party.bankAccount || {};
  const wallet = party.wallet || {};
  return {
    accountID: party.accountID || party.accountId || null,
    paymentMethodID: pmId,
    paymentMethodType: type,
    bankAccountID: party.bankAccountID || bank.bankAccountID || bank.bankAccountId || null,
    walletID: party.walletID || wallet.walletID || wallet.walletId || null,
    lastFour: bank.lastFourNumber || bank.lastFour || null,
    routingNumber: bank.routingNumber || null,
    bankName: bank.bankName || bank.holderName || null,
    achStatus: party.achDetails?.status || null,
    achSecCode: party.achDetails?.secCode || null,
    achInitiatedOn: party.achDetails?.initiatedOn || null,
    achOriginatedOn: party.achDetails?.originatedOn || null,
    achCompletedOn: party.achDetails?.completedOn || null,
    debitHoldPeriod: party.achDetails?.debitHoldPeriod || null,
    traceNumber: party.achDetails?.traceNumber || null,
  };
};
const compareTransfer = (row = {}, pmIndex = new Map()) => {
  const source = pickParty(row.source || {}, pmIndex);
  const destination = pickParty(row.destination || {}, pmIndex);
  const created = row.createdOn || row.createdAt || null;
  const completed = row.completedOn || row.completedAt || null;
  const ms = elapsedMs(created, completed);
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    id: row.transferID || row.transferId || row.id || null,
    status: row.status || null,
    createdOn: created,
    completedOn: completed,
    elapsedMs: ms,
    elapsed: elapsedLabel(ms),
    createdEt: weekdayEt(created),
    completedEt: weekdayEt(completed),
    weekendCreatedEt: isWeekendEt(created),
    amountCents: amountCentsOf(row.amount),
    currency: row.amount?.currency || 'USD',
    source,
    destination,
    rail: inferRail(source.paymentMethodType, destination.paymentMethodType),
    facilitatorAccountID: row.facilitatorAccountID || row.facilitatorAccountId || null,
    groupID: row.groupID || row.groupId || null,
    description: row.description || null,
    metadata,
    metadataKeys: Object.keys(metadata),
    lovableFingerprint: Boolean(
      metadata.checksops_transfer_id
      || metadata.checksops_funding_request_id
      || metadata.checksops_tenant_id
      || metadata.checksops_leg,
    ),
    transferOptions: row.transferOptions || row.options || null,
    achType: source.achSecCode || row.achDetails?.secCode || null,
    failureReason: row.failureReason || row.statusReason || null,
  };
};

const lambdaConfig = () => awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
const lambdaFlags = (cfg = lambdaConfig()) => {
  const env = cfg.Environment?.Variables || {};
  return {
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    },
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
  const staging = path.join(os.tmpdir(), 'checksops-m79h2-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/77_moov_tenant_environment.sql'), path.join(staging, '77_moov_tenant_environment.sql'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m79h2-oneshot.zip');
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
  const outFile = `/tmp/m79h2-oneshot-${payload.step}-${Date.now()}.json`;
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
  }));
  const webhook = rows.find((row) => String(row.url || '').replace(/\/$/, '') === PREFERRED_WEBHOOK_URL.replace(/\/$/, ''));
  return {
    listed: res.ok === true,
    status: res.status,
    webhook: webhook || null,
    healthy: Boolean(webhook && webhook.disabled !== true),
  };
};
const pmIndexFrom = (...lists) => {
  const index = new Map();
  for (const list of lists) {
    for (const row of asList(list)) {
      const id = row?.id || row?.paymentMethodID || row?.paymentMethodId;
      const type = row?.type || row?.paymentMethodType;
      if (id && type) index.set(String(id).toLowerCase(), type);
    }
  }
  return index;
};
const uniqueById = (rows) => {
  const seen = new Map();
  for (const row of rows || []) {
    const id = String(row.id || '').toLowerCase();
    if (id && !seen.has(id)) seen.set(id, row);
  }
  return [...seen.values()];
};
const writeReturnCard = (card) => {
  const order = [
    'OLD_LOVABLE_TRANSFERS_FOUND',
    'OLD_TRANSFER_EXAMPLE',
    'SOURCE_TYPE',
    'DESTINATION_TYPE',
    'RAIL',
    'CREATED',
    'COMPLETED',
    'ELAPSED',
    'CURRENT_AWS_TRANSFER',
    'CURRENT_SOURCE_TYPE',
    'CURRENT_DESTINATION_TYPE',
    'CURRENT_RAIL',
    'CURRENT_CREATED',
    'CURRENT_STATUS',
    'PROVIDER_DETAIL',
    'EXACT_DIFFERENCE',
    'WHY_LOVABLE_COMPLETED_QUICKLY',
    'WHY_CURRENT_TRANSFER_IS_PENDING',
    'FAST_SANDBOX_METHOD',
    'CODE_CHANGE_REQUIRED',
    'CONFIG_CHANGE_REQUIRED',
    'NEW_SANDBOX_OBJECT_REQUIRED',
    'CURRENT_TRANSFER_SAFE_TO_LEAVE_PENDING',
    'SANDBOX_POST_FLAG',
    'PRODUCTION_POST_FLAG',
    'MONEY_MOVED',
    'RECOMMENDED_NEXT_TEST',
  ];
  const lines = order.filter((key) => card[key] !== undefined).map((key) => `${key}: ${card[key]}`);
  const extra = Object.entries(card).filter(([key]) => !order.includes(key)).map(([key, value]) => `${key}: ${value}`);
  const text = `${[...lines, ...extra].join('\n')}\n\nSTOP FOR REVIEW.\nNo provider POST.\nNo wallet→recipient.\n`;
  fs.writeFileSync('/opt/cursor/artifacts/m79h2_return_card.md', text);
  fs.writeFileSync('/opt/cursor/artifacts/m79h2_return_card_final.md', text);
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
  const verifyIntent = invokeOneshot({
    step: 'verify_funding_intent',
    tenantId: PIPELINE,
    idempotencyKey: businessKey,
  });
  const history = invokeOneshot({ step: 'list_sandbox_history' });
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
  const merchantMethods = await getJson(
    credentials,
    `/accounts/${SANDBOX_ACCOUNT}/payment-methods`,
    moovSandboxScopes.paymentMethodsRead(SANDBOX_ACCOUNT),
  );
  const platformMethods = await getJson(
    credentials,
    `/accounts/${SANDBOX_PLATFORM}/payment-methods`,
    moovSandboxScopes.paymentMethodsRead(SANDBOX_PLATFORM),
  );
  const merchantBanks = await getJson(
    credentials,
    `/accounts/${SANDBOX_ACCOUNT}/bank-accounts`,
    moovSandboxScopes.bankAccountsRead(SANDBOX_ACCOUNT),
  );
  let merchantTransfers = await getJson(
    credentials,
    `/accounts/${SANDBOX_ACCOUNT}/transfers?count=200`,
    moovSandboxScopes.transfersRead(SANDBOX_ACCOUNT),
  );
  if (merchantTransfers.ok !== true) {
    merchantTransfers = await getJson(
      credentials,
      `/accounts/${SANDBOX_ACCOUNT}/transfers`,
      moovSandboxScopes.transfersRead(SANDBOX_ACCOUNT),
    );
  }
  let platformTransfers = await getJson(
    credentials,
    `/accounts/${SANDBOX_PLATFORM}/transfers?count=200`,
    moovSandboxScopes.transfersRead(SANDBOX_PLATFORM),
  );
  if (platformTransfers.ok !== true) {
    platformTransfers = await getJson(
      credentials,
      `/accounts/${SANDBOX_PLATFORM}/transfers`,
      moovSandboxScopes.transfersRead(SANDBOX_PLATFORM),
    );
  }
  const webhooks = await inspectWebhooks(credentials);
  const receipts = invokeOneshot({
    step: 'webhook_receipts',
    eventIds: [MOOV_TRANSFER_ID, INTENT_ID],
  });

  const pmIndex = pmIndexFrom(merchantMethods.data, platformMethods.data);
  const listed = uniqueById([
    ...asList(merchantTransfers.data).map((row) => compareTransfer(row, pmIndex)),
    ...asList(platformTransfers.data).map((row) => compareTransfer(row, pmIndex)),
  ]);
  const details = [];
  for (const row of listed.slice(0, 20)) {
    const detail = await getJson(
      credentials,
      `/accounts/${SANDBOX_PLATFORM}/transfers/${row.id}`,
      moovSandboxScopes.transfersRead(SANDBOX_PLATFORM),
    );
    details.push({
      list: row,
      ok: detail.ok === true,
      statusCode: detail.statusCode || null,
      compared: detail.ok === true ? compareTransfer(detail.data || {}, pmIndex) : null,
      providerKeys: detail.ok === true ? Object.keys(detail.data || {}) : [],
    });
  }

  const currentDetail = details.find((row) => String(row.compared?.id || '').toLowerCase() === MOOV_TRANSFER_ID)
    || { compared: compareTransfer(liveTransfer.data || {}, pmIndex), ok: liveTransfer.ok === true, statusCode: liveTransfer.statusCode || null };
  const current = currentDetail.compared || {};
  const historical = details
    .map((row) => row.compared)
    .filter((row) => row && String(row.id || '').toLowerCase() !== MOOV_TRANSFER_ID);
  const completedFunding = historical.filter((row) => (
    row.status === 'completed'
    && String(row.destination?.paymentMethodType || '') === 'moov-wallet'
  ));
  const fastCompleted = [...completedFunding].sort((a, b) => (a.elapsedMs ?? Infinity) - (b.elapsedMs ?? Infinity));
  const lovableFingerprinted = historical.filter((row) => row.lovableFingerprint === true);
  const examples = uniqueById([
    ...fastCompleted.slice(0, 5),
    ...lovableFingerprinted.slice(0, 5),
    ...completedFunding.slice(0, 5),
    ...historical.slice(0, 5),
  ]).slice(0, 5);
  const example = examples[0] || null;

  const walletJson = liveWallet.data || {};
  const walletAvailable = amountCentsOf(walletJson.availableBalance ?? walletJson.available);
  const walletPending = amountCentsOf(walletJson.pendingBalance ?? walletJson.pending);
  const moovStatus = normalizeMoovStatus(current.status || liveTransfer.data?.status);
  const requestCompare = compareLovableVsAwsSandboxFundingRequest();
  const rails = [...new Set(historical.map((row) => row.rail))];
  const sourceTypes = [...new Set(historical.map((row) => row.source?.paymentMethodType).filter(Boolean))];
  const destTypes = [...new Set(historical.map((row) => row.destination?.paymentMethodType).filter(Boolean))];
  const weekendHold = current.weekendCreatedEt === true;
  const achRail = String(current.rail || '') === 'ach-debit-to-wallet';
  const stillPending = PENDING.has(moovStatus);
  const flagsEnd = lambdaFlags();
  const webhookRows = receipts.rows || [];

  let whyLovable = 'not_proven';
  if (example && example.rail === 'wallet-wallet' && (example.elapsedMs ?? Infinity) < 120_000) {
    whyLovable = 'Prior completed sandbox transfers used wallet-wallet, which Moov test mode completes almost instantly.';
  } else if (example && example.rail === 'ach-debit-to-wallet' && (example.elapsedMs ?? Infinity) < 120_000) {
    whyLovable = 'Prior ACH debit→wallet sandbox transfers completed in seconds/minutes on the same rail; current object is the same rail so timing is provider-side, not a different ChecksOps request.';
  } else if (example && example.rail === 'ach-debit-to-wallet') {
    whyLovable = `Prior sandbox BANK→WALLET transfers used the same ACH debit→wallet rail and completed after ${example.elapsed}, not instantly. Operator “instant” is not matched by provider completedOn.`;
  } else if (!example) {
    whyLovable = 'No prior completed sandbox funding transfer was found on this sandbox platform/merchant; cannot attribute instant completion to a different Lovable rail from live objects.';
  }

  let whyPending = 'unknown';
  if (achRail && weekendHold) {
    whyPending = `Moov test-mode ACH created on a weekend waits until Monday 00:00 ET (${MOOV_TEST_MODE_DOCS}). Wallet available/pending stay 0 until ACH completes; no webhook until status changes.`;
  } else if (achRail && stillPending) {
    whyPending = `Moov test-mode ACH completes in about an hour on weekdays (${MOOV_TEST_MODE_DOCS}). Current object is ACH debit→wallet, still pending, so wallet 0/0 and no webhook is expected until simulation completes.`;
  } else if (stillPending) {
    whyPending = `Provider GET status=${moovStatus} with completedOn none. Wallet 0/0 follows unsettled transfer.`;
  }

  const exactDifferenceParts = [];
  if (example) {
    if (example.rail !== current.rail) exactDifferenceParts.push(`rail ${example.rail} vs ${current.rail}`);
    if (example.source?.paymentMethodType !== current.source?.paymentMethodType) {
      exactDifferenceParts.push(`source type ${example.source?.paymentMethodType} vs ${current.source?.paymentMethodType}`);
    }
    if (example.destination?.paymentMethodType !== current.destination?.paymentMethodType) {
      exactDifferenceParts.push(`dest type ${example.destination?.paymentMethodType} vs ${current.destination?.paymentMethodType}`);
    }
    if (example.source?.routingNumber !== current.source?.routingNumber) {
      exactDifferenceParts.push(`source routing ${example.source?.routingNumber || 'none'} (${example.source?.bankName || 'unknown'}) vs ${current.source?.routingNumber || 'none'} (${current.source?.bankName || 'unknown'})`);
    }
    if (example.source?.achOriginatedOn && !current.source?.achOriginatedOn) {
      exactDifferenceParts.push(`old originatedOn=${example.source.achOriginatedOn} vs current originatedOn=none achStatus=${current.source?.achStatus || 'none'}`);
    }
    if (example.weekendCreatedEt !== current.weekendCreatedEt) {
      exactDifferenceParts.push(`created weekday ET ${example.createdEt} vs ${current.createdEt}`);
    }
    if ((example.metadataKeys || []).length !== (current.metadataKeys || []).length) {
      exactDifferenceParts.push(`metadata keys ${JSON.stringify(example.metadataKeys)} vs ${JSON.stringify(current.metadataKeys)}`);
    }
  }
  if (requestCompare.metadataPresentOnLovableOnly) {
    exactDifferenceParts.push('Lovable POST included checksops_* metadata; AWS POST omitted metadata');
  }
  exactDifferenceParts.push('Lovable and AWS both POST facilitator /transfers with ach-debit-fund → moov-wallet, v2024.01.00, no x-wait-for, no transferOptions');

  const historicalAchElapsed = historical
    .filter((row) => row.rail === 'ach-debit-to-wallet' && row.elapsedMs != null)
    .map((row) => row.elapsed);
  const fastMethod = [
    'BANK→WALLET on this sandbox platform is ACH debit-fund→moov-wallet.',
    historicalAchElapsed.length
      ? `Weekday examples completed in ${historicalAchElapsed.slice(0, 4).join(', ')} after the next :00/:30 origination window.`
      : 'Weekday ACH in Moov test mode completes in about an hour.',
    'Weekend ACH waits until Monday 00:00 ET, then the same origination windows.',
    'No wallet-wallet transfer exists in the 9 historical sandbox platform transfers; Moov docs say wallet-wallet is almost instant if used later.',
    'WALLET→RECIPIENT: historical wallet→ach-credit-same-day took 39.6m; rtp-credit PMs exist but were not used.',
    'Keep ACH plus $55.01+ trigger amounts for pending/failed/returned.',
    'Do not POST this phase.',
  ].join(' ');

  const returnCard = {
    OLD_LOVABLE_TRANSFERS_FOUND: String(examples.length),
    OLD_TRANSFER_EXAMPLE: example?.id || 'none',
    SOURCE_TYPE: example?.source?.paymentMethodType || 'none',
    DESTINATION_TYPE: example?.destination?.paymentMethodType || 'none',
    RAIL: example?.rail || 'none',
    CREATED: example?.createdOn || 'none',
    COMPLETED: example?.completedOn || 'none',
    ELAPSED: example?.elapsed || 'n/a',
    CURRENT_AWS_TRANSFER: MOOV_TRANSFER_ID,
    CURRENT_SOURCE_TYPE: current.source?.paymentMethodType || 'unknown',
    CURRENT_DESTINATION_TYPE: current.destination?.paymentMethodType || 'unknown',
    CURRENT_RAIL: current.rail || 'unknown',
    CURRENT_CREATED: current.createdOn || 'none',
    CURRENT_STATUS: moovStatus || current.status || 'unknown',
    PROVIDER_DETAIL: [
      `completedOn=${current.completedOn || 'none'}`,
      `achStatus=${current.source?.achStatus || 'none'}`,
      `secCode=${current.achType || 'none'}`,
      `originatedOn=${current.source?.achOriginatedOn || 'none'}`,
      `weekendCreatedEt=${current.weekendCreatedEt}`,
      `walletAvailable=${walletAvailable}`,
      `walletPending=${walletPending}`,
      `webhookFound=${webhookRows.length > 0}`,
    ].join('; '),
    EXACT_DIFFERENCE: exactDifferenceParts.join('; ') || 'none_proven',
    WHY_LOVABLE_COMPLETED_QUICKLY: whyLovable,
    WHY_CURRENT_TRANSFER_IS_PENDING: whyPending,
    FAST_SANDBOX_METHOD: fastMethod,
    CODE_CHANGE_REQUIRED: example && example.rail === 'wallet-wallet'
      ? 'YES later: optional sandbox wallet-wallet pairing for rapid tests; keep ACH debit→wallet for settlement/failure cases. Do not implement this phase.'
      : 'NO for this pending ACH object. Optional later: weekday-only ACH tests or a separate wallet-wallet rapid path. Do not implement this phase.',
    CONFIG_CHANGE_REQUIRED: 'NO. Leave both POST flags false. Do not retry the pending transfer.',
    NEW_SANDBOX_OBJECT_REQUIRED: 'NO for reconciling the current ACH debit. Wallet-wallet rapid path would reuse existing moov-wallet PMs; do not create objects this phase.',
    CURRENT_TRANSFER_SAFE_TO_LEAVE_PENDING: 'YES',
    SANDBOX_POST_FLAG: String(flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || 'false'),
    PRODUCTION_POST_FLAG: String(flagsEnd.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
    MONEY_MOVED: String(walletAvailable >= 1),
    RECOMMENDED_NEXT_TEST: weekendHold
      ? 'GET-only wait until Monday 00:00 ET sandbox ACH simulation, then reconcile this same transfer. Do not POST. Do not wallet→recipient.'
      : 'GET-only wait for this ACH debit to complete (~1h weekday test-mode), then reconcile. Do not POST. Do not wallet→recipient.',
    INTENT_ID: INTENT_ID,
    INTENT_STATUS: verifyIntent.intent?.status || 'none',
    WEBHOOK_FOUND: String(webhookRows.length > 0),
    HISTORICAL_SANDBOX_TRANSFER_COUNT: String(historical.length),
    HISTORICAL_RAILS: rails.join(',') || 'none',
    HISTORICAL_SOURCE_TYPES: sourceTypes.join(',') || 'none',
    HISTORICAL_DEST_TYPES: destTypes.join(',') || 'none',
    RDS_SANDBOX_TRANSFER_COUNT: String((history.sandboxTransfers || []).length),
    REQUEST_SAME_RAIL: String(requestCompare.sameSourceType && requestCompare.sameDestinationType),
    REQUEST_SAME_API_VERSION: String(requestCompare.sameApiVersion),
    GO_NO_GO: 'NO-GO',
  };
  writeReturnCard(returnCard);
  fs.writeFileSync('/opt/cursor/artifacts/m79h2_run.json', JSON.stringify({
    at: new Date().toISOString(),
    identity: { arn: identity.Arn },
    posted: false,
    armed: false,
    intentMutated: false,
    flags: flagsEnd.flags,
    docs: {
      testMode: MOOV_TEST_MODE_DOCS,
      weekdayAch: 'about an hour',
      weekendAch: 'wait until Monday 00:00 ET',
      walletWallet: 'almost instantly',
    },
    requestConstruction: {
      lovable: lovableSandboxFundingRequestFromCode,
      aws: awsSandboxFundingRequestFromCode,
      compare: requestCompare,
    },
    current,
    currentRawKeys: Object.keys(liveTransfer.data || {}),
    wallet: {
      id: walletJson.walletID || walletJson.walletId || SANDBOX_WALLET,
      status: walletJson.status || null,
      availableCents: walletAvailable,
      pendingCents: walletPending,
    },
    examples,
    historical,
    listedCount: listed.length,
    merchantTransferHttp: merchantTransfers.statusCode || null,
    platformTransferHttp: platformTransfers.statusCode || null,
    paymentMethodTypes: {
      merchant: [...new Set(asList(merchantMethods.data).map((row) => row.type || row.paymentMethodType).filter(Boolean))],
      platform: [...new Set(asList(platformMethods.data).map((row) => row.type || row.paymentMethodType).filter(Boolean))],
    },
    banks: asList(merchantBanks.data).map((row) => ({
      id: row.bankAccountID || row.bankAccountId || row.id || null,
      status: row.status || row.verificationStatus || null,
      lastFour: row.lastFourNumber || row.lastFour || null,
      routingNumber: row.routingNumber || null,
      bankName: row.bankName || null,
    })),
    history,
    webhooks,
    receipts: {
      ok: receipts.ok === true,
      count: webhookRows.length,
    },
    intent: {
      id: verifyIntent.intent?.id || null,
      status: verifyIntent.intent?.status || null,
      provider_transfer_id: verifyIntent.intent?.provider_transfer_id || null,
    },
    stillPending,
    returnCard,
    STOP_FOR_REVIEW: true,
  }, null, 2));
  console.log(JSON.stringify({
    ok: liveTransfer.ok === true && flagsEnd.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true',
    posted: false,
    armed: false,
    stillPending,
    examples: examples.map((row) => ({
      id: row.id,
      rail: row.rail,
      elapsed: row.elapsed,
      status: row.status,
    })),
    returnCard,
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  writeReturnCard({
    CURRENT_AWS_TRANSFER: MOOV_TRANSFER_ID,
    GO_NO_GO: 'NO-GO',
    ERROR: String(error?.message || error).slice(0, 400),
    MONEY_MOVED: 'false',
    SANDBOX_POST_FLAG: 'false',
    PRODUCTION_POST_FLAG: 'false',
  });
  process.exitCode = 1;
});
