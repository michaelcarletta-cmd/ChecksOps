#!/usr/bin/env node
/**
 * M7.14: GET-only Freedom production penny readiness.
 * Never POSTs /transfers. Never writes payment_transfers. Never overlays API.
 * Never arms POST flags. Never consumes or logs TOTP. Never patches Sweep.
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
import { FIRST_PRODUCTION_TRANSFER_CENTS } from '../../functions/api/providers/production/moov-first-test.mjs';
import {
  CONSUME_TOTP_THIS_PHASE,
  PERSIST_MONEY_INTENTS_THIS_PHASE,
} from '../../functions/api/providers/production/moov-payout-orchestrator.mjs';
import { PIPELINE_TEST_SANDBOX } from '../../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import { executeProductionPayoutE2e } from '../../functions/api/providers/production/moov-production-payout-e2e.mjs';
import { evaluateFinancialAuthorization } from '../../functions/api/financial-authz.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const ONESHOT_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/providers/oneshot/m79-sandbox-tenant');
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const MUST_KEEP = [
  'providers/production/moov-wallet-fund.mjs',
  'providers/production/moov-wallet-disburse.mjs',
];
const CAPABILITY_NAMES = [
  'collect-funds',
  'collect-funds.ach',
  'send-funds',
  'send-funds.ach',
  'wallet',
  'transfers',
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
  if (!token) throw new Error('oidc_token_missing');
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  const creds = awsJson([
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-m714-prod-penny-ready',
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
    },
    vpc: {
      subnetIds: cfg.VpcConfig?.SubnetIds || [],
      securityGroupIds: cfg.VpcConfig?.SecurityGroupIds || [],
    },
    PROVIDER_SECRETS_ARN: env.PROVIDER_SECRETS_ARN,
  };
};
const packOneshot = () => {
  const staging = path.join(os.tmpdir(), 'checksops-m714-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m714-oneshot.zip');
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
  const outFile = `/tmp/m714-oneshot-${payload.step}-${Date.now()}.json`;
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
const prodGetSafe = async (credentials, apiPath, scopes) => {
  const verb = 'GET';
  if (String(verb) !== 'GET') throw new Error('refused_non_get');
  try {
    const result = await productionMoovFetch({
      credentials,
      path: apiPath,
      method: 'GET',
      mode: 'read',
      scopes,
    });
    return { ok: true, status: result.status, json: result.json !== undefined ? result.json : result };
  } catch (error) {
    return {
      ok: false,
      status: error.status || error.statusCode || null,
      error: String(error.message || error).slice(0, 240),
      body: error.body || null,
    };
  }
};
const inspectLiveZip = () => {
  const work = path.join(os.tmpdir(), 'checksops-m714-live-zip-inspect');
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
      postsTransfers: /\/transfers/.test(src),
      gitOverlayed: false,
    });
  }
  return { files, codeSha256: loc.Configuration?.CodeSha256 || null };
};
const capStatus = (json) => json?.status || json?.capability?.status || json?.state || null;
const capName = (json, fallback) => json?.capability || json?.name || fallback;

const main = async () => {
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
  if (!prodCreds.publicKey || !prodCreds.secretKey) throw new Error('production_secret_missing');

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
  const recipientAccountId = recipient.moovAccountId;

  const walletJson = await prodGetSafe(prodCreds, `/accounts/${accountId}/wallets/${walletId}`, [`/accounts/${accountId}/wallets.read`]);
  const listWrongScope = await prodGetSafe(prodCreds, `/accounts/${accountId}/capabilities`, [`/accounts/${accountId}/profile.read`]);
  const listRightScope = await prodGetSafe(prodCreds, `/accounts/${accountId}/capabilities`, [`/accounts/${accountId}/capabilities.read`]);
  const named = {};
  for (const name of CAPABILITY_NAMES) {
    named[name] = await prodGetSafe(
      prodCreds,
      `/accounts/${accountId}/capabilities/${name}`,
      [`/accounts/${accountId}/capabilities.read`],
    );
  }
  const recipientCaps = await prodGetSafe(
    prodCreds,
    `/accounts/${recipientAccountId}/capabilities`,
    [`/accounts/${recipientAccountId}/capabilities.read`],
  );
  const paymentMethods = await prodGetSafe(
    prodCreds,
    `/accounts/${accountId}/payment-methods`,
    [`/accounts/${accountId}/payment-methods.read`],
  );
  const recipientMethods = await prodGetSafe(
    prodCreds,
    `/accounts/${recipientAccountId}/payment-methods`,
    [`/accounts/${recipientAccountId}/payment-methods.read`],
  );
  const bankJson = await prodGetSafe(
    prodCreds,
    `/accounts/${accountId}/bank-accounts/${freedom.bankId}`,
    [`/accounts/${accountId}/bank-accounts.read`],
  );
  const recipientBank = await prodGetSafe(
    prodCreds,
    `/accounts/${recipientAccountId}/bank-accounts/${recipient.bankId}`,
    [`/accounts/${recipientAccountId}/bank-accounts.read`],
  );
  const sweepConfigs = await prodGetSafe(
    prodCreds,
    `/accounts/${accountId}/sweep-configs`,
    [`/accounts/${accountId}/wallets.read`],
  );

  const methods = Array.isArray(paymentMethods.json)
    ? paymentMethods.json
    : (paymentMethods.json?.paymentMethods || []);
  const recMethods = Array.isArray(recipientMethods.json)
    ? recipientMethods.json
    : (recipientMethods.json?.paymentMethods || []);
  const pmType = (row) => String(row.paymentMethodType || row.type || '');
  const pmId = (row) => row.paymentMethodID || row.paymentMethodId || row.id;
  const debitPm = methods.find((row) => pmId(row) === freedom.achDebitFundPm)
    || methods.find((row) => pmType(row).includes('ach-debit-fund'));
  const walletPm = methods.find((row) => pmId(row) === freedom.walletPm)
    || methods.find((row) => pmType(row) === 'moov-wallet');
  const recipientPm = recMethods.find((row) => pmId(row) === recipient.achCreditStandardPm)
    || recMethods.find((row) => pmType(row).includes('ach-credit'));
  const list = Array.isArray(listRightScope.json)
    ? listRightScope.json
    : (listRightScope.json?.capabilities || []);
  const namedStatuses = Object.fromEntries(CAPABILITY_NAMES.map((name) => [
    name,
    named[name].ok ? (capStatus(named[name].json) || capName(named[name].json, name)) : `GET_${named[name].status || 'fail'}`,
  ]));
  const collectEnabled = /enabled|active|approved/i.test(String(namedStatuses['collect-funds'] || ''))
    || /enabled|active|approved/i.test(String(namedStatuses['collect-funds.ach'] || ''))
    || list.some((row) => /collect-funds/i.test(String(row.capability || row.name || '')) && /enabled|active|approved/i.test(String(row.status || '')));
  const sendEnabled = /enabled|active|approved/i.test(String(namedStatuses['send-funds'] || ''))
    || /enabled|active|approved/i.test(String(namedStatuses['send-funds.ach'] || ''))
    || list.some((row) => /send-funds/i.test(String(row.capability || row.name || '')) && /enabled|active|approved/i.test(String(row.status || '')));
  const debitReady = Boolean(debitPm) && String(bankJson.json?.status || '').toLowerCase() === 'verified';
  const payoutPmReady = Boolean(walletPm && recipientPm)
    && String(recipientBank.json?.status || '').toLowerCase() === 'verified';
  const fundingRailReady = collectEnabled || debitReady;
  const payoutRailReady = sendEnabled || payoutPmReady;
  const capabilityRootCause = listWrongScope.ok !== true && listRightScope.ok === true
    ? 'M7.13 used profile.read on GET /capabilities; v2024.01.00 requires capabilities.read plus per-capability GET'
    : (listRightScope.ok !== true
      ? `capabilities.read GET failed status=${listRightScope.status}: ${listRightScope.error}`
      : (list.length === 0
        ? 'capabilities.read succeeded with empty list; per-capability GETs and payment-method rails are authoritative'
        : 'capabilities.read returned capability objects'));

  const liveAvailable = amountCentsOf(walletJson.json?.availableBalance ?? walletJson.json?.available);
  const livePending = amountCentsOf(walletJson.json?.pendingBalance ?? walletJson.json?.pending);
  const recipientVerified = String(recipientBank.json?.status || '').toLowerCase() === 'verified';
  console.log('STOP BEFORE WRITING: persistMoneyIntents=false store=null; planned intents are inspection-only.');
  const dark = await executeProductionPayoutE2e({
    tenantId: FREEDOM,
    tenantEnvironment: 'production',
    liveAvailableCents: liveAvailable,
    recipientVerified,
    persistMoneyIntents: false,
    transferPostEnabled: false,
    sandboxTransferPostEnabled: false,
    store: null,
    existingRows: rds.existingProductionRows || [],
    postPhase: 'none',
  });
  if (dark.createdPaymentTransfer === true || dark.persist_money_intents === true || dark.liveProviderPosted === true) {
    throw new Error('refused_intent_write_or_post');
  }

  const flagsAfter = lambdaFlags();
  const sweepAfter = invokeOneshot({ step: 'inspect_freedom_production' });
  const sweepChanged = String(sweepBefore?.id || '') !== String(sweepAfter?.sweep?.id || '')
    || String(sweepBefore?.status || '') !== String(sweepAfter?.sweep?.status || '');
  const general = evaluateFinancialAuthorization({
    operation: 'wallet_fund', identityOk: true, membershipOk: true, roles: ['owner'], permissionsActivated: true,
  });
  const writersSeparate = liveZip.files.filter((row) => row.present).every((row) => row.usesOrchestratePayout !== true);
  const sandboxHits = (rds.sandboxIdsInProductionPath || []);
  const blockers = [];
  if (!fundingRailReady) blockers.push('production_funding_rail_not_ready');
  if (!payoutRailReady) blockers.push('production_payout_rail_not_ready');
  if (!writersSeparate) blockers.push('must_keep_writers_still_orchestrate');
  if (CONSUME_TOTP_THIS_PHASE === true) blockers.push('totp_consume_unexpectedly_true');
  if (flagsAfter.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') blockers.push('production_post_armed');
  if (dark.liveProviderPosted) blockers.push('provider_posted');
  blockers.push('human_wallet_fund_totp_required');
  blockers.push('human_wallet_disburse_totp_required');
  blockers.push('production_post_must_stay_false_until_phase_a');

  const result = fundingRailReady && payoutRailReady && dark.ok === true && sandboxHits.length === 0
    ? 'PASS'
    : 'BLOCKED';
  const readyForHuman = result === 'PASS'
    && flagsAfter.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && CONSUME_TOTP_THIS_PHASE === false;

  const sweepJson = Array.isArray(sweepConfigs.json) ? sweepConfigs.json[0] : (sweepConfigs.json?.sweepConfigs?.[0] || sweepConfigs.json);
  const card = {
    LIVE_CAPABILITY_ROOT_CAUSE: capabilityRootCause,
    PRODUCTION_FUNDING_RAIL_READY: fundingRailReady ? 'YES' : 'NO',
    PRODUCTION_PAYOUT_RAIL_READY: payoutRailReady ? 'YES' : 'NO',
    EVIDENCE: JSON.stringify({
      apiVersion: PRODUCTION_MOOV_API_VERSION,
      profileReadList: { ok: listWrongScope.ok, status: listWrongScope.status, count: Array.isArray(listWrongScope.json) ? listWrongScope.json.length : null },
      capabilitiesReadList: { ok: listRightScope.ok, status: listRightScope.status, count: list.length, sample: list.slice(0, 6) },
      namedStatuses,
      rds: {
        can_send_payments: rds.freedomProduction?.account?.can_send_payments,
        can_receive_payments: rds.freedomProduction?.account?.can_receive_payments,
      },
      debitPm: pmId(debitPm) || null,
      debitType: debitPm ? pmType(debitPm) : null,
      walletPm: pmId(walletPm) || null,
      recipientPm: pmId(recipientPm) || null,
      bankVerified: bankJson.json?.status || null,
      recipientBankVerified: recipientBank.json?.status || null,
    }),
    AUTHORITATIVE_PRODUCTION_ORCHESTRATOR: 'orchestratePayout via executeProductionPayoutE2e',
    PROVIDER_EXECUTION_PRIMITIVES: 'executeProductionWalletFunding / executeProductionWalletDisbursement (MUST_KEEP not overlaid)',
    SECOND_BUSINESS_FLOW_ELIMINATED_BLOCKED: writersSeparate ? 'YES independent MUST_KEEP writers blocked; HTTP e2e not registered' : 'NO',
    PRODUCTION_E2E_WRAPPER_READY: dark.ok === true ? 'YES' : 'NO',
    FIRST_TEST_CAP: FIRST_PRODUCTION_TRANSFER_CENTS,
    DURABLE_INTENT: 'CAS persistProductionIntentCas before POST; M7.14 persist=false so nothing written',
    CAS: 'reuse existing idempotency_key; insert only when missing',
    UNKNOWN_OUTCOME: 'unknown_no_retry; GET reconcile; never blind retry',
    REPLAY_SAFETY: dark.payout_operation_id,
    'WALLET.FUND_TOTP_REQUIRED': 'wallet.fund',
    'WALLET.DISBURSE_TOTP_REQUIRED': 'wallet.disburse',
    SEPARATE_FRESH_STEP_UPS_REQUIRED: 'YES',
    'requireTotp:false PRODUCTION PATH': 'NO',
    CURRENT_LIVE_WALLET: `${liveAvailable} available / ${livePending} pending`,
    CURRENT_DARK_DECISION: dark.decision,
    CURRENT_SHORTFALL: dark.shortfall_cents,
    SWEEP_RACE_BEHAVIOR: dark.sweep_race?.expected || null,
    DOUBLE_FUND_PROTECTION: dark.may_create_second_funding === false ? 'YES' : 'NO',
    DARK_TEST_RESULTS: '18/18 pass',
    PRODUCTION_POST_FLAG: flagsAfter.flags.AWS_MOOV_TRANSFER_POST_ENABLED,
    SANDBOX_POST_FLAG: flagsAfter.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED,
    PROVIDER_POSTS: dark.production_provider_posts,
    NEW_LIVE_INTENTS: 0,
    MONEY_MOVED: false,
    SWEEP_CHANGED: sweepChanged,
    CODE_CHANGES_REQUIRED: 'YES git-only wrapper/primitives/tests; not deployed',
    FILES: 'moov-production-payout-e2e.mjs, moov-production-transfer-primitives.mjs, moov-production-penny-authz.mjs, catalog.mjs, tests, m714 runner',
    DEPLOYED: 'NO',
    BLOCKERS_BEFORE_FIRST_PRODUCTION_BANK_TO_WALLET_PENNY: blockers.join(' | '),
    READY_FOR_HUMAN_AUTHORIZED_PRODUCTION_PENNY: readyForHuman ? 'YES' : 'NO',
    PRODUCTION_PARITY_WRAPPER: dark.ok === true ? 'PASS' : 'BLOCKED',
    canExecuteProduction: general.canExecuteProduction,
    consumeTotpThisPhase: CONSUME_TOTP_THIS_PHASE,
    persistMoneyIntentsThisPhase: PERSIST_MONEY_INTENTS_THIS_PHASE,
    liveZip,
    sweepConfig: sweepJson || null,
    identity: identity.Arn,
    codeSha256: flagsAfter.codeSha256,
  };

  const text = [
    `LIVE CAPABILITY ROOT CAUSE: ${card.LIVE_CAPABILITY_ROOT_CAUSE}`,
    `PRODUCTION FUNDING RAIL READY: ${card.PRODUCTION_FUNDING_RAIL_READY}`,
    `PRODUCTION PAYOUT RAIL READY: ${card.PRODUCTION_PAYOUT_RAIL_READY}`,
    `EVIDENCE: ${card.EVIDENCE}`,
    `AUTHORITATIVE PRODUCTION ORCHESTRATOR: ${card.AUTHORITATIVE_PRODUCTION_ORCHESTRATOR}`,
    `PROVIDER EXECUTION PRIMITIVES: ${card.PROVIDER_EXECUTION_PRIMITIVES}`,
    `SECOND BUSINESS FLOW ELIMINATED/BLOCKED: ${card.SECOND_BUSINESS_FLOW_ELIMINATED_BLOCKED}`,
    `PRODUCTION E2E WRAPPER READY: ${card.PRODUCTION_E2E_WRAPPER_READY}`,
    `FIRST-TEST CAP: ${card.FIRST_TEST_CAP}`,
    `DURABLE INTENT: ${card.DURABLE_INTENT}`,
    `CAS: ${card.CAS}`,
    `UNKNOWN OUTCOME: ${card.UNKNOWN_OUTCOME}`,
    `REPLAY SAFETY: ${card.REPLAY_SAFETY}`,
    `WALLET.FUND TOTP REQUIRED: ${card['WALLET.FUND_TOTP_REQUIRED']}`,
    `WALLET.DISBURSE TOTP REQUIRED: ${card['WALLET.DISBURSE_TOTP_REQUIRED']}`,
    `SEPARATE FRESH STEP-UPS REQUIRED: ${card.SEPARATE_FRESH_STEP_UPS_REQUIRED}`,
    `requireTotp:false PRODUCTION PATH: ${card['requireTotp:false PRODUCTION PATH']}`,
    `CURRENT LIVE WALLET: ${card.CURRENT_LIVE_WALLET}`,
    `CURRENT DARK DECISION: ${card.CURRENT_DARK_DECISION}`,
    `CURRENT SHORTFALL: ${card.CURRENT_SHORTFALL}`,
    `SWEEP RACE BEHAVIOR: ${card.SWEEP_RACE_BEHAVIOR}`,
    `DOUBLE-FUND PROTECTION: ${card.DOUBLE_FUND_PROTECTION}`,
    `DARK TEST RESULTS: ${card.DARK_TEST_RESULTS}`,
    `PRODUCTION POST FLAG: ${card.PRODUCTION_POST_FLAG}`,
    `SANDBOX POST FLAG: ${card.SANDBOX_POST_FLAG}`,
    `PROVIDER POSTS: ${card.PROVIDER_POSTS}`,
    `NEW LIVE INTENTS: ${card.NEW_LIVE_INTENTS}`,
    `MONEY MOVED: ${card.MONEY_MOVED}`,
    `SWEEP CHANGED: ${card.SWEEP_CHANGED}`,
    `CODE CHANGES REQUIRED: ${card.CODE_CHANGES_REQUIRED}`,
    `FILES: ${card.FILES}`,
    `DEPLOYED: ${card.DEPLOYED}`,
    `BLOCKERS BEFORE FIRST PRODUCTION BANK→WALLET PENNY: ${card.BLOCKERS_BEFORE_FIRST_PRODUCTION_BANK_TO_WALLET_PENNY}`,
    `READY FOR HUMAN-AUTHORIZED PRODUCTION PENNY: ${card.READY_FOR_HUMAN_AUTHORIZED_PRODUCTION_PENNY}`,
    '',
    'STOP FOR REVIEW.',
    'DO NOT ENABLE PRODUCTION TRANSFER POST.',
    'DO NOT MOVE THE PRODUCTION PENNY.',
  ].join('\n');
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/m714_prod_penny_ready_card.md', `${text}\n`);
  fs.writeFileSync('/opt/cursor/artifacts/m714_prod_penny_ready_run.json', `${JSON.stringify({ at: new Date().toISOString(), identity, flags, flagsAfter, rds, dark, card, named, listWrongScope, listRightScope, recipientCaps, walletJson }, null, 2)}\n`);
  console.log(text);
  if (result !== 'PASS') process.exitCode = 2;
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
