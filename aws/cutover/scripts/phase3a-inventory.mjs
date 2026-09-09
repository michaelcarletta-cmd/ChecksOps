#!/usr/bin/env node
/**
 * Phase 3A read-only inventory runner.
 * Deploys inventory code only, invokes Lambda directly, never prints secrets.
 * Does not create checksops/production/providers, set PROVIDER_SECRETS_ARN,
 * apply SQL 65, lift flags, or call CheckAlt.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const FN = 'checksops-production-prep-api';
const ARTIFACTS = '/opt/cursor/artifacts';
const CF = 'https://checksops.com';
const RAW = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com';
const FLAG_KEYS = [
  'CHECKSOPS_ENV',
  'AWS_WRITES_ENABLED',
  'AWS_CHECK_WORKFLOW_WRITES_ENABLED',
  'AWS_STORAGE_WRITES_ENABLED',
  'AWS_APPLICATION_WORKFLOW_WRITES_ENABLED',
  'AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED',
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_MOOV_ENABLED',
  'AWS_CHECKALT_ENABLED',
  'AWS_PLAID_ENABLED',
  'AWS_ACTUM_ENABLED',
  'AWS_QUICKBOOKS_ENABLED',
  'AWS_PROVIDER_LIVE_READS_ENABLED',
  'AWS_PROVIDER_WEBHOOK_DRY_RUN',
  'AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED',
  'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
  'AWS_COGNITO_MFA_PREFERRED',
];

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}));

const safeLambdaSnapshot = (cfg) => {
  const env = cfg.Environment?.Variables || {};
  const flags = Object.fromEntries(FLAG_KEYS.map((key) => [key, env[key] ?? null]));
  return {
    functionName: cfg.FunctionName,
    codeSha256: cfg.CodeSha256,
    lastModified: cfg.LastModified,
    lastUpdateStatus: cfg.LastUpdateStatus,
    flags,
    providerSecretsArnSet: Boolean(env.PROVIDER_SECRETS_ARN),
    checkAltUsernameSet: Boolean(env.CHECKALT_USERNAME || env.CHECKALT_PASSWORD || env.CHECKALT_FI_KEY),
    checkAltUatSet: Boolean(env.CHECKALT_UAT_USER_ID || env.CHECKALT_UAT_PASSWORD || env.CHECKALT_UAT_FI_KEY),
    cognitoUserPoolId: env.COGNITO_USER_POOL_ID || null,
  };
};

const probe = async (url, init = {}) => {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { url, status: res.status, ms: Date.now() - started, json };
  } catch (error) {
    return { url, status: null, error: String(error.message || error).slice(0, 200), ms: Date.now() - started };
  }
};

const waitLambdaReady = () => {
  for (let i = 0; i < 30; i += 1) {
    const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', FN]);
    if (cfg.LastUpdateStatus === 'Successful') return cfg;
    if (cfg.LastUpdateStatus === 'Failed') {
      throw new Error(`lambda_update_failed:${cfg.LastUpdateStatusReason || 'unknown'}`);
    }
    execFileSync('sleep', ['2']);
  }
  throw new Error('lambda_update_timeout');
};

const describeSecret = (name) => {
  try {
    const desc = awsJson(['secretsmanager', 'describe-secret', '--secret-id', name]);
    return { name, exists: true, arnSet: Boolean(desc.ARN) };
  } catch (error) {
    const msg = String(error.stderr || error.message || error);
    if (/ResourceNotFoundException|not found/i.test(msg)) return { name, exists: false };
    return { name, exists: null, error: /AccessDenied|not authorized/i.test(msg) ? 'access_denied' : 'describe_failed' };
  }
};

const inspectSpa = async () => {
  const html = await fetch(`${CF}/`).then((res) => res.text());
  const assets = [...html.matchAll(/\/assets\/[A-Za-z0-9._-]+\.js/g)].map((row) => row[0]);
  const markers = {
    checkIntakeItemId: 0,
    stepUpAwsPath: 0,
    dualControlPath: 0,
    depositSubmit: 0,
    stagingBanner: 0,
  };
  const chunks = [];
  for (const asset of assets.slice(0, 12)) {
    const url = `${CF}${asset}`;
    const text = await fetch(url).then((res) => res.text());
    chunks.push({ asset, bytes: text.length });
    if (text.includes('check_intake_item_id')) markers.checkIntakeItemId += 1;
    if (text.includes('/auth/mfa/step-up')) markers.stepUpAwsPath += 1;
    if (text.includes('/financial/checkalt-dual-control')) markers.dualControlPath += 1;
    if (text.includes('deposit.submit')) markers.depositSubmit += 1;
    if (/AWS staging|staging\.checksops/i.test(text)) markers.stagingBanner += 1;
  }
  return {
    htmlBytes: html.length,
    assets,
    chunks,
    markers,
    has175Binding: markers.checkIntakeItemId > 0 && markers.stepUpAwsPath > 0 && markers.dualControlPath > 0,
  };
};

const cognitoMfa = (poolId, username) => {
  if (!poolId || !username) return { username, error: 'missing_pool_or_username' };
  try {
    const user = awsJson([
      'cognito-idp', 'admin-get-user',
      '--user-pool-id', poolId,
      '--username', username,
    ]);
    return {
      username,
      enabled: user.Enabled === true,
      userStatus: user.UserStatus || null,
      mfaOptions: user.UserMFASettingList || [],
      preferredMfa: user.PreferredMfaSetting || null,
      totpEnrolled: Array.isArray(user.UserMFASettingList) && user.UserMFASettingList.includes('SOFTWARE_TOKEN_MFA'),
    };
  } catch (error) {
    const msg = String(error.stderr || error.message || error);
    return {
      username,
      error: /AccessDenied|not authorized/i.test(msg) ? 'access_denied' : 'admin_get_user_failed',
    };
  }
};

const identity = awsJson(['sts', 'get-caller-identity']);
const beforeCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', FN]);
const before = safeLambdaSnapshot(beforeCfg);
const providerSecret = describeSecret('checksops/production/providers');
const stagingSecret = describeSecret('checksops/staging/providers');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const apiDir = path.join(root, 'aws/functions/api');
if (!fs.existsSync(path.join(apiDir, 'node_modules', 'pg'))) {
  execFileSync('npm', ['ci', '--omit=dev'], { cwd: apiDir, stdio: 'inherit' });
}
fs.mkdirSync(ARTIFACTS, { recursive: true });
const zipPath = path.join(ARTIFACTS, 'checksops-production-prep-api-phase3a.zip');
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
const zip = spawnSync('zip', ['-rq', zipPath, '.', '-x', '*.test.mjs', '-x', 'coverage/*'], {
  cwd: apiDir,
  encoding: 'utf8',
});
if (zip.status !== 0) throw new Error(`zip_failed:${zip.stderr || zip.stdout}`);

let deploy = { ok: false };
try {
  const updated = awsJson([
    'lambda', 'update-function-code',
    '--function-name', FN,
    '--zip-file', `fileb://${zipPath}`,
  ]);
  const ready = waitLambdaReady();
  deploy = {
    ok: true,
    codeSha256: ready.CodeSha256 || updated.CodeSha256,
    lastModified: ready.LastModified,
  };
} catch (error) {
  const msg = String(error.stderr || error.message || error);
  deploy = {
    ok: false,
    error: /AccessDenied|not authorized/i.test(msg) ? 'access_denied' : String(msg).slice(0, 300),
  };
}

const afterCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', FN]);
const after = safeLambdaSnapshot(afterCfg);

const payloadPath = path.join(ARTIFACTS, 'phase3a-invoke-payload.json');
const outPath = path.join(ARTIFACTS, 'phase3a-invoke-out.json');
fs.writeFileSync(payloadPath, JSON.stringify({ phase3aInventory: true }));
let inventory = { invoked: false };
try {
  execFileSync(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', FN,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', `fileb://${payloadPath}`,
    outPath,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const raw = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const body = raw?.body ? JSON.parse(raw.body) : raw;
  inventory = { invoked: true, statusCode: raw.statusCode || 200, body };
} catch (error) {
  const msg = String(error.stderr || error.message || error);
  inventory = {
    invoked: false,
    error: /AccessDenied|not authorized/i.test(msg) ? 'access_denied' : 'invoke_failed',
  };
}

const http = {
  cfHealth: await probe(`${CF}/prep/health`),
  cfReadiness: await probe(`${CF}/prep/ops/readiness`),
  cfFinancial: await probe(`${CF}/prep/financial/status`),
  rawHealth: await probe(`${RAW}/prep/health`),
};

const spa = await inspectSpa().catch((error) => ({ error: String(error.message || error).slice(0, 200) }));

const financialEmails = inventory.body?.authorization?.financialUsers?.map((row) => row.email).filter(Boolean) || [
  'mcarletta@freedomadj.com',
];
const totp = after.cognitoUserPoolId
  ? financialEmails.map((email) => cognitoMfa(after.cognitoUserPoolId, email))
  : [];

const leaked = JSON.stringify({ inventory, spa, totp }).match(/SHOULD-NOT-LEAK|password|SECRET|eyJ[A-Za-z0-9_-]{10,}/i);

const report = {
  phase: '3A',
  identityArn: identity.Arn,
  account: identity.Account,
  before,
  after,
  deploy,
  flagsUnchanged: JSON.stringify(before.flags) === JSON.stringify(after.flags)
    && before.providerSecretsArnSet === after.providerSecretsArnSet,
  providerSecret,
  stagingSecretExists: stagingSecret.exists === true,
  inventory,
  http: {
    cfHealth: http.cfHealth.status,
    cfReadiness: http.cfReadiness.status,
    cfFinancial: http.cfFinancial.status,
    rawHealth: http.rawHealth.status,
    readinessHolds: http.cfReadiness.json?.holds || null,
    productionExecution: http.cfFinancial.json?.productionExecution ?? null,
    webhookDryRun: http.cfReadiness.json?.flags?.AWS_PROVIDER_WEBHOOK_DRY_RUN
      ?? after.flags.AWS_PROVIDER_WEBHOOK_DRY_RUN,
  },
  spa,
  totp,
  secretLeakScanFailed: Boolean(leaked),
};

fs.writeFileSync(path.join(ARTIFACTS, 'phase3a-inventory.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
