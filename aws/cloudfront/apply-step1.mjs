#!/usr/bin/env node
/**
 * Apply CloudFront Step 1 (Gate 1) only.
 * Requires CHECKSOPS_APPLY_CF_STEP1=APPLY_GATE1 and the Steps12Temp role.
 * Does not rebuild the SPA. Does not disable execute-api. Does not attach origin-verify.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStep1Config } from './build-step1-config.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const DIST_ID = 'E1B0ZWWO5559U5';
const FN_NAME = 'checksops-production-spa-fallback';
const WAF = 'arn:aws:wafv2:us-east-1:806168576068:global/webacl/checksops-production-cloudfront-waf/cc8aadde-2bab-4d5e-8144-7d8981f44ad7';

if (process.env.CHECKSOPS_APPLY_CF_STEP1 !== 'APPLY_GATE1') {
  console.error('refusing: set CHECKSOPS_APPLY_CF_STEP1=APPLY_GATE1');
  process.exit(2);
}

console.error(JSON.stringify({
  error: 'production_cloudfront_cutover_locked',
  hint: 'Successful cutover lock: do not UpdateDistribution or repoint E1B0ZWWO5559U5 away from ProductionSpaS3.',
}));
process.exit(2);

const awsJson = (args, input) => {
  const r = spawnSync(AWS, ['--region', 'us-east-1', '--output', 'json', ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`${args.join(' ')} failed: ${(r.stderr || r.stdout || '').slice(0, 2000)}`);
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
};

const identity = awsJson(['sts', 'get-caller-identity']);
if (!String(identity.Arn || '').includes('ChecksOpsCursorApiPerimeterSteps12Temp')) {
  throw new Error(`refusing_wrong_identity ${identity.Arn}`);
}

const constants = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/cloudfront/step1-constants.json'), 'utf8'));
const codePath = path.join(ROOT, 'aws/cloudfront/spa-fallback.js');

let functionArn = constants.functionArn;
const listed = awsJson(['cloudfront', 'list-functions']);
const existing = (listed.FunctionList?.Items || []).find((f) => f.Name === FN_NAME);
if (!existing) {
  const created = awsJson([
    'cloudfront', 'create-function',
    '--name', FN_NAME,
    '--function-config', JSON.stringify({
      Comment: 'SPA deep-link fallback for S3 default behavior only. Does not run on /prep.',
      Runtime: 'cloudfront-js-2.0',
    }),
    '--function-code', `fileb://${codePath}`,
  ]);
  const etag = created.ETag;
  functionArn = created.FunctionSummary?.FunctionMetadata?.FunctionARN || functionArn;
  const published = awsJson(['cloudfront', 'publish-function', '--name', FN_NAME, '--if-match', etag]);
  functionArn = published.FunctionSummary?.FunctionMetadata?.FunctionARN || functionArn;
  console.log(JSON.stringify({ createdFunction: true, functionArn, publishStage: published.FunctionSummary?.FunctionMetadata?.Stage }));
} else {
  const described = awsJson(['cloudfront', 'describe-function', '--name', FN_NAME, '--stage', 'DEVELOPMENT']);
  const etag = described.ETag;
  const published = awsJson(['cloudfront', 'publish-function', '--name', FN_NAME, '--if-match', etag]);
  functionArn = published.FunctionSummary?.FunctionMetadata?.FunctionARN
    || described.FunctionSummary?.FunctionMetadata?.FunctionARN
    || functionArn;
  console.log(JSON.stringify({ createdFunction: false, functionArn }));
}

const live = awsJson(['cloudfront', 'get-distribution-config', '--id', DIST_ID]);
const etag = live.ETag;
const cfg = live.DistributionConfig;
fs.writeFileSync('/tmp/cf-E1B0ZWWO5559U5.rollback.json', JSON.stringify(live, null, 2));

if (cfg.WebACLId !== WAF) throw new Error('refusing_to_drop_waf');
if (!cfg.Aliases?.Items?.includes('checksops.com') || !cfg.Aliases?.Items?.includes('www.checksops.com')) {
  throw new Error('refusing_to_drop_aliases');
}
if (!String(cfg.ViewerCertificate?.ACMCertificateArn || '').includes('5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3')) {
  throw new Error('refusing_to_drop_cert');
}
if (!cfg.Logging?.Enabled) throw new Error('refusing_to_drop_logging');

const proposed = buildStep1Config(cfg, functionArn);
if (proposed.WebACLId !== WAF) throw new Error('proposed_dropped_waf');
if (proposed.Origins.Items.some((o) => (o.CustomHeaders?.Quantity || 0) > 0)) {
  throw new Error('refusing_origin_verify_header');
}
if (JSON.stringify(proposed).includes('x-checksops-origin-verify')) {
  throw new Error('refusing_origin_verify_header');
}

const updatePath = '/tmp/cf-E1B0ZWWO5559U5.step1.update.json';
fs.writeFileSync(updatePath, JSON.stringify(proposed));
const updated = awsJson([
  'cloudfront', 'update-distribution',
  '--id', DIST_ID,
  '--if-match', etag,
  '--distribution-config', `file://${updatePath}`,
]);
console.log(JSON.stringify({
  updated: true,
  id: updated.Distribution?.Id,
  status: updated.Distribution?.Status,
  etag: updated.ETag,
  webACL: updated.Distribution?.DistributionConfig?.WebACLId,
  origins: (updated.Distribution?.DistributionConfig?.Origins?.Items || []).map((o) => o.Id),
  behaviors: (updated.Distribution?.DistributionConfig?.CacheBehaviors?.Items || []).map((b) => b.PathPattern),
  customErrors: updated.Distribution?.DistributionConfig?.CustomErrorResponses?.Quantity,
}));
