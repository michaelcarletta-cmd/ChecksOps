#!/usr/bin/env node
/**
 * Batch 2 apply: production CORS, API throttle, access logs, WAF attach attempt.
 * Does not change staging. Does not enable financial/provider flags.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const DIST = 'E1B0ZWWO5559U5';
const API_ID = 'kiqojucc02';
const STAGING_API_ID = 'psr19uhop4';
const PREP = 'checksops-production-prep-api';
const LOG_BUCKET = 'checksops-production-access-logs-806168576068';
const API_LOG_GROUP = '/aws/apigateway/checksops-production-prep-http';
const CF_LOG_PREFIX = `cloudfront/${DIST}/`;
const RETENTION_DAYS = 90;
const THROTTLE_RATE = 50;
const THROTTLE_BURST = 100;
const ACCESS_LOG_FORMAT = JSON.stringify({
  requestId: '$context.requestId',
  ip: '$context.identity.sourceIp',
  method: '$context.httpMethod',
  path: '$context.path',
  status: '$context.status',
  protocol: '$context.protocol',
  responseLength: '$context.responseLength',
  integrationStatus: '$context.integrationStatus',
  error: '$context.error.messageString',
});

if (!process.argv.includes('--confirm-batch2')) {
  console.error(JSON.stringify({ error: 'refusing_batch2_apply' }));
  process.exit(2);
}

const run = (args, extra = {}) => {
  try {
    const out = execFileSync(AWS, ['--region', extra.region || REGION, '--output', extra.output || 'json', ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: extra.stdio,
    });
    if (extra.output === 'text') return { ok: true, text: String(out || '').trim() };
    const trimmed = String(out || '').trim();
    if (!trimmed) return { ok: true, data: {} };
    try { return { ok: true, data: JSON.parse(trimmed) }; } catch { return { ok: true, data: { raw: trimmed.slice(0, 240) } }; }
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    return {
      ok: false,
      action: (text.match(/perform: ([a-z0-9:]+)/i) || [])[1] || null,
      denied: /AccessDenied|not authorized/i.test(text),
      message: text.slice(0, 500),
    };
  }
};

const attempts = [];
const record = (step, result) => {
  attempts.push({ step, ok: result.ok, denied: result.denied || false, action: result.action || null, message: result.ok ? null : result.message });
  return result;
};

const cors = record('updateApiCors', run([
  'apigatewayv2', 'update-api',
  '--api-id', API_ID,
  '--cors-configuration', JSON.stringify({
    AllowOrigins: ['https://checksops.com', 'https://www.checksops.com'],
    AllowHeaders: ['authorization', 'content-type', 'x-request-id', 'x-bridge-secret'],
    AllowMethods: ['GET', 'POST', 'OPTIONS'],
    MaxAge: 86400,
  }),
]));

record('createApiLogGroup', run(['logs', 'create-log-group', '--log-group-name', API_LOG_GROUP]));
record('apiLogRetention', run(['logs', 'put-retention-policy', '--log-group-name', API_LOG_GROUP, '--retention-in-days', String(RETENTION_DAYS)]));
record('apiLogResourcePolicy', run([
  'logs', 'put-resource-policy',
  '--policy-name', 'checksops-production-apigw-access-logs',
  '--policy-document', JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Sid: 'ApiGatewayAccessLogs',
      Effect: 'Allow',
      Principal: { Service: 'apigateway.amazonaws.com' },
      Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      Resource: `arn:aws:logs:${REGION}:806168576068:log-group:${API_LOG_GROUP}:*`,
    }],
  }),
]));

const stageUpdate = record('updateStageThrottleAndAccessLogs', run([
  'apigatewayv2', 'update-stage',
  '--api-id', API_ID,
  '--stage-name', 'prep',
  '--default-route-settings', JSON.stringify({
    ThrottlingRateLimit: THROTTLE_RATE,
    ThrottlingBurstLimit: THROTTLE_BURST,
    DetailedMetricsEnabled: false,
  }),
  '--access-log-settings', JSON.stringify({
    DestinationArn: `arn:aws:logs:${REGION}:806168576068:log-group:${API_LOG_GROUP}`,
    Format: ACCESS_LOG_FORMAT,
  }),
]));

record('createLogBucket', run(['s3api', 'create-bucket', '--bucket', LOG_BUCKET]));
record('logBucketPublicBlock', run(['s3api', 'put-public-access-block', '--bucket', LOG_BUCKET, '--public-access-block-configuration', JSON.stringify({
  BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
})]));
record('logBucketEncryption', run(['s3api', 'put-bucket-encryption', '--bucket', LOG_BUCKET, '--server-side-encryption-configuration', JSON.stringify({
  Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
})]));
record('logBucketLifecycle', run(['s3api', 'put-bucket-lifecycle-configuration', '--bucket', LOG_BUCKET, '--lifecycle-configuration', JSON.stringify({
  Rules: [{ ID: 'expire-90-days', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: RETENTION_DAYS } }],
})]));
record('logBucketOwnership', run(['s3api', 'put-bucket-ownership-controls', '--bucket', LOG_BUCKET, '--ownership-controls', JSON.stringify({
  Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }],
})]));
// Legacy CloudFront ACL grant is invalid in this account (Invalid id).
// Standard logging v2 is enabled by hardening-batch2-logging-v2.mjs instead.
record('logBucketPolicy', run(['s3api', 'put-bucket-policy', '--bucket', LOG_BUCKET, '--policy', JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AllowCloudFrontLogDelivery',
      Effect: 'Allow',
      Principal: { Service: 'delivery.logs.amazonaws.com' },
      Action: ['s3:PutObject', 's3:GetBucketAcl'],
      Resource: [`arn:aws:s3:::${LOG_BUCKET}`, `arn:aws:s3:::${LOG_BUCKET}/*`],
      Condition: { StringEquals: { 'aws:SourceAccount': '806168576068' } },
    },
    {
      Sid: 'DenyInsecureTransport',
      Effect: 'Deny',
      Principal: '*',
      Action: 's3:*',
      Resource: [`arn:aws:s3:::${LOG_BUCKET}`, `arn:aws:s3:::${LOG_BUCKET}/*`],
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    },
  ],
})]));

const dist = run(['cloudfront', 'get-distribution', '--id', DIST]);
if (dist.ok && dist.data.Distribution?.DistributionConfig) {
  const cfg = JSON.parse(JSON.stringify(dist.data.Distribution.DistributionConfig));
  const etag = dist.data.ETag;
  cfg.Logging = {
    Enabled: true,
    IncludeCookies: false,
    Bucket: `${LOG_BUCKET}.s3.amazonaws.com`,
    Prefix: CF_LOG_PREFIX,
  };
  const cfgPath = '/tmp/security/cf-batch2-logging.json';
  mkdirSync('/tmp/security', { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(cfg));
  record('enableCloudFrontLogging', run([
    'cloudfront', 'update-distribution',
    '--id', DIST,
    '--if-match', etag,
    '--distribution-config', `file://${cfgPath}`,
  ]));
} else {
  record('enableCloudFrontLogging', { ok: false, denied: Boolean(dist.denied), message: dist.message || 'missing_distribution_config' });
}

const waitCloudFrontDeployed = (label) => {
  for (let i = 0; i < 36; i += 1) {
    const current = run(['cloudfront', 'get-distribution', '--id', DIST]);
    const status = current.data.Distribution?.Status;
    if (status === 'Deployed') {
      record(label, { ok: true, message: `deployed_after_${i}` });
      return current;
    }
    execFileSync('sleep', ['10']);
  }
  record(label, { ok: false, message: 'cloudfront_still_in_progress' });
  return run(['cloudfront', 'get-distribution', '--id', DIST]);
};
waitCloudFrontDeployed('waitCloudFrontAfterLogging');

const cfWaf = record('deployCloudFrontWaf', run([
  'cloudformation', 'deploy',
  '--stack-name', 'checksops-production-cloudfront-waf',
  '--template-file', '/workspace/aws/production/waf-cloudfront.yaml',
  '--capabilities', 'CAPABILITY_NAMED_IAM',
  '--no-fail-on-empty-changeset',
]));
const apiWaf = record('deployApiWaf', run([
  'cloudformation', 'deploy',
  '--stack-name', 'checksops-production-api-waf',
  '--template-file', '/workspace/aws/production/waf-api.yaml',
  '--parameter-overrides', `ApiId=${API_ID}`, 'StageName=prep',
  '--no-fail-on-empty-changeset',
]));

if (cfWaf.ok) {
  const outputs = run(['cloudformation', 'describe-stacks', '--stack-name', 'checksops-production-cloudfront-waf']);
  const aclArn = (outputs.data.Stacks?.[0]?.Outputs || []).find((o) => o.OutputKey === 'WebACLArn')?.OutputValue;
  if (aclArn) {
    const again = waitCloudFrontDeployed('waitCloudFrontBeforeWafAttach');
    if (again.ok && again.data.Distribution?.DistributionConfig) {
      const cfg = JSON.parse(JSON.stringify(again.data.Distribution.DistributionConfig));
      cfg.WebACLId = aclArn;
      const cfgPath = '/tmp/security/cf-batch2-waf.json';
      writeFileSync(cfgPath, JSON.stringify(cfg));
      record('attachCloudFrontWaf', run([
        'cloudfront', 'update-distribution',
        '--id', DIST,
        '--if-match', again.data.ETag,
        '--distribution-config', `file://${cfgPath}`,
      ]));
    }
  }
}

const codeUrl = run(['lambda', 'get-function', '--function-name', PREP]);
if (codeUrl.ok && codeUrl.data.Code?.Location) {
  try {
    const work = '/tmp/security/prep-lambda';
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    execFileSync('curl', ['-fsSL', codeUrl.data.Code.Location, '-o', '/tmp/security/prep-current.zip'], { encoding: 'utf8' });
    execFileSync('unzip', ['-o', '/tmp/security/prep-current.zip', '-d', work], { encoding: 'utf8' });
    cpSync('/workspace/aws/functions/api/index.mjs', join(work, 'index.mjs'));
    cpSync('/workspace/aws/functions/api/cors.mjs', join(work, 'cors.mjs'));
    execFileSync('bash', ['-lc', `cd ${work} && zip -qr /tmp/security/prep-updated.zip .`], { encoding: 'utf8' });
    record('updatePrepLambdaCode', run(['lambda', 'update-function-code', '--function-name', PREP, '--zip-file', 'fileb:///tmp/security/prep-updated.zip']));
    try {
      execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', PREP], { encoding: 'utf8' });
    } catch { /* describe below */ }
  } catch (error) {
    record('updatePrepLambdaCode', { ok: false, message: String(error.message || error).slice(0, 400) });
  }
} else {
  record('updatePrepLambdaCode', { ok: false, message: codeUrl.message || 'missing_code_location' });
}

