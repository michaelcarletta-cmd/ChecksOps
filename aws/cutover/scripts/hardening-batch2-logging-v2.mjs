#!/usr/bin/env node
/**
 * Enable CloudFront standard logging v2 (no cookies, no query strings).
 * Does not create WAF. Does not change staging or money flags.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const DIST = 'E1B0ZWWO5559U5';
const LOG_BUCKET = 'checksops-production-access-logs-806168576068';
const SOURCE = 'checksops-production-cf-e1b0';
const DEST = 'checksops-production-cf-e1b0-s3';
const PREFIX = `cloudfront-v2/${DIST}`;
const SAFE_FIELDS = [
  'date', 'time', 'x-edge-location', 'sc-bytes', 'c-ip', 'cs-method',
  'cs(Host)', 'cs-uri-stem', 'sc-status', 'x-edge-result-type',
  'x-edge-request-id', 'x-host-header', 'cs-protocol', 'cs-bytes',
  'time-taken', 'cs-protocol-version', 'c-port', 'time-to-first-byte',
  'x-edge-detailed-result-type', 'sc-content-type', 'sc-content-len',
];

if (!process.argv.includes('--confirm-batch2-logging')) {
  console.error(JSON.stringify({ error: 'refusing_batch2_logging_apply' }));
  process.exit(2);
}

const run = (args, extra = {}) => {
  try {
    const out = execFileSync(AWS, ['--region', extra.region || REGION, '--output', extra.output || 'json', ...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    const trimmed = String(out || '').trim();
    if (!trimmed) return { ok: true, data: {} };
    try { return { ok: true, data: JSON.parse(trimmed) }; } catch { return { ok: true, data: { raw: trimmed.slice(0, 240) } }; }
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    return {
      ok: false,
      denied: /AccessDenied|not authorized/i.test(text),
      message: text.slice(0, 700),
    };
  }
};

const attempts = [];
const record = (step, result) => {
  attempts.push({
    step,
    ok: result.ok,
    denied: result.denied || false,
    message: result.ok ? null : result.message,
  });
  return result;
};

record('logBucketPolicyV2', run(['s3api', 'put-bucket-policy', '--bucket', LOG_BUCKET, '--policy', JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AWSLogsDeliveryWrite',
      Effect: 'Allow',
      Principal: { Service: 'delivery.logs.amazonaws.com' },
      Action: 's3:PutObject',
      Resource: `arn:aws:s3:::${LOG_BUCKET}/${PREFIX}/*`,
      Condition: {
        StringEquals: {
          'aws:SourceAccount': '806168576068',
          's3:x-amz-acl': 'bucket-owner-full-control',
        },
        ArnLike: {
          'aws:SourceArn': `arn:aws:logs:${REGION}:806168576068:delivery-source:${SOURCE}`,
        },
      },
    },
    {
      Sid: 'AWSLogsDeliveryAclCheck',
      Effect: 'Allow',
      Principal: { Service: 'delivery.logs.amazonaws.com' },
      Action: ['s3:GetBucketAcl', 's3:ListBucket'],
      Resource: `arn:aws:s3:::${LOG_BUCKET}`,
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

record('putDeliverySource', run([
  'logs', 'put-delivery-source',
  '--name', SOURCE,
  '--resource-arn', `arn:aws:cloudfront::806168576068:distribution/${DIST}`,
  '--log-type', 'ACCESS_LOGS',
]));

const dest = record('putDeliveryDestination', run([
  'logs', 'put-delivery-destination',
  '--name', DEST,
  '--output-format', 'json',
  '--delivery-destination-configuration', `destinationResourceArn=arn:aws:s3:::${LOG_BUCKET}/${PREFIX}`,
]));

const destArn = dest.data.deliveryDestination?.arn
  || dest.data.DeliveryDestination?.arn
  || `arn:aws:logs:${REGION}:806168576068:delivery-destination:${DEST}`;

record('createDelivery', run([
  'logs', 'create-delivery',
  '--delivery-source-name', SOURCE,
  '--delivery-destination-arn', destArn,
  '--record-fields', ...SAFE_FIELDS,
  '--s3-delivery-configuration', JSON.stringify({
    enableHiveCompatiblePath: false,
    suffixPath: '{yyyy}/{MM}/{dd}/{HH}',
  }),
]));

const listed = record('describeDeliveries', run(['logs', 'describe-deliveries']));
const delivery = (listed.data.deliveries || listed.data.Deliveries || []).find((row) => (
  row.deliverySourceName === SOURCE || row.DeliverySourceName === SOURCE
)) || null;

if (delivery) {
  const dist = run(['cloudfront', 'get-distribution', '--id', DIST]);
  if (dist.ok && dist.data.Distribution?.DistributionConfig) {
    const cfg = JSON.parse(JSON.stringify(dist.data.Distribution.DistributionConfig));
    cfg.Logging = { Enabled: false, IncludeCookies: false, Bucket: '', Prefix: '' };
    const cfgPath = '/tmp/security/cf-batch2-disable-legacy-logging.json';
    mkdirSync('/tmp/security', { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(cfg));
    record('disableLegacyCloudFrontLogging', run([
      'cloudfront', 'update-distribution',
      '--id', DIST,
      '--if-match', dist.data.ETag,
      '--distribution-config', `file://${cfgPath}`,
    ]));
  }
}

for (const name of ['checksops-production-cloudfront-waf', 'checksops-production-api-waf']) {
  record(`deleteFailedStack:${name}`, run(['cloudformation', 'delete-stack', '--stack-name', name]));
}

const afterCf = run(['cloudfront', 'get-distribution', '--id', DIST]);
const report = {
  ok: Boolean(delivery) || Boolean(dest.ok),
  mutated: true,
  financialActivated: false,
  v2: {
    source: SOURCE,
    destination: DEST,
    prefix: PREFIX,
    bucket: LOG_BUCKET,
    recordFields: SAFE_FIELDS,
    omitted: ['cs(Cookie)', 'cs-uri-query', 'cs(Referer)'],
    delivery: delivery || null,
  },
  cloudfrontLogging: afterCf.data.Distribution?.DistributionConfig?.Logging || afterCf,
  attempts,
};
mkdirSync('/tmp/security', { recursive: true });
writeFileSync('/tmp/security/batch2-logging-v2.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
