#!/usr/bin/env node
/**
 * Privileged-operator Gate 3B only. Do not run as Step3Temp.
 * Do not start Gate 3C. Do not attach the authorizer.
 * Do not set ORIGIN_VERIFY_REQUIRE=true. Never prints the secret.
 *
 * Plan (default): prints guards and exits 2.
 * Preflight: CHECKSOPS_OPERATOR_PREFLIGHT=1 — read-only CF guards, no secret.
 * Apply: CHECKSOPS_OPERATOR_GATE3B=I_UNDERSTAND_PRODUCTION
 *        CHECKSOPS_OPERATOR_EXECUTE=1
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DISTRIBUTION_ID,
  HEADER_NAME,
  SECRET_NAME,
  WAF_ARN,
  awsJson,
  awsText,
  redactCli,
  refuseRequireMode,
} from './lib.mjs';

export const EXPECTED_API_ORIGIN = 'ProductionPrepHttpApi';
export const EXPECTED_API_DOMAIN = 'kiqojucc02.execute-api.us-east-1.amazonaws.com';
export const EXPECTED_PREP_CACHE = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
export const EXPECTED_PREP_ORP = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
export const EXPECTED_PREP_METHODS = ['HEAD', 'DELETE', 'POST', 'GET', 'OPTIONS', 'PUT', 'PATCH'];

refuseRequireMode();

const plan = {
  gate: '3B',
  operatorOnly: true,
  doNotUseStep3Temp: true,
  doNotBroadenStep3TempKms: true,
  distributionId: DISTRIBUTION_ID,
  originId: EXPECTED_API_ORIGIN,
  headerName: HEADER_NAME,
  headerValuePrinted: false,
  attachAuthorizer: false,
  startGate3C: false,
  ORIGIN_VERIFY_REQUIRE: false,
};

if (String(process.env.CHECKSOPS_OPERATOR_PREFLIGHT || '') === '1') {
  const report = preflightGuards();
  console.log(JSON.stringify({ ...plan, mode: 'preflight', ...report }));
  process.exit(report.ok ? 0 : 1);
}

if (String(process.env.CHECKSOPS_OPERATOR_GATE3B || '') !== 'I_UNDERSTAND_PRODUCTION'
  || String(process.env.CHECKSOPS_OPERATOR_EXECUTE || '') !== '1') {
  console.log(JSON.stringify({
    ...plan,
    note: 'Plan only. Privileged operator sets CHECKSOPS_OPERATOR_GATE3B=I_UNDERSTAND_PRODUCTION and CHECKSOPS_OPERATOR_EXECUTE=1. Do not use Step3Temp.',
  }));
  process.exit(2);
}

const identity = awsJson(['sts', 'get-caller-identity']);
const arn = String(identity.Arn || '');
if (arn.includes('ChecksOpsCursorApiPerimeterStep3Temp')) {
  throw new Error('refusing_step3temp. Keep the KMS deny. Run this script as a privileged operator.');
}

const current = readCurrentSecret();
const live = awsJson(['cloudfront', 'get-distribution-config', '--id', DISTRIBUTION_ID]);
const etag = live.ETag;
const cfg = live.DistributionConfig;
const distId = String(live.Distribution?.Id || DISTRIBUTION_ID);
assertGuards(cfg, distId);

const origin = (cfg.Origins?.Items || []).find((o) => o.Id === EXPECTED_API_ORIGIN);
origin.CustomHeaders = {
  Quantity: 1,
  Items: [{ HeaderName: HEADER_NAME, HeaderValue: current }],
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-gate3b-'));
fs.chmodSync(tmpDir, 0o700);
const tmp = path.join(tmpDir, 'distribution-config.json');
fs.writeFileSync(tmp, JSON.stringify(cfg), { mode: 0o600 });
try {
  awsJson([
    'cloudfront',
    'update-distribution',
    '--id',
    DISTRIBUTION_ID,
    '--if-match',
    etag,
    '--distribution-config',
    `file://${tmp}`,
  ]);
} finally {
  shredPath(tmp);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

let status = 'InProgress';
for (let i = 0; i < 60; i += 1) {
  status = awsText(['cloudfront', 'get-distribution', '--id', DISTRIBUTION_ID, '--query', 'Distribution.Status']);
  if (status === 'Deployed') break;
  await new Promise((r) => setTimeout(r, 15000));
}
if (status !== 'Deployed') throw new Error(`cloudfront_not_deployed ${status}`);

const after = publicDistributionGuard();
if (!after.ok) throw new Error(`post_update_guard_failed ${after.reason}`);
const health = await publicHealth();
if (!health.cloudfrontHealth || !health.rawHealth) throw new Error('post_update_health_failed');

console.log(JSON.stringify({
  ...plan,
  mode: 'applied',
  identityArnKind: arn.includes('assumed-role') ? 'assumed-role' : 'role',
  status,
  headerNamePresent: after.headerNamePresent,
  customHeaderQuantity: after.apiHeaderQty,
  wafUnchanged: after.wafOk,
  behaviorsUnchanged: after.behaviorsOk,
  cloudfrontHealth: health.cloudfrontHealth,
  rawHealth: health.rawHealth,
  headerValuePrinted: false,
  secretValuePrinted: false,
  startGate3C: false,
}));

function behaviorSnapshot(b) {
  return {
    PathPattern: b.PathPattern,
    TargetOriginId: b.TargetOriginId,
    CachePolicyId: b.CachePolicyId,
    OriginRequestPolicyId: b.OriginRequestPolicyId,
    ViewerProtocolPolicy: b.ViewerProtocolPolicy,
    Methods: [...(b.AllowedMethods?.Items || [])].sort(),
    Compress: b.Compress,
  };
}

function expectedPrep(pattern) {
  return {
    PathPattern: pattern,
    TargetOriginId: EXPECTED_API_ORIGIN,
    CachePolicyId: EXPECTED_PREP_CACHE,
    OriginRequestPolicyId: EXPECTED_PREP_ORP,
    ViewerProtocolPolicy: 'https-only',
    Methods: [...EXPECTED_PREP_METHODS].sort(),
    Compress: true,
  };
}

function sameBehavior(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function assertGuards(cfg, distId) {
  if (distId !== DISTRIBUTION_ID) throw new Error(`refusing_wrong_distribution ${distId}`);
  if (cfg.WebACLId !== WAF_ARN) throw new Error('refusing_waf_mismatch');
  const origin = (cfg.Origins?.Items || []).find((o) => o.Id === EXPECTED_API_ORIGIN);
  if (!origin) throw new Error('refusing_missing_api_origin');
  if (origin.DomainName !== EXPECTED_API_DOMAIN) throw new Error('refusing_wrong_api_origin_domain');
  const qty = Number(origin.CustomHeaders?.Quantity || 0);
  if (qty !== 0) throw new Error(`refusing_custom_headers_not_zero ${qty}`);
  const behaviors = cfg.CacheBehaviors?.Items || [];
  const prep = behaviors.find((b) => b.PathPattern === '/prep');
  const prepStar = behaviors.find((b) => b.PathPattern === '/prep/*');
  if (!prep || !sameBehavior(behaviorSnapshot(prep), expectedPrep('/prep'))) {
    throw new Error('refusing_prep_behavior_mismatch');
  }
  if (!prepStar || !sameBehavior(behaviorSnapshot(prepStar), expectedPrep('/prep/*'))) {
    throw new Error('refusing_prep_star_behavior_mismatch');
  }
}

function publicDistributionGuard() {
  const raw = awsJson(['cloudfront', 'get-distribution', '--id', DISTRIBUTION_ID]);
  const dist = raw.Distribution || {};
  const cfg = dist.DistributionConfig || {};
  const origin = (cfg.Origins?.Items || []).find((o) => o.Id === EXPECTED_API_ORIGIN) || {};
  const names = (origin.CustomHeaders?.Items || []).map((h) => h.HeaderName);
  const behaviors = cfg.CacheBehaviors?.Items || [];
  const prep = behaviors.find((b) => b.PathPattern === '/prep');
  const prepStar = behaviors.find((b) => b.PathPattern === '/prep/*');
  const report = {
    id: dist.Id,
    status: dist.Status,
    wafOk: cfg.WebACLId === WAF_ARN,
    originOk: origin.Id === EXPECTED_API_ORIGIN && origin.DomainName === EXPECTED_API_DOMAIN,
    apiHeaderQty: Number(origin.CustomHeaders?.Quantity || 0),
    headerNamePresent: names.includes(HEADER_NAME),
    behaviorsOk: Boolean(
      prep && prepStar
      && sameBehavior(behaviorSnapshot(prep), expectedPrep('/prep'))
      && sameBehavior(behaviorSnapshot(prepStar), expectedPrep('/prep/*')),
    ),
  };
  report.ok = report.id === DISTRIBUTION_ID && report.wafOk && report.originOk && report.behaviorsOk;
  report.reason = report.ok ? '' : 'guard_mismatch';
  return report;
}

function preflightGuards() {
  const live = awsJson(['cloudfront', 'get-distribution-config', '--id', DISTRIBUTION_ID]);
  try {
    assertGuards(live.DistributionConfig, DISTRIBUTION_ID);
    return {
      ok: true,
      wafOk: true,
      headersAreZero: true,
      behaviorsOk: true,
      distributionId: DISTRIBUTION_ID,
      headerValuePrinted: false,
    };
  } catch (err) {
    return { ok: false, reason: String(err.message || err), headerValuePrinted: false };
  }
}

function readCurrentSecret() {
  const secret = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', SECRET_NAME]);
  let current = '';
  try {
    const parsed = JSON.parse(secret.SecretString || '{}');
    current = String(parsed.current || '');
  } finally {
    if (secret && typeof secret === 'object') {
      secret.SecretString = '';
      delete secret.SecretString;
    }
  }
  if (current.length < 32) throw new Error('secret_current_too_short');
  return current;
}

async function publicHealth() {
  const cf = await fetch('https://checksops.com/prep/health', { headers: { accept: 'application/json' } });
  const raw = await fetch('https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/health', {
    headers: { accept: 'application/json' },
  });
  const cfJson = await cf.json().catch(() => ({}));
  const rawJson = await raw.json().catch(() => ({}));
  return {
    cloudfrontHealth: cf.status === 200 && cfJson.status === 'ok' && Boolean(cf.headers.get('x-amz-cf-id')),
    rawHealth: raw.status === 200 && rawJson.status === 'ok',
  };
}

function shredPath(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    fs.writeFileSync(filePath, Buffer.alloc(size));
  } catch { /* ignore */ }
  spawnSync('shred', ['-u', '-z', filePath], { encoding: 'utf8' });
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  void redactCli;
}
