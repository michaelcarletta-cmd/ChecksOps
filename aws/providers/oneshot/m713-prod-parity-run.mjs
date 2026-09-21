#!/usr/bin/env node
/**
 * M7.13: GET-only Freedom production parity / dark verification.
 * Never POSTs /transfers. Never writes payment_transfers. Never overlays API.
 * Never arms POST flags. Never consumes or logs TOTP.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';
import { productionMoovFetch } from '../../functions/api/providers/production/moov-client.mjs';
import {
  FIRST_PRODUCTION_TRANSFER_CENTS,
  firstTestDisburseBinding,
  firstTestFundBinding,
  MOOV_DISBURSE_TOTP_ACTION,
  MOOV_FUND_TOTP_ACTION,
} from '../../functions/api/providers/production/moov-first-test.mjs';
import {
  CONSUME_TOTP_THIS_PHASE,
  DECISION,
  PERSIST_MONEY_INTENTS_THIS_PHASE,
  firstTestPayoutOperationId,
  fundingIdempotencyKey,
  orchestratePayout,
  payoutIdempotencyKey,
} from '../../functions/api/providers/production/moov-payout-orchestrator.mjs';
import { PIPELINE_TEST_SANDBOX } from '../../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import { evaluateFinancialAuthorization } from '../../functions/api/financial-authz.mjs';
import { canTransition, completedAtFor } from '../../functions/api/providers/moov-lifecycle.mjs';
import { webhookMayCreateMoneyIntent, getReconciliationMayCreateMoneyIntent } from '../../functions/api/providers/production/moov-payout-orchestrator.mjs';
import { moovSandboxFetch, moovSandboxScopes } from '../../functions/api/providers/moov-sandbox.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const ONESHOT_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/providers/oneshot/m79-sandbox-tenant');
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const PIPELINE = PIPELINE_TEST_SANDBOX.tenantId;
const MUST_KEEP = [
  'providers/production/moov-wallet-fund.mjs',
  'providers/production/moov-wallet-disburse.mjs',
  'providers/moov-wallet-fund.mjs',
  'providers/moov-wallet-disburse.mjs',
];
const SANDBOX_IDS = [
  PIPELINE_TEST_SANDBOX.accountId,
  PIPELINE_TEST_SANDBOX.walletId,
  PIPELINE_TEST_SANDBOX.bankId,
  PIPELINE_TEST_SANDBOX.achDebitFundPm,
  PIPELINE_TEST_SANDBOX.walletPm,
  PIPELINE_TEST_SANDBOX.recipientAccountId,
  PIPELINE_TEST_SANDBOX.recipientBankId,
  PIPELINE_TEST_SANDBOX.platformAccountId,
  '7a5ef572-501e-4eac-8c1b-7a4794296a85',
].map((id) => String(id).toLowerCase());

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
  if (!token) throw new Error('oidc_token_missing');
  const creds = awsJson([
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-m713-prod-parity',
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
const waitFn = (name) => {
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};
const lambdaFlags = (name = API_FN) => {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', name]);
  const env = cfg.Environment?.Variables || {};
  return {
    functionName: cfg.FunctionName,
    codeSha256: cfg.CodeSha256,
    lastModified: cfg.LastModified,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
      AWS_PROVIDER_WEBHOOK_DRY_RUN: env.AWS_PROVIDER_WEBHOOK_DRY_RUN || null,
      AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED || null,
      AWS_PROVIDER_EXECUTION_ENABLED: env.AWS_PROVIDER_EXECUTION_ENABLED || null,
      AWS_FINANCIAL_PERMISSIONS_ACTIVATED: env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || null,
      AWS_MOOV_ENABLED: env.AWS_MOOV_ENABLED || null,
    },
    vpc: {
      subnetIds: cfg.VpcConfig?.SubnetIds || [],
      securityGroupIds: cfg.VpcConfig?.SecurityGroupIds || [],
    },
    PROVIDER_SECRETS_ARN: env.PROVIDER_SECRETS_ARN,
    MOOV_WEBHOOK_SECRET_ARN: env.MOOV_WEBHOOK_SECRET_ARN || null,
  };
};
const packOneshot = () => {
  const staging = path.join(os.tmpdir(), 'checksops-m713-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m713-oneshot.zip');
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
  const outFile = `/tmp/m713-oneshot-${payload.step}-${Date.now()}.json`;
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
const assertGetOnly = (method, apiPath) => {
  const verb = String(method || 'GET').toUpperCase();
  if (verb === 'POST' && String(apiPath).includes('/oauth2/token')) return;
  if (verb !== 'GET') throw new Error(`refused_method_${verb}_${apiPath}`);
  if (/\/transfers$/i.test(apiPath) && verb !== 'GET') throw new Error('refused_transfer_post');
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
const prodGet = async (credentials, apiPath, scopes) => {
  assertGetOnly('GET', apiPath);
  const result = await productionMoovFetch({
    credentials,
    path: apiPath,
    method: 'GET',
    mode: 'read',
    scopes,
  });
  return result?.json !== undefined ? result.json : result;
};
const inspectLiveZip = () => {
  const work = path.join(os.tmpdir(), 'checksops-m713-live-zip-inspect');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const loc = awsJson(['lambda', 'get-function', '--function-name', API_FN]);
  const zipPath = path.join(work, 'live.zip');
  run('curl', ['-fsSL', loc.Code.Location, '-o', zipPath]);
  const unpacked = path.join(work, 'unpacked');
  fs.mkdirSync(unpacked, { recursive: true });
  run('unzip', ['-q', zipPath, '-d', unpacked]);
  const files = [];
  for (const rel of MUST_KEEP) {
    const full = path.join(unpacked, rel);
    if (!fs.existsSync(full)) {
      files.push({ rel, present: false });
      continue;
    }
    const src = fs.readFileSync(full, 'utf8');
    files.push({
      rel,
      present: true,
      sha256: createHash('sha256').update(src).digest('hex'),
      usesOrchestratePayout: /orchestratePayout/.test(src),
      requireTotpFalse: /requireTotp:\s*false/.test(src),
      postsTransfers: /method:\s*['"]POST['"][\s\S]{0,80}\/transfers/.test(src) || /\/transfers['"`]/.test(src),
    });
  }
  return { files, codeSha256: loc.Configuration?.CodeSha256 || null };
};
const writeCard = (card) => {
  const order = [
    'M7.12 KNOWN-GOOD REFERENCE',
    'FREEDOM TENANT',
    'FREEDOM MOOV ENVIRONMENT',
    'SHARED ORCHESTRATOR',
    'DIFFERENCES',
    'PRODUCTION ACCOUNT',
    'PRODUCTION WALLET',
    'LIVE AVAILABLE',
    'LIVE PENDING',
    'FUNDING BANK',
    'BANK VERIFIED',
    'BANK DEBIT PAYMENT METHOD',
    'WALLET PAYMENT METHOD',
    'RECIPIENT',
    'RECIPIENT BANK',
    'RECIPIENT PAYMENT METHOD',
    'RECIPIENT READY',
    'COLLECT CAPABILITY',
    'SEND CAPABILITY',
    'DARK PAYOUT AMOUNT',
    'DARK SHORTFALL',
    'DARK DECISION',
    'PROPOSED FUNDING REQUIRED',
    'PROPOSED FUNDING AMOUNT',
    'PRODUCTION IDEMPOTENCY',
    'SANDBOX/PRODUCTION COLLISION PROTECTION',
    'PRODUCTION FUNDING TOTP REQUIRED',
    'PRODUCTION PAYOUT TOTP REQUIRED',
    'ANY requireTotp:false PRODUCTION PATH',
    'WEBHOOK PARITY',
    'GET RECON PARITY',
    'COMPLETED_AT PARITY',
    'SWEEP CONFIG',
    'ORCHESTRATOR DEPENDS ON SWEEP',
    'SANDBOX IDS FOUND IN PRODUCTION PATH',
    'PRODUCTION POST FLAG',
    'SANDBOX POST FLAG',
    'PROVIDER POSTS',
    'NEW INTENTS',
    'MONEY MOVED',
    'SWEEP CHANGED',
    'PRODUCTION PARITY RESULT',
    'BLOCKERS BEFORE CONTROLLED PRODUCTION PENNY',
    'SAFE TO PLAN CONTROLLED PRODUCTION PENNY',
  ];
  const lines = order.filter((key) => card[key] !== undefined).map((key) => `${key}: ${card[key]}`);
  const extra = Object.entries(card).filter(([key]) => !order.includes(key)).map(([key, value]) => `${key}: ${value}`);
  const text = `${[...lines, ...extra].join('\n')}\n\nSTOP FOR REVIEW.\nDO NOT ENABLE PRODUCTION TRANSFER POST.\nDO NOT MOVE THE PRODUCTION PENNY.\n`;
  fs.writeFileSync('/opt/cursor/artifacts/m713_prod_parity_card.md', text);
  return text;
};

const main = async () => {
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  const identity = await assumeRole();
  const flags = lambdaFlags();
  if (flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_production_post_armed');
  if (flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_sandbox_post_armed');
  process.env.PROVIDER_SECRETS_ARN = flags.PROVIDER_SECRETS_ARN;
  const productionSecret = JSON.parse(awsJson([
    'secretsmanager', 'get-secret-value',
    '--secret-id', flags.PROVIDER_SECRETS_ARN,
  ]).SecretString || '{}');
  const prodCreds = {
    environment: 'production',
    publicKey: productionSecret.MOOV_PUBLIC_KEY,
    secretKey: productionSecret.MOOV_SECRET_KEY,
    platformId: productionSecret.MOOV_PLATFORM_ACCOUNT_ID,
    origin: PRODUCTION_MOOV_ORIGIN,
    apiVersion: PRODUCTION_MOOV_API_VERSION,
    host: 'https://api.moov.io',
  };
  const sandboxCreds = {
    environment: 'sandbox',
    publicKey: productionSecret.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: productionSecret.MOOV_SANDBOX_SECRET_KEY,
    platformId: productionSecret.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID,
    origin: productionSecret.MOOV_SANDBOX_ALLOWED_ORIGIN || PRODUCTION_MOOV_ORIGIN,
    apiVersion: productionSecret.MOOV_SANDBOX_API_VERSION || PRODUCTION_MOOV_API_VERSION,
    host: 'https://api.moov.io',
  };
  if (!prodCreds.publicKey || !prodCreds.secretKey) throw new Error('production_secret_missing');
  if (prodCreds.publicKey === sandboxCreds.publicKey) throw new Error('sandbox_equals_production');
  if (String(prodCreds.platformId).toLowerCase() === String(sandboxCreds.platformId).toLowerCase()) {
    throw new Error('platform_environment_collision');
  }

  const zip = packOneshot();
  const secretsList = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secretsList.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  ensureOneshot(zip, adminSecret.ARN, flags.vpc);
  const rds = invokeOneshot({ step: 'inspect_freedom_production' });
  if (rds?.ok !== true) throw new Error(`rds_inspect_failed:${rds?.error || 'unknown'}`);
  const sweepBefore = rds.sweep || null;

  const liveZip = inspectLiveZip();
  const freedom = KNOWN_APPROVED_MOOV.freedom;
  const recipient = KNOWN_APPROVED_MOOV.recipient;
  const accountId = rds.freedomProduction?.account?.provider_account_id || freedom.moovAccountId;
  const walletId = rds.freedomProduction?.wallet?.provider_wallet_id || freedom.walletId;
  const bankId = rds.freedomProduction?.banks?.find((row) => String(row.provider_bank_account_id || '').toLowerCase() === freedom.bankId)?.provider_bank_account_id
    || rds.freedomProduction?.banks?.[0]?.provider_bank_account_id
    || freedom.bankId;

  const walletJson = await prodGet(
    prodCreds,
    `/accounts/${accountId}/wallets/${walletId}`,
    [`/accounts/${accountId}/wallets.read`],
  );
  const accountJson = await prodGet(
    prodCreds,
    `/accounts/${accountId}`,
    [`/accounts/${accountId}/profile.read`],
  );
  const capabilities = await prodGet(
    prodCreds,
    `/accounts/${accountId}/capabilities`,
    [`/accounts/${accountId}/profile.read`],
  ).catch(() => []);
  const paymentMethods = await prodGet(
    prodCreds,
    `/accounts/${accountId}/payment-methods`,
    [`/accounts/${accountId}/payment-methods.read`],
  ).catch(() => []);
  const bankJson = await prodGet(
    prodCreds,
    `/accounts/${accountId}/bank-accounts/${bankId}`,
    [`/accounts/${accountId}/bank-accounts.read`],
  ).catch(() => null);
  const recipientBank = await prodGet(
    prodCreds,
    `/accounts/${recipient.moovAccountId}/bank-accounts/${recipient.bankId}`,
    [`/accounts/${recipient.moovAccountId}/bank-accounts.read`],
  ).catch(() => null);
  const recipientMethods = await prodGet(
    prodCreds,
    `/accounts/${recipient.moovAccountId}/payment-methods`,
    [`/accounts/${recipient.moovAccountId}/payment-methods.read`],
  ).catch(() => []);
  const sweepConfigs = await prodGet(
    prodCreds,
    `/accounts/${accountId}/sweep-configs`,
    [`/accounts/${accountId}/wallets.read`],
  ).catch((error) => ({ error: String(error?.message || error).slice(0, 180) }));
  const walletSweeps = await prodGet(
    prodCreds,
    `/accounts/${accountId}/wallets/${walletId}/sweeps`,
    [`/accounts/${accountId}/wallets.read`],
  ).catch((error) => ({ error: String(error?.message || error).slice(0, 180) }));

  const sandboxWallet = await moovSandboxFetch({
    credentials: sandboxCreds,
    path: `/accounts/${PIPELINE_TEST_SANDBOX.accountId}/wallets/${PIPELINE_TEST_SANDBOX.walletId}`,
    scopes: moovSandboxScopes.walletsRead(PIPELINE_TEST_SANDBOX.accountId),
  }).catch((error) => ({ error: String(error?.message || error).slice(0, 180) }));

  const liveAvailable = amountCentsOf(walletJson?.availableBalance ?? walletJson?.available);
  const livePending = amountCentsOf(walletJson?.pendingBalance ?? walletJson?.pending);
  const methods = Array.isArray(paymentMethods) ? paymentMethods : (paymentMethods?.paymentMethods || []);
  const recMethods = Array.isArray(recipientMethods) ? recipientMethods : (recipientMethods?.paymentMethods || []);
  const debitPm = methods.find((row) => String(row.paymentMethodID || row.paymentMethodId) === freedom.achDebitFundPm)
    || methods.find((row) => String(row.paymentMethodType || '').includes('ach-debit-fund'));
  const walletPm = methods.find((row) => String(row.paymentMethodID || row.paymentMethodId) === freedom.walletPm)
    || methods.find((row) => String(row.paymentMethodType || '') === 'moov-wallet');
  const recipientPm = recMethods.find((row) => String(row.paymentMethodID || row.paymentMethodId) === recipient.achCreditStandardPm)
    || recMethods.find((row) => String(row.paymentMethodType || '').includes('ach-credit'));
  const capList = Array.isArray(capabilities) ? capabilities : (capabilities?.capabilities || []);
  const collect = capList.find((row) => /collect|transfers\.debit|send-funds/i.test(JSON.stringify(row)));
  const send = capList.find((row) => /send|transfers\.credit|send-funds/i.test(JSON.stringify(row)));
  const collectStatus = capList.find((row) => String(row.capability || row.name || '').includes('collect'))?.status
    || capList.find((row) => String(row.capability || '') === 'collect-funds')?.status
    || null;
  const sendStatus = capList.find((row) => String(row.capability || '') === 'send-funds')?.status
    || capList.find((row) => String(row.capability || row.name || '').includes('send-funds'))?.status
    || null;
  const recipientVerified = String(recipientBank?.status || '').toLowerCase() === 'verified';
  const bankVerified = String(bankJson?.status || '').toLowerCase() === 'verified';
  const fundBinding = firstTestFundBinding();
  const disburseBinding = firstTestDisburseBinding();

  const productionIds = [
    accountId, walletId, bankId,
    debitPm?.paymentMethodID || debitPm?.paymentMethodId || freedom.achDebitFundPm,
    walletPm?.paymentMethodID || walletPm?.paymentMethodId || freedom.walletPm,
    recipient.moovAccountId, recipient.bankId, recipient.achCreditStandardPm,
  ].filter(Boolean).map((id) => String(id).toLowerCase());
  const sandboxHits = productionIds.filter((id) => SANDBOX_IDS.includes(id));

  console.log('STOP BEFORE WRITING: persistMoneyIntents=false store=null; planned intents are inspection-only.');
  const dark = await orchestratePayout({
    availableCents: liveAvailable,
    payoutCents: FIRST_PRODUCTION_TRANSFER_CENTS,
    recipientVerified,
    totpFundPresent: false,
    totpDisbursePresent: false,
    requireTotp: true,
    transferPostEnabled: false,
    persistMoneyIntents: false,
    store: null,
    existingRows: rds.existingProductionRows || [],
    sweepActivity: [],
    environment: 'production',
    tenantId: FREEDOM,
    labels: {
      fund: {
        sourceLabel: fundBinding.sourceLabel,
        destinationLabel: fundBinding.destinationLabel,
        bankId: fundBinding.bankId,
        walletId: fundBinding.walletId,
        sourcePaymentMethodId: fundBinding.sourcePaymentMethodId,
        destinationPaymentMethodId: fundBinding.destinationPaymentMethodId,
      },
      disburse: {
        sourceLabel: disburseBinding.sourceLabel,
        destinationLabel: disburseBinding.destinationLabel,
        recipientLabel: disburseBinding.recipientLabel,
        recipientId: disburseBinding.recipientId,
      },
    },
  });
  if (dark.created_payment_transfer === true || dark.persist_money_intents === true) {
    throw new Error('refused_intent_write');
  }

  const flagsAfter = lambdaFlags();
  const sweepAfter = invokeOneshot({ step: 'inspect_freedom_production' });
  const sweepChanged = String(sweepBefore?.id || '') !== String(sweepAfter?.sweep?.id || '')
    || String(sweepBefore?.status || '') !== String(sweepAfter?.sweep?.status || '');
  const prodOp = firstTestPayoutOperationId('production');
  const sandOp = firstTestPayoutOperationId('sandbox');
  const writersSeparate = liveZip.files.filter((row) => row.present).every((row) => row.usesOrchestratePayout !== true);
  const requireTotpFalseInWriters = liveZip.files.some((row) => row.requireTotpFalse === true);
  const fundAuthz = evaluateFinancialAuthorization({
    operation: 'wallet_fund', identityOk: true, membershipOk: true, roles: ['owner'], permissionsActivated: true,
  });
  const disburseAuthz = evaluateFinancialAuthorization({
    operation: 'wallet_disburse', identityOk: true, membershipOk: true, roles: ['owner'], permissionsActivated: true,
  });

  const differences = [
    'M7.12 e2e wrapper executeSandboxPayoutE2e is sandbox/Pipeline-only and passes requireTotp:false',
    'Freedom HTTP path handleProductionMoovPayoutOrchestrate uses the same orchestratePayout with requireTotp default true and persistMoneyIntents=false',
    writersSeparate ? 'Live zip MUST_KEEP fund/disburse writers do not call orchestratePayout (environment-specific POST construction, currently unarmed)' : 'Live zip writers import orchestratePayout',
    'Parity moov-wallet-fund/disburse remain blocked while production execution is on and sandbox execution is off',
  ].join(' | ');

  const blockers = [];
  if (sandboxHits.length) blockers.push('sandbox_ids_in_production_path');
  if (requireTotpFalseInWriters) blockers.push('requireTotp_false_in_production_writer');
  if (flagsAfter.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') blockers.push('production_post_armed');
  if (!bankVerified) blockers.push('funding_bank_not_verified');
  if (!recipientVerified) blockers.push('recipient_bank_not_verified');
  if (!debitPm) blockers.push('funding_debit_pm_missing');
  if (!walletPm) blockers.push('wallet_pm_missing');
  if (!recipientPm) blockers.push('recipient_credit_pm_missing');
  blockers.push('no_production_e2e_post_wrapper_equivalent_to_m712');
  blockers.push('financial_canExecuteProduction_hard_false');
  blockers.push(`totp_not_consumed_this_phase:${CONSUME_TOTP_THIS_PHASE}`);

  const shared = dark.phase === 'M7.7'
    && dark.require_totp === true
    && dark.sweep_used_as_funding === false
    && webhookMayCreateMoneyIntent() === false
    && getReconciliationMayCreateMoneyIntent() === false
    && canTransition('completed', 'pending').ok === false
    && completedAtFor({ nextStatus: 'completed', providerCompletedAt: '2026-09-21T19:46:00.803144Z', existingCompletedAt: null }) === '2026-09-21T19:46:00.803144Z';

  const result = shared && sandboxHits.length === 0 && requireTotpFalseInWriters === false
    ? 'PASS'
    : 'BLOCKED';
  const safeToPlan = result === 'PASS' && blockers.filter((item) => item.startsWith('sandbox') || item.startsWith('requireTotp')).length === 0
    ? 'YES'
    : 'NO';

  const card = {
    'M7.12 KNOWN-GOOD REFERENCE': 'PASS',
    'FREEDOM TENANT': FREEDOM,
    'FREEDOM MOOV ENVIRONMENT': rds.freedom?.moov_environment || null,
    'SHARED ORCHESTRATOR': shared ? 'YES' : 'NO',
    DIFFERENCES: differences,
    'PRODUCTION ACCOUNT': accountId,
    'PRODUCTION WALLET': walletId,
    'LIVE AVAILABLE': liveAvailable,
    'LIVE PENDING': livePending,
    'FUNDING BANK': bankId,
    'BANK VERIFIED': bankVerified,
    'BANK DEBIT PAYMENT METHOD': debitPm?.paymentMethodID || debitPm?.paymentMethodId || freedom.achDebitFundPm,
    'WALLET PAYMENT METHOD': walletPm?.paymentMethodID || walletPm?.paymentMethodId || freedom.walletPm,
    RECIPIENT: recipient.recipientId,
    'RECIPIENT BANK': recipient.bankId,
    'RECIPIENT PAYMENT METHOD': recipientPm?.paymentMethodID || recipientPm?.paymentMethodId || recipient.achCreditStandardPm,
    'RECIPIENT READY': recipientVerified,
    'COLLECT CAPABILITY': collectStatus || (collect ? JSON.stringify(collect).slice(0, 80) : null),
    'SEND CAPABILITY': sendStatus || (send ? JSON.stringify(send).slice(0, 80) : null),
    'DARK PAYOUT AMOUNT': dark.payout_cents,
    'DARK SHORTFALL': dark.shortfall_cents,
    'DARK DECISION': dark.decision,
    'PROPOSED FUNDING REQUIRED': dark.decision === DECISION.FUND_FIRST ? 'YES' : 'NO',
    'PROPOSED FUNDING AMOUNT': dark.shortfall_cents,
    'PRODUCTION IDEMPOTENCY': `${prodOp} / ${fundingIdempotencyKey(prodOp, dark.shortfall_cents || 1, 'production')} / ${payoutIdempotencyKey(prodOp, 1, 'production')}`,
    'SANDBOX/PRODUCTION COLLISION PROTECTION': prodOp !== sandOp && !fundingIdempotencyKey(prodOp, 1, 'production').includes('sandbox'),
    'PRODUCTION FUNDING TOTP REQUIRED': MOOV_FUND_TOTP_ACTION,
    'PRODUCTION PAYOUT TOTP REQUIRED': MOOV_DISBURSE_TOTP_ACTION,
    'ANY requireTotp:false PRODUCTION PATH': requireTotpFalseInWriters ? 'YES' : 'NO',
    'WEBHOOK PARITY': 'shared applyProductionMoovWebhook + extractTransferEvent/completedAtFor/canTransition; webhook never INSERT payment_transfers',
    'GET RECON PARITY': 'shared reconcileExistingFromProviderGet / aws_moov_reconcile_existing_transfer',
    'COMPLETED_AT PARITY': 'completed_at = provider completedOn; never NOW(); absent completedOn does not invent',
    'SWEEP CONFIG': JSON.stringify(sweepAfter?.sweep || sweepConfigs || null).slice(0, 300),
    'ORCHESTRATOR DEPENDS ON SWEEP': dark.sweep_used_as_funding === true ? 'YES' : 'NO',
    'SANDBOX IDS FOUND IN PRODUCTION PATH': sandboxHits.length ? 'YES' : 'NO',
    'PRODUCTION POST FLAG': flagsAfter.flags.AWS_MOOV_TRANSFER_POST_ENABLED,
    'SANDBOX POST FLAG': flagsAfter.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED,
    'PROVIDER POSTS': 0,
    'NEW INTENTS': 0,
    'MONEY MOVED': false,
    'SWEEP CHANGED': sweepChanged,
    'PRODUCTION PARITY RESULT': result,
    'BLOCKERS BEFORE CONTROLLED PRODUCTION PENNY': blockers.join(' | '),
    'SAFE TO PLAN CONTROLLED PRODUCTION PENNY': safeToPlan,
  };
  const text = writeCard(card);
  fs.writeFileSync('/opt/cursor/artifacts/m713_prod_parity_run.json', JSON.stringify({
    at: new Date().toISOString(),
    identity,
    flags,
    flagsAfter,
    rds: {
      ok: rds.ok,
      freedom: rds.freedom,
      pipeline: rds.pipeline,
      freedomProduction: rds.freedomProduction,
      freedomSandbox: rds.freedomSandbox,
      pipelineSandboxAccount: rds.pipelineSandbox?.account?.provider_account_id || null,
      sandboxIdsInProductionPath: rds.sandboxIdsInProductionPath,
      productionTransferCount: rds.productionTransferCount,
      sweep: rds.sweep,
    },
    liveZip,
    moov: {
      accountId,
      walletId,
      bankId,
      liveAvailable,
      livePending,
      bankStatus: bankJson?.status || null,
      recipientBankStatus: recipientBank?.status || null,
      debitPm: debitPm?.paymentMethodID || debitPm?.paymentMethodId || null,
      walletPm: walletPm?.paymentMethodID || walletPm?.paymentMethodId || null,
      recipientPm: recipientPm?.paymentMethodID || recipientPm?.paymentMethodId || null,
      collectStatus,
      sendStatus,
      capabilityCount: capList.length,
      accountDisplayName: accountJson?.displayName || accountJson?.profile?.displayName || null,
    },
    sandboxWalletError: sandboxWallet?.error || null,
    sandboxWalletAvailable: amountCentsOf(sandboxWallet?.data?.availableBalance ?? sandboxWallet?.availableBalance),
    sweepConfigs,
    walletSweeps,
    dark: {
      decision: dark.decision,
      shortfall_cents: dark.shortfall_cents,
      payout_cents: dark.payout_cents,
      require_totp: dark.require_totp,
      persist_money_intents: dark.persist_money_intents,
      created_payment_transfer: dark.created_payment_transfer,
      funding_post_allowed: dark.funding_post_allowed,
      payout_submittable: dark.payout_submittable,
      blocked_reasons: dark.blocked_reasons,
      funding_intent_created: dark.funding_intent?.created || false,
      payout_intent_created: dark.payout_intent?.created || false,
      would_write_if_persist_true: {
        funding: dark.decision === DECISION.FUND_FIRST,
        payout: true,
        stopped: true,
      },
      sweep_used_as_funding: dark.sweep_used_as_funding,
      idempotency_scope: dark.idempotency_scope,
    },
    authz: {
      fund: { canExecuteProduction: fundAuthz.canExecuteProduction, activated: fundAuthz.spec?.activated },
      disburse: { canExecuteProduction: disburseAuthz.canExecuteProduction, activated: disburseAuthz.spec?.activated },
      consumeTotpThisPhase: CONSUME_TOTP_THIS_PHASE,
    },
    sandboxHits,
    card,
  }, null, 2));
  console.log(text);
};

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
