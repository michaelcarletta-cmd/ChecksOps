#!/usr/bin/env node
/**
 * M7.16 Phase A: Freedom BANK→WALLET $0.01.
 * Default phase is READ-ONLY precheck. Persist and POST are explicit.
 * Never asks for, logs, or types Financial TOTP. Never posts payout.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';
import { productionMoovFetch } from '../../functions/api/providers/production/moov-client.mjs';
import { firstTestFundBinding } from '../../functions/api/providers/production/moov-first-test.mjs';
import {
  fundingIdempotencyKey,
} from '../../functions/api/providers/production/moov-payout-orchestrator.mjs';
import {
  executeProductionPayoutE2e,
  m714PayoutOperationId,
} from '../../functions/api/providers/production/moov-production-payout-e2e.mjs';
import { createMemoryPayoutStore } from '../../functions/api/providers/production/moov-payout-orchestrator.mjs';
import { productionProviderIdempotency } from '../../functions/api/providers/production/moov-production-transfer-primitives.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const ONESHOT_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/providers/oneshot/m79-sandbox-tenant');
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const OPERATION = m714PayoutOperationId();
const EXPECTED_OPERATION = '534bfe2d-6bd9-5f78-a367-61e66e7ed33a';
const PHASE = String(process.env.M716_PHASE || process.argv[2] || 'precheck').toLowerCase();

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
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  const creds = awsJson([
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-m716-phase-a',
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
const lambdaFlags = () => {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  const env = cfg.Environment?.Variables || {};
  return {
    functionName: cfg.FunctionName,
    codeSha256: cfg.CodeSha256,
    lastModified: cfg.LastModified,
    state: cfg.State,
    lastUpdateStatus: cfg.LastUpdateStatus,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    },
    vpc: {
      subnetIds: cfg.VpcConfig?.SubnetIds || [],
      securityGroupIds: cfg.VpcConfig?.SecurityGroupIds || [],
    },
    PROVIDER_SECRETS_ARN: env.PROVIDER_SECRETS_ARN,
    env,
  };
};
const refuseArmed = (flags) => {
  if (flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_production_post_armed_during_precheck');
  if (flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_sandbox_post_armed');
};
const setProductionPostFlag = (value) => {
  const cfg = lambdaFlags();
  const env = { ...cfg.env };
  env.AWS_MOOV_TRANSFER_POST_ENABLED = value === true ? 'true' : 'false';
  env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED = 'false';
  awsJson([
    'lambda', 'update-function-configuration',
    '--function-name', API_FN,
    '--environment', JSON.stringify({ Variables: env }),
  ]);
  waitFn(API_FN);
  return lambdaFlags();
};
const stepupMatchesFunding = (row, expected) => (
  String(row?.action_key || '') === 'wallet.fund'
  && String(row?.user_id || '') === '7dbb3009-f059-4767-b5dc-1c5c72379330'
  && String(row?.tenant_id || '') === FREEDOM
  && Number(row?.amount_cents) === 1
  && String(row?.source_payment_method_id || '').toLowerCase() === expected.sourcePm
  && String(row?.destination_payment_method_id || '').toLowerCase() === expected.walletPm
);
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
const capOf = (json) => {
  const rows = Array.isArray(json) ? json : (json?.capabilities || json?.items || []);
  const hit = (rows || []).find((row) => String(row.capability || row.name || '').toLowerCase() === 'collect-funds');
  return hit ? String(hit.status || hit.state || '').toLowerCase() : null;
};
const packOneshot = () => {
  const staging = path.join(os.tmpdir(), 'checksops-m716-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m716-oneshot.zip');
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
  awsJson(['lambda', 'get-function-configuration', '--function-name', ONESHOT_FN]);
  run(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', ONESHOT_FN, '--zip-file', `fileb://${zipPath}`]);
  waitFn(ONESHOT_FN);
  awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT_FN, '--timeout', '120', '--memory-size', '512', '--environment', JSON.stringify(env)]);
  waitFn(ONESHOT_FN);
};
const invokeOneshot = (payload) => {
  const outFile = `/tmp/m716-oneshot-${payload.step}-${Date.now()}.json`;
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
const writeCard = (card, extra = {}) => {
  const order = [
    'FINAL PRECHECK',
    'LIVE AVAILABLE BEFORE',
    'LIVE PENDING BEFORE',
    'DARK DECISION',
    'EXACT SHORTFALL',
    'FUNDING INTENT ID',
    'FUNDING INTENT COUNT',
    'FUNDING AMOUNT',
    'FUNDING IDEMPOTENCY',
    'WALLET.FUND HUMAN AUTHORIZATION',
    'AUTHORIZATION ACTION',
    'AUTHORIZATION AMOUNT',
    'AUTHORIZATION CONSUMED ONCE',
    'PRODUCTION POST ARMED',
    'PROVIDER POST COUNT',
    'PROVIDER REQUEST ID',
    'PROVIDER TRANSFER ID',
    'PROVIDER STATUS',
    'PRODUCTION POST DISARMED',
    'SANDBOX POST FLAG',
    'LIVE AVAILABLE AFTER',
    'LIVE PENDING AFTER',
    'PAYOUT PROVIDER POST COUNT',
    'WALLET.DISBURSE AUTHORIZATION CONSUMED',
    'SECOND FUNDING CREATED',
    'SWEEP CHANGED',
    'PRODUCTION MONEY MOVED',
    'PHASE A RESULT',
    'NEXT REQUIRED ACTION',
  ];
  const text = `${order.map((key) => `${key}: ${card[key]}`).join('\n')}\n\nSTOP FOR REVIEW.\nDO NOT PROCEED TO PHASE B.\n`;
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/m716_phase_a_card.md', text);
  fs.writeFileSync('/opt/cursor/artifacts/m716_phase_a_run.json', `${JSON.stringify({ at: new Date().toISOString(), phase: PHASE, card, ...extra }, null, 2)}\n`);
  console.log(text);
  return text;
};

const main = async () => {
  if (OPERATION !== EXPECTED_OPERATION) {
    throw new Error(`operation_mismatch ${OPERATION}`);
  }
  const identity = await assumeRole();
  const flags = lambdaFlags();
  refuseArmed(flags.flags);
  if (flags.state !== 'Active') throw new Error(`lambda_not_active:${flags.state}`);

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
    platformAccountId: productionSecret.MOOV_PLATFORM_ACCOUNT_ID,
    origin: PRODUCTION_MOOV_ORIGIN,
    apiVersion: PRODUCTION_MOOV_API_VERSION,
    host: 'https://api.moov.io',
  };
  const freedom = KNOWN_APPROVED_MOOV.freedom;
  const binding = firstTestFundBinding();
  const expected = {
    bankId: '61062c38-a79e-4f62-bb64-32ddecf3d37c',
    sourcePm: 'a02c1c81-9ca6-434d-accc-ea4471a70ef2',
    walletId: '3e6286ca-a19c-45f6-aad9-f73dac5f0358',
    walletPm: '744ea734-f5e3-4b31-bb92-38f85fd29b91',
  };
  if (binding.bankId !== expected.bankId || binding.sourcePaymentMethodId !== expected.sourcePm
    || binding.walletId !== expected.walletId || binding.destinationPaymentMethodId !== expected.walletPm) {
    throw new Error('server_binding_mismatch');
  }

  const walletJson = await productionMoovFetch({
    credentials: prodCreds,
    path: `/accounts/${freedom.moovAccountId}/wallets/${freedom.walletId}`,
    method: 'GET',
    mode: 'read',
    scopes: [`/accounts/${freedom.moovAccountId}/wallets.read`],
  });
  const live = walletJson?.json || walletJson;
  const liveAvailable = amountCentsOf(live?.availableBalance ?? live?.available);
  const livePending = amountCentsOf(live?.pendingBalance ?? live?.pending);
  const bankJson = await productionMoovFetch({
    credentials: prodCreds,
    path: `/accounts/${freedom.moovAccountId}/bank-accounts/${freedom.bankId}`,
    method: 'GET',
    mode: 'read',
    scopes: [`/accounts/${freedom.moovAccountId}/bank-accounts.read`],
  });
  const bank = bankJson?.json || bankJson;
  const bankVerified = String(bank?.status || '').toLowerCase() === 'verified';
  const methodsJson = await productionMoovFetch({
    credentials: prodCreds,
    path: `/accounts/${freedom.moovAccountId}/payment-methods`,
    method: 'GET',
    mode: 'read',
    scopes: [`/accounts/${freedom.moovAccountId}/payment-methods.read`],
  });
  const methods = Array.isArray(methodsJson?.json) ? methodsJson.json
    : (methodsJson?.json?.paymentMethods || methodsJson?.paymentMethods || methodsJson?.json || []);
  const list = Array.isArray(methods) ? methods : [];
  const fundPm = list.find((row) => String(row.paymentMethodID || row.paymentMethodId || '') === expected.sourcePm);
  const walletPm = list.find((row) => String(row.paymentMethodID || row.paymentMethodId || '') === expected.walletPm);
  let collectFunds = null;
  try {
    const caps = await productionMoovFetch({
      credentials: prodCreds,
      path: `/accounts/${freedom.moovAccountId}/capabilities`,
      method: 'GET',
      mode: 'read',
      scopes: [`/accounts/${freedom.moovAccountId}/capabilities.read`],
    });
    collectFunds = capOf(caps?.json || caps);
  } catch (error) {
    collectFunds = `error:${error.message || error}`.slice(0, 80);
  }

  const zip = packOneshot();
  const secretsList = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secretsList.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  ensureOneshot(zip, adminSecret.ARN, flags.vpc);
  const rds = invokeOneshot({
    step: 'inspect_m716_phase_a',
    payoutOperationId: OPERATION,
    idempotencyKey: fundingIdempotencyKey(OPERATION, 1, 'production'),
  });
  if (rds?.ok !== true) throw new Error(`rds_inspect_failed:${rds?.error || 'unknown'}`);

  const dark = await executeProductionPayoutE2e({
    tenantId: FREEDOM,
    tenantEnvironment: 'production',
    liveAvailableCents: liveAvailable,
    recipientVerified: bankVerified,
    persistMoneyIntents: false,
    transferPostEnabled: false,
    sandboxTransferPostEnabled: false,
    store: null,
    postPhase: 'none',
  });
  if (dark.createdPaymentTransfer === true || dark.liveProviderPosted === true) {
    throw new Error('refused_intent_write_or_post');
  }

  const mismatches = [];
  if (String(rds.freedom?.moov_environment) !== 'production') mismatches.push('freedom_not_production');
  if (String(rds.objects?.account || '').toLowerCase() !== freedom.moovAccountId) mismatches.push('account_mismatch');
  if (String(rds.objects?.wallet || '').toLowerCase() !== expected.walletId) mismatches.push('wallet_mismatch');
  if (String(rds.objects?.fundingBank || '').toLowerCase() !== expected.bankId) mismatches.push('bank_mismatch');
  if (!bankVerified) mismatches.push('bank_not_verified');
  if (!fundPm) mismatches.push('funding_pm_missing');
  if (!walletPm) mismatches.push('wallet_pm_missing');
  if (collectFunds && collectFunds !== 'enabled' && !String(collectFunds).startsWith('error:')) {
    mismatches.push(`collect_funds=${collectFunds}`);
  }
  if ((rds.postedFunding || []).length) mismatches.push('existing_funding_provider_transfer');
  if ((rds.conflictingFunding || []).length) mismatches.push('conflicting_pending_or_unknown_funding');
  if ((rds.payoutIntentCount || 0) > 0) mismatches.push('payout_intent_present');
  if (dark.payout_cents !== 1) mismatches.push('cap_not_one_cent');
  const flagsStill = lambdaFlags();
  refuseArmed(flagsStill.flags);

  const shortfall = Number(dark.shortfall_cents);
  let result = 'BLOCKED';
  let next = 'STOP FOR REVIEW';
  if (mismatches.length) {
    result = 'BLOCKED';
    next = `Unexpected state: ${mismatches.join(', ')}`;
  } else if (liveAvailable >= 1) {
    result = 'NOT_REQUIRED';
    next = 'Wallet already covers $0.01. Do not fund. STOP.';
  } else if (dark.decision === 'FUND_FIRST' && shortfall === 1) {
    result = 'READY_TO_PERSIST';
    next = 'Persist the one production funding intent, then Michael authorizes wallet.fund in the production UI. Do not POST yet.';
  } else {
    result = 'BLOCKED';
    next = `Unexpected dark decision ${dark.decision} shortfall=${shortfall}`;
  }

  let persist = null;
  let posted = null;
  let armed = false;
  let flagsAfterPost = flagsStill;
  let liveAvailableAfter = liveAvailable;
  let livePendingAfter = livePending;
  let authState = (rds.walletFundStepups || []).length ? 'PRESENT_UNVERIFIED_THIS_PHASE' : 'NOT_YET';
  let authConsumed = 'NO';
  let providerPostCount = 0;
  let providerRequestId = 'n/a';
  let providerTransferId = 'null';
  let providerStatus = 'n/a';
  let productionPostArmed = 'NO';
  let productionMoneyMoved = false;

  if (PHASE === 'persist' && result === 'READY_TO_PERSIST') {
    persist = invokeOneshot({
      step: 'persist_production_funding_intent',
      tenantId: FREEDOM,
      payoutOperationId: OPERATION,
      idempotencyKey: fundingIdempotencyKey(OPERATION, 1, 'production'),
      amountCents: 1,
      providerIdempotencyKey: productionProviderIdempotency(fundingIdempotencyKey(OPERATION, 1, 'production')),
    });
    if (persist?.ok !== true) throw new Error(`persist_failed:${persist?.error || 'unknown'}`);
    if (persist.payoutCreated === true) throw new Error('payout_intent_created');
    const row = persist.intent;
    if (String(row.tenant_id) !== FREEDOM) throw new Error('persist_tenant_mismatch');
    if (String(row.environment) !== 'production') throw new Error('persist_environment_mismatch');
    if (String(row.leg_role) !== 'wallet_funding') throw new Error('persist_leg_mismatch');
    if (Number(row.amount_cents) !== 1) throw new Error('persist_amount_mismatch');
    if (row.provider_transfer_id) throw new Error('persist_already_has_provider_transfer');
    if (String(row.idempotency_key) !== fundingIdempotencyKey(OPERATION, 1, 'production')) {
      throw new Error('persist_idempotency_mismatch');
    }
    if ((persist.fundingIntentCount || 1) > 1) throw new Error('duplicate_funding_intent');
    if ((persist.payoutIntentCount || 0) > 0) throw new Error('payout_intent_created');
    result = 'READY_FOR_HUMAN_WALLET_FUND';
    next = 'Michael: open ChecksOps production WalletOps or Account Security, click Authorize $0.01 wallet.fund, and enter the Financial TOTP yourself. Do not paste the code into chat. Cursor will verify the server-side step-up, then arm POST for one BANK→WALLET transfer only.';
  }

  if (PHASE === 'post') {
    const latest = invokeOneshot({
      step: 'inspect_m716_phase_a',
      payoutOperationId: OPERATION,
      idempotencyKey: fundingIdempotencyKey(OPERATION, 1, 'production'),
    });
    persist = latest;
    const row = (latest.fundingRows || [])[0] || latest.intent;
    const stepup = (latest.walletFundStepups || []).find((item) => stepupMatchesFunding(item, expected));
    if (!row?.id) {
      result = 'BLOCKED';
      next = 'Funding intent missing. Persist first. Do not POST.';
    } else if (row.provider_transfer_id) {
      result = 'BLOCKED';
      next = 'Funding provider transfer already exists. Do not POST again.';
    } else if (!stepup) {
      result = 'BLOCKED';
      authState = 'FAIL_OR_MISSING';
      next = 'Fresh unused wallet.fund authorization for Michael / Freedom / $0.01 / Wells Fargo → wallet is missing. Do not POST.';
    } else {
      authState = 'SUCCESS';
      productionPostArmed = 'YES';
      try {
        const armedCfg = setProductionPostFlag(true);
        armed = armedCfg.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true';
        if (!armed) throw new Error('failed_to_arm_production_post');
        if (armedCfg.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') {
          throw new Error('sandbox_post_armed_during_funding');
        }
        const store = createMemoryPayoutStore();
        posted = await executeProductionPayoutE2e({
          tenantId: FREEDOM,
          tenantEnvironment: 'production',
          liveAvailableCents: liveAvailable,
          recipientVerified: bankVerified,
          persistMoneyIntents: true,
          transferPostEnabled: true,
          sandboxTransferPostEnabled: false,
          store,
          existingRows: latest.fundingRows || [row],
          totpFundPresent: true,
          totpFundValid: true,
          totpDisbursePresent: false,
          totpDisburseValid: false,
          credentials: prodCreds,
          postPhase: 'funding',
          consumeTotpThisPhase: true,
          markPostAttempted: async ({ provider_idempotency_key }) => invokeOneshot({
            step: 'cas_mark_production_funding_post_attempt',
            idempotencyKey: fundingIdempotencyKey(OPERATION, 1, 'production'),
            providerIdempotencyKey: provider_idempotency_key,
          }),
        });
        providerPostCount = Number(posted.funding_provider_posts || 0);
        if (Number(posted.payout_provider_posts || 0) > 0) throw new Error('payout_posted_phase_a');
        const exec = posted.funding_exec || {};
        providerRequestId = exec.requestId || 'n/a';
        providerTransferId = exec.provider_transfer_id || row.provider_transfer_id || 'null';
        providerStatus = exec.provider_status || exec.outcome || 'n/a';
        const postStatus = exec.outcome === 'posted'
          ? 'pending'
          : (exec.outcome === 'unknown' || exec.outcome === 'conflict' ? 'unknown' : (exec.outcome === 'failed' ? 'failed' : 'planned'));
        invokeOneshot({
          step: 'update_production_funding_intent',
          idempotencyKey: fundingIdempotencyKey(OPERATION, 1, 'production'),
          providerTransferId: exec.provider_transfer_id || null,
          providerStatus: exec.provider_status || exec.outcome || null,
          status: postStatus,
          failureReason: exec.error || null,
          providerMetadata: {
            post_attempted: true,
            post_outcome: exec.outcome || null,
            provider_request_id: exec.requestId || null,
            http_status: exec.httpStatus || null,
          },
        });
        if (exec.liveProviderPosted === true) {
          invokeOneshot({
            step: 'consume_wallet_fund_stepup',
            stepupId: stepup.id,
            intentId: row.id,
          });
          authConsumed = 'YES';
          productionMoneyMoved = true;
          result = 'POSTED';
        } else if (exec.outcome === 'unknown' || exec.outcome === 'conflict' || exec.doNotRetry === true) {
          result = 'UNKNOWN';
        } else {
          result = 'BLOCKED';
        }
        next = result === 'POSTED'
          ? 'Wait GET/webhook READ ONLY for funding completed AND live available >= $0.01. Do not Phase B. Do not fund again if Sweep removes the penny.'
          : 'STOP FOR REVIEW. Do not retry blindly. Do not Phase B.';
      } finally {
        const disarmed = setProductionPostFlag(false);
        flagsAfterPost = disarmed;
        productionPostArmed = 'NO';
        if (disarmed.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') {
          throw new Error('failed_to_disarm_production_post');
        }
        if (disarmed.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') {
          throw new Error('sandbox_post_still_armed');
        }
      }
      const walletAfter = await productionMoovFetch({
        credentials: prodCreds,
        path: `/accounts/${freedom.moovAccountId}/wallets/${freedom.walletId}`,
        method: 'GET',
        mode: 'read',
        scopes: [`/accounts/${freedom.moovAccountId}/wallets.read`],
      });
      const after = walletAfter?.json || walletAfter;
      liveAvailableAfter = amountCentsOf(after?.availableBalance ?? after?.available);
      livePendingAfter = amountCentsOf(after?.pendingBalance ?? after?.pending);
    }
  }

  const fundingKey = fundingIdempotencyKey(OPERATION, 1, 'production');
  const intent = persist?.intent || (persist?.fundingRows || rds.fundingRows || [])[0] || null;
  const card = {
    'FINAL PRECHECK': mismatches.length ? `FAIL ${mismatches.join(',')}` : `PASS lambda=${flags.state} freedom=production post=${flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED} sandbox_post=${flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED} bank=${bankVerified ? 'verified' : bank?.status} collect-funds=${collectFunds} fund_pm=${Boolean(fundPm)} wallet_pm=${Boolean(walletPm)}`,
    'LIVE AVAILABLE BEFORE': liveAvailable,
    'LIVE PENDING BEFORE': livePending,
    'DARK DECISION': dark.decision,
    'EXACT SHORTFALL': shortfall,
    'FUNDING INTENT ID': intent?.id || 'not_persisted',
    'FUNDING INTENT COUNT': persist?.fundingIntentCount ?? rds.fundingIntentCount ?? 0,
    'FUNDING AMOUNT': intent ? `${intent.amount_cents} cents` : 'n/a',
    'FUNDING IDEMPOTENCY': fundingKey,
    'WALLET.FUND HUMAN AUTHORIZATION': authState,
    'AUTHORIZATION ACTION': 'wallet.fund',
    'AUTHORIZATION AMOUNT': '$0.01',
    'AUTHORIZATION CONSUMED ONCE': authConsumed,
    'PRODUCTION POST ARMED': productionPostArmed,
    'PROVIDER POST COUNT': providerPostCount,
    'PROVIDER REQUEST ID': providerRequestId,
    'PROVIDER TRANSFER ID': providerTransferId === undefined ? (intent?.provider_transfer_id || 'null') : providerTransferId,
    'PROVIDER STATUS': providerStatus === 'n/a' ? (intent?.provider_status || 'n/a') : providerStatus,
    'PRODUCTION POST DISARMED': flagsAfterPost.flags.AWS_MOOV_TRANSFER_POST_ENABLED,
    'SANDBOX POST FLAG': flagsAfterPost.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED,
    'LIVE AVAILABLE AFTER': liveAvailableAfter,
    'LIVE PENDING AFTER': livePendingAfter,
    'PAYOUT PROVIDER POST COUNT': posted?.payout_provider_posts ?? 0,
    'WALLET.DISBURSE AUTHORIZATION CONSUMED': 'NO',
    'SECOND FUNDING CREATED': 'NO',
    'SWEEP CHANGED': 'NO',
    'PRODUCTION MONEY MOVED': productionMoneyMoved,
    'PHASE A RESULT': result,
    'NEXT REQUIRED ACTION': next,
  };

  writeCard(card, {
    identity,
    flags,
    flagsStill,
    live: { liveAvailable, livePending, bankStatus: bank?.status, collectFunds, fundPm: Boolean(fundPm), walletPm: Boolean(walletPm) },
    rds: {
      ok: rds.ok,
      freedom: rds.freedom,
      objects: rds.objects,
      fundingIntentCount: rds.fundingIntentCount,
      payoutIntentCount: rds.payoutIntentCount,
      conflictingFunding: rds.conflictingFunding,
      postedFunding: rds.postedFunding,
      walletFundStepups: rds.walletFundStepups,
      sweep: rds.sweep,
      owners: (rds.owners || []).map((row) => ({ user_id: row.user_id, role: row.role, email: row.email })),
    },
    dark: {
      ok: dark.ok,
      decision: dark.decision,
      shortfall_cents: dark.shortfall_cents,
      persist_money_intents: dark.persist_money_intents,
      liveProviderPosted: dark.liveProviderPosted,
      payout_submittable: dark.payout_submittable,
      payout_operation_id: dark.payout_operation_id,
    },
    persist: persist ? {
      ok: persist.ok,
      reused: persist.reused,
      created: persist.created,
      intentId: persist.intent?.id,
      provider_transfer_id: persist.intent?.provider_transfer_id,
      amount_cents: persist.intent?.amount_cents,
      leg_role: persist.intent?.leg_role,
      environment: persist.intent?.environment,
    } : null,
    mismatches,
  });
  if (mismatches.length || result === 'BLOCKED') process.exitCode = 2;
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
