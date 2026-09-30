#!/usr/bin/env node
/**
 * Gate 3B: add x-checksops-origin-verify on ProductionPrepHttpApi.
 * Never prints HeaderValue / SecretString. Waits until CloudFront Deployed.
 */
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
  refuseRequireMode,
  requireGate,
  requireStep3Temp,
  shouldExecute,
} from './lib.mjs';
import { enforceScriptGuard } from '../../scripts/deployment-guard/require-guard.mjs';

refuseRequireMode();
requireGate('CHECKSOPS_APPLY_GATE3B');

if (!shouldExecute()) {
  console.log(JSON.stringify({
    gate: '3B',
    distributionId: DISTRIBUTION_ID,
    originId: 'ProductionPrepHttpApi',
    headerName: HEADER_NAME,
    headerValuePrinted: false,
    note: 'Plan only. Set CHECKSOPS_STEP3_EXECUTE=1 to apply.',
  }));
  process.exit(2);
}

enforceScriptGuard({
  script: import.meta.url,
  target_environment: 'production',
  target_component: 'production-spa',
  deployment_type: 'cloudfront-update',
});

const identity = requireStep3Temp();
let secret;
try {
  secret = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', SECRET_NAME]);
} catch (err) {
  const msg = String(err?.message || err);
  if (/Access to KMS is not allowed|kms/i.test(msg)) {
    throw new Error(
      'get_secret_kms_denied. Keep Step3Temp KMS deny. Privileged operator must run aws/origin-verify/operator-apply-gate3b.mjs. See aws/cutover/API_PERIMETER_STEP3_OPERATOR_GATE3B.md',
    );
  }
  throw err;
}
const parsed = JSON.parse(secret.SecretString || '{}');
const current = String(parsed.current || '');
if (current.length < 32) throw new Error('secret_current_too_short');

const live = awsJson(['cloudfront', 'get-distribution-config', '--id', DISTRIBUTION_ID]);
const etag = live.ETag;
const cfg = live.DistributionConfig;
if (cfg.WebACLId !== WAF_ARN) throw new Error('refusing_to_drop_waf');
const origin = (cfg.Origins?.Items || []).find((o) => o.Id === 'ProductionPrepHttpApi');
if (!origin) throw new Error('missing_api_origin');
origin.CustomHeaders = {
  Quantity: 1,
  Items: [{ HeaderName: HEADER_NAME, HeaderValue: current }],
};

const tmp = path.join(os.tmpdir(), `cf-step3b-${process.pid}.json`);
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
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
}

let status = 'InProgress';
for (let i = 0; i < 60; i += 1) {
  status = awsText(['cloudfront', 'get-distribution', '--id', DISTRIBUTION_ID, '--query', 'Distribution.Status']);
  if (status === 'Deployed') break;
  await new Promise((r) => setTimeout(r, 15000));
}
if (status !== 'Deployed') throw new Error(`cloudfront_not_deployed ${status}`);

const check = awsJson(['cloudfront', 'get-distribution-config', '--id', DISTRIBUTION_ID]);
const api = (check.DistributionConfig.Origins?.Items || []).find((o) => o.Id === 'ProductionPrepHttpApi');
const header = (api?.CustomHeaders?.Items || []).find((h) => h.HeaderName === HEADER_NAME);
if (!header) throw new Error('header_name_missing');
if (check.DistributionConfig.WebACLId !== WAF_ARN) throw new Error('waf_dropped');

console.log(JSON.stringify({
  gate: '3B',
  identity,
  distributionId: DISTRIBUTION_ID,
  status,
  headerNamePresent: true,
  headerValuePrinted: false,
  customHeaderQuantity: api.CustomHeaders?.Quantity || 0,
  wafAttached: true,
}));