const afterApi = run(['apigatewayv2', 'get-api', '--api-id', API_ID]);
const afterStaging = run(['apigatewayv2', 'get-api', '--api-id', STAGING_API_ID]);
const afterStage = run(['apigatewayv2', 'get-stage', '--api-id', API_ID, '--stage-name', 'prep']);
const afterCf = run(['cloudfront', 'get-distribution', '--id', DIST]);
const afterPrep = run(['lambda', 'get-function-configuration', '--function-name', PREP]);
const cfg = afterCf.data.Distribution?.DistributionConfig || {};

const report = {
  ok: Boolean(cors.ok)
    && Boolean(stageUpdate.ok)
    && (afterApi.data.CorsConfiguration?.AllowOrigins || []).includes('https://checksops.com')
    && !(afterApi.data.CorsConfiguration?.AllowOrigins || []).includes('*')
    && (afterStaging.data.CorsConfiguration?.AllowOrigins || []).includes('*'),
  mutated: true,
  financialActivated: false,
  throttle: { rate: THROTTLE_RATE, burst: THROTTLE_BURST, applied: afterStage.data.DefaultRouteSettings || null },
  cors: {
    production: afterApi.data.CorsConfiguration || afterApi,
    stagingUnchanged: afterStaging.data.CorsConfiguration || afterStaging,
  },
  logging: {
    apiGroup: API_LOG_GROUP,
    retentionDays: RETENTION_DAYS,
    apiAccessLog: afterStage.data.AccessLogSettings || null,
    cloudfront: cfg.Logging || null,
    bucket: LOG_BUCKET,
  },
  waf: {
    cloudfrontWebAcl: cfg.WebACLId || null,
    stacks: {
      cloudfront: cfWaf.ok,
      api: apiWaf.ok,
    },
  },
  lambda: {
    role: afterPrep.data.Role || null,
    lastModified: afterPrep.data.LastModified || null,
  },
  attempts,
};
mkdirSync('/tmp/security', { recursive: true });
writeFileSync('/tmp/security/batch2-apply.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
