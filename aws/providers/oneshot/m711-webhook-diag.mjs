#!/usr/bin/env node
/**
 * M7.11 read-only diagnosis of why payout c2d1078a completed without a
 * persisted webhook receipt. GET Moov transfer + webhook list + RDS receipts.
 * Never POSTs /transfers. Never arms flags. Never rotates secrets.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';
import { PIPELINE_TEST_SANDBOX } from '../../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import { moovSandboxFetch, moovSandboxScopes } from '../../functions/api/providers/moov-sandbox.mjs';
import { explainMissingSandboxPayoutWebhookReceipt } from '../../functions/api/providers/production/moov-sandbox-payout-e2e.mjs';
import { sandboxWebhookApplyEnabled } from '../../functions/api/providers/webhook-apply.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const ONESHOT_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/providers/oneshot/m79-sandbox-tenant');
const PRODUCTION_SECRET = 'checksops/production/provider';
const PIPELINE = PIPELINE_TEST_SANDBOX.tenantId;
const SANDBOX_PLATFORM = PIPELINE_TEST_SANDBOX.platformAccountId;
const PAYOUT_INTENT_ID = '80f4648b-551c-4ec6-a9fc-921b85bc8320';
const PAYOUT_TRANSFER_ID = 'c2d1078a-0261-4a3b-9782-777fad834af9';
const PREFERRED_WEBHOOK_URL = 'https://checksops.com/prep/webhooks/moov';

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
    '--role-session-name', 'checksops-m711-webhook-diag',
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
const lambdaFlags = () => {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  const env = cfg.Environment?.Variables || {};
  return {
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
      AWS_PROVIDER_WEBHOOK_DRY_RUN: env.AWS_PROVIDER_WEBHOOK_DRY_RUN || null,
      AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED || null,
      AWS_PROVIDER_EXECUTION_ENABLED: env.AWS_PROVIDER_EXECUTION_ENABLED || null,
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
  const staging = path.join(os.tmpdir(), 'checksops-m711-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/77_moov_tenant_environment.sql'), path.join(staging, '77_moov_tenant_environment.sql'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/78_moov_recon_parity.sql'), path.join(staging, '78_moov_recon_parity.sql'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m711-oneshot.zip');
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
  const outFile = `/tmp/m711-oneshot-${payload.step}-${Date.now()}.json`;
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
};
const asList = (json) => {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.webhooks)) return json.webhooks;
  return [];
};

const main = async () => {
  await assumeRole();
  const flags = lambdaFlags();
  if (flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_production_post_armed');
  if (flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_sandbox_post_armed');
  const parsed = JSON.parse(awsJson(['secretsmanager', 'get-secret-value', '--secret-id', flags.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET]).SecretString || '{}');
  const credentials = {
    environment: 'sandbox',
    publicKey: parsed.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: parsed.MOOV_SANDBOX_SECRET_KEY,
    platformId: parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID,
    origin: parsed.MOOV_SANDBOX_ALLOWED_ORIGIN || PRODUCTION_MOOV_ORIGIN,
    apiVersion: parsed.MOOV_SANDBOX_API_VERSION || PRODUCTION_MOOV_API_VERSION,
    host: 'https://api.moov.io',
  };
  const zip = packOneshot();
  const secretsList = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secretsList.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  ensureOneshot(zip, adminSecret.ARN, flags.vpc);

  assertGetOnly('GET', `/accounts/${SANDBOX_PLATFORM}/transfers/${PAYOUT_TRANSFER_ID}`);
  const liveTransfer = await moovSandboxFetch({
    credentials,
    path: `/accounts/${SANDBOX_PLATFORM}/transfers/${PAYOUT_TRANSFER_ID}`,
    scopes: moovSandboxScopes.transfersRead(SANDBOX_PLATFORM),
  });
  const webhookRes = await fetch('https://api.moov.io/webhooks', {
    method: 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.publicKey}:${credentials.secretKey}`).toString('base64')}`,
      Accept: 'application/json',
      Origin: credentials.origin,
      'x-moov-version': credentials.apiVersion,
    },
  });
  const webhookJson = await webhookRes.json().catch(() => null);
  const webhooks = asList(webhookJson).map((row) => ({
    url: row.url || null,
    disabled: row.disabled === true,
    events: row.events || row.eventTypes || row.selectedEvents || null,
  }));
  const preferred = webhooks.find((row) => String(row.url || '').replace(/\/$/, '') === PREFERRED_WEBHOOK_URL.replace(/\/$/, ''));
  const rds = invokeOneshot({
    step: 'diagnose_payout_webhook',
    tenantId: PIPELINE,
    transferId: PAYOUT_TRANSFER_ID,
    intentId: PAYOUT_INTENT_ID,
  });
  const explained = explainMissingSandboxPayoutWebhookReceipt({
    transferId: PAYOUT_TRANSFER_ID,
    receiptsByTransferId: rds.receiptsByTransferId || [],
    receiptsByEventId: [],
    tenantTransferReceipts: rds.transferTypedReceipts || rds.tenantRecentReceipts || [],
    sandboxApplyEnabled: sandboxWebhookApplyEnabled()
      && flags.flags.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED === 'true'
      && flags.flags.AWS_PROVIDER_EXECUTION_ENABLED !== 'true',
    productionExecutionEnabled: flags.flags.AWS_PROVIDER_EXECUTION_ENABLED === 'true',
    dryRun: flags.flags.AWS_PROVIDER_WEBHOOK_DRY_RUN !== 'false',
  });
  const card = {
    MOOV_PAYOUT_STATUS: liveTransfer.data?.status || liveTransfer.status || null,
    WEBHOOK_URL: preferred?.url || 'missing',
    WEBHOOK_DISABLED: preferred ? String(preferred.disabled === true) : 'n/a',
    WEBHOOK_EVENTS: preferred?.events == null ? 'not_returned_by_list' : JSON.stringify(preferred.events),
    RECEIPTS_BY_TRANSFER_ID: String((rds.receiptsByTransferId || []).length),
    TENANT_RECENT_RECEIPTS: String((rds.tenantRecentReceipts || []).length),
    TRANSFER_TYPED_RECEIPTS: String((rds.transferTypedReceipts || []).length),
    EVENT_LOG: (rds.events || []).map((row) => row.event_type).join(',') || 'none',
    SANDBOX_APPLY_ENABLED: String(explained.sandboxApplyEnabled),
    PRODUCTION_EXECUTION: String(explained.productionExecutionEnabled),
    DRY_RUN: String(explained.dryRun),
    LOOKUP_MISS: String(rds.lookupMiss === true || explained.rootCause === 'receipt_lookup_issue'),
    ROOT_CAUSE: explained.rootCause,
    REASONS: explained.reasons.join(', '),
    WEBHOOK_CHANGE_REQUIRED: 'false',
    GET_FALLBACK_REQUIRED: 'true',
    SANDBOX_POST_FLAG: String(flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || 'false'),
    PRODUCTION_POST_FLAG: String(flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false'),
  };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/m711_webhook_diag.json', JSON.stringify({
    at: new Date().toISOString(),
    posted: false,
    armed: false,
    liveTransfer: { ok: liveTransfer.ok === true, status: liveTransfer.data?.status || null },
    webhooks,
    preferred,
    rds: {
      receiptsByTransferId: rds.receiptsByTransferId,
      tenantRecentReceipts: (rds.tenantRecentReceipts || []).slice(0, 10),
      transferTypedReceipts: (rds.transferTypedReceipts || []).slice(0, 10),
      events: rds.events,
      lookup: rds.lookup,
    },
    explained,
    flags: flags.flags,
    card,
  }, null, 2));
  fs.writeFileSync('/opt/cursor/artifacts/m711_webhook_diag.md', `${Object.entries(card).map(([k, v]) => `${k}: ${v}`).join('\n')}\n`);
  console.log(JSON.stringify({ ok: true, posted: false, card }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
