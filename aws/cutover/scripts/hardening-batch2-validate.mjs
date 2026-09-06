#!/usr/bin/env node
/**
 * Batch 2 validation. Does not activate financial providers or mutate infra.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const DIST = 'E1B0ZWWO5559U5';
const PREP = 'checksops-production-prep-api';
const STAGING = 'checksops-staging-api';
const API = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep';
const STAGING_API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const API_ID = 'kiqojucc02';
const STAGING_API_ID = 'psr19uhop4';
const API_LOG_GROUP = '/aws/apigateway/checksops-production-prep-http';
const LOG_BUCKET = 'checksops-production-access-logs-806168576068';

if (process.argv.some((a) => ['--apply', '--activate', '--fix'].includes(a))) {
  console.error(JSON.stringify({ error: 'refusing_mutation_from_batch2_validate' }));
  process.exit(2);
}

const run = (args, extra = {}) => {
  try {
    return JSON.parse(execFileSync(AWS, ['--region', extra.region || REGION, '--output', 'json', ...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }) || '{}');
  } catch (error) {
    return { _denied: true, message: String(error.stderr || error.message || error).slice(0, 400) };
  }
};
const flagOff = (vars, key) => String(vars?.[key] || 'false').toLowerCase() !== 'true';

const fetchTimeout = async (url, options = {}, ms = 20000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
};

const publicHost = async (url) => {
  try {
    const response = await fetchTimeout(url);
    return { status: response.status, server: response.headers.get('server'), cf: response.headers.get('x-amz-cf-id') };
  } catch (error) {
    return { status: 0, error: String(error.message || error).slice(0, 160) };
  }
};

const corsProbe = async (url, origin) => {
  try {
    const response = await fetchTimeout(url, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });
    return {
      status: response.status,
      allowOrigin: response.headers.get('access-control-allow-origin'),
      allowMethods: response.headers.get('access-control-allow-methods'),
    };
  } catch (error) {
    return { status: 0, error: String(error.message || error).slice(0, 160) };
  }
};

const postPublic = async (url, origin) => {
  try {
    const response = await fetchTimeout(url, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const json = await response.json().catch(() => ({}));
    return {
      status: response.status,
      allowOrigin: response.headers.get('access-control-allow-origin'),
      error: json.error || json.message || null,
      reachable: response.status > 0 && response.status < 500,
    };
  } catch (error) {
    return { status: 0, reachable: false, error: String(error.message || error).slice(0, 160) };
  }
};

const cf = run(['cloudfront', 'get-distribution', '--id', DIST]);
const cfg = cf.Distribution?.DistributionConfig || {};
const prep = run(['lambda', 'get-function-configuration', '--function-name', PREP]);
const staging = run(['lambda', 'get-function-configuration', '--function-name', STAGING]);
const prepVars = prep.Environment?.Variables || {};
const stagingVars = staging.Environment?.Variables || {};
const api = run(['apigatewayv2', 'get-api', '--api-id', API_ID]);
const stagingApi = run(['apigatewayv2', 'get-api', '--api-id', STAGING_API_ID]);
const stage = run(['apigatewayv2', 'get-stage', '--api-id', API_ID, '--stage-name', 'prep']);
const sql64 = readFileSync(path.join(ROOT, 'aws/financial/sql/64_financial_activation_grants.sql'), 'utf8');
const start = Date.now() - 20 * 60 * 1000;
const errorLogs = run([
  'logs', 'filter-log-events',
  '--log-group-name', `/aws/lambda/${PREP}`,
  '--start-time', String(start),
  '--filter-pattern', 'ERROR',
  '--limit', '20',
]);
const metric = run([
  'cloudwatch', 'get-metric-statistics',
  '--namespace', 'AWS/Lambda',
  '--metric-name', 'Errors',
  '--dimensions', `Name=FunctionName,Value=${PREP}`,
  '--start-time', new Date(start).toISOString(),
  '--end-time', new Date().toISOString(),
  '--period', '300',
  '--statistics', 'Sum',
]);
const apiLogGroup = run(['logs', 'describe-log-groups', '--log-group-name-prefix', API_LOG_GROUP]);
const apiStreams = run(['logs', 'describe-log-streams', '--log-group-name', API_LOG_GROUP, '--order-by', 'LastEventTime', '--descending', '--limit', '5']);
const bucketObjects = run(['s3api', 'list-objects-v2', '--bucket', LOG_BUCKET, '--max-items', '10']);
const deliveries = run(['logs', 'describe-deliveries']);
const delivery = (deliveries.deliveries || deliveries.Deliveries || []).find((row) => (
  String(row.deliverySourceName || row.DeliverySourceName || '').includes('cf-e1b0')
)) || null;

const apex = await publicHost('https://checksops.com/');
const www = await publicHost('https://www.checksops.com/');
const health = await publicHost(`${API}/health`);
const dbHealth = await publicHost(`${API}/db-health`);
const prodCorsOk = await corsProbe(`${API}/public/endorsement`, 'https://checksops.com');
const prodCorsWww = await corsProbe(`${API}/public/signature-submit`, 'https://www.checksops.com');
const prodCorsEvil = await corsProbe(`${API}/public/endorsement`, 'https://evil.example');
const stagingCors = await corsProbe(`${STAGING_API}/health`, 'https://evil.example');
const endorsement = await postPublic(`${API}/public/endorsement`, 'https://checksops.com');
const signatureSubmit = await postPublic(`${API}/public/signature-submit`, 'https://checksops.com');
const signatureDocument = await postPublic(`${API}/public/signature-document`, 'https://checksops.com');

const prodOrigins = api.CorsConfiguration?.AllowOrigins || [];
const stagingOrigins = stagingApi.CorsConfiguration?.AllowOrigins || [];
const errorSum = (metric.Datapoints || []).reduce((sum, point) => sum + Number(point.Sum || 0), 0);
const apiGroup = (apiLogGroup.logGroups || []).find((g) => g.logGroupName === API_LOG_GROUP);
const streamCount = (apiStreams.logStreams || []).length;
const objectCount = Number(bucketObjects.KeyCount || (bucketObjects.Contents || []).length || 0);

const checks = {
  publicApex: apex.status === 200,
  publicWww: www.status === 200,
  publicHealth: health.status === 200,
  corsProdAllowList: prodOrigins.includes('https://checksops.com') && prodOrigins.includes('https://www.checksops.com'),
  corsProdNoWildcard: !prodOrigins.includes('*'),
  corsStagingWildcard: stagingOrigins.includes('*'),
  corsLiveProdOrigin: prodCorsOk.allowOrigin === 'https://checksops.com',
  corsLiveWwwOrigin: prodCorsWww.allowOrigin === 'https://www.checksops.com',
  corsLiveEvilNotEchoed: prodCorsEvil.allowOrigin !== 'https://evil.example',
  publicEndorsementReachable: endorsement.reachable === true,
  publicSignatureSubmitReachable: signatureSubmit.reachable === true,
  publicSignatureDocumentReachable: signatureDocument.reachable === true,
  throttleConfigured: Number(stage.DefaultRouteSettings?.ThrottlingRateLimit) === 50
    && Number(stage.DefaultRouteSettings?.ThrottlingBurstLimit) === 100,
  apiAccessLogsConfigured: Boolean(stage.AccessLogSettings?.DestinationArn),
  apiLogRetention90: apiGroup?.retentionInDays === 90,
  apiLogsWriting: streamCount > 0,
  cloudfrontLoggingConfigured: Boolean(cfg.Logging?.Enabled) || Boolean(delivery),
  cloudfrontLogsWriting: objectCount > 0,
  wafAttached: Boolean(cfg.WebACLId),
  moovOff: flagOff(prepVars, 'AWS_MOOV_ENABLED'),
  checkaltOff: flagOff(prepVars, 'AWS_CHECKALT_ENABLED'),
  providerOff: flagOff(prepVars, 'AWS_PROVIDER_EXECUTION_ENABLED'),
  financialOff: flagOff(prepVars, 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED'),
  grantsNotApplied: /NOT_APPLIED/.test(sql64),
  noNewLambdaErrors: errorLogs._denied ? null : (errorLogs.events || []).length === 0,
};

const report = {
  generatedAt: new Date().toISOString(),
  mutated: false,
  ok: checks.publicApex && checks.publicWww && checks.publicHealth
    && checks.corsProdAllowList && checks.corsProdNoWildcard && checks.corsStagingWildcard
    && checks.corsLiveProdOrigin && checks.throttleConfigured
    && checks.apiAccessLogsConfigured && checks.wafAttached
    && checks.moovOff && checks.checkaltOff && checks.providerOff && checks.financialOff
    && checks.grantsNotApplied
    && checks.publicEndorsementReachable,
  checks,
  public: { apex, www, health, dbHealth },
  cors: {
    productionApi: api.CorsConfiguration || null,
    stagingApi: stagingApi.CorsConfiguration || null,
    probes: { prodCorsOk, prodCorsWww, prodCorsEvil, stagingCors },
    publicPosts: { endorsement, signatureSubmit, signatureDocument },
  },
  throttle: stage.DefaultRouteSettings || null,
  logging: {
    apiGroup: API_LOG_GROUP,
    apiAccessLog: stage.AccessLogSettings || null,
    apiRetentionDays: apiGroup?.retentionInDays || null,
    apiStreams: streamCount,
    cloudfront: cfg.Logging || null,
    cloudfrontWebAcl: cfg.WebACLId || null,
    bucket: LOG_BUCKET,
    bucketObjects: objectCount,
    v2Delivery: delivery ? {
      source: delivery.deliverySourceName || delivery.DeliverySourceName || null,
      destination: delivery.deliveryDestinationArn || delivery.DeliveryDestinationArn || null,
    } : null,
  },
  lambda: {
    prepRole: prep.Role || null,
    lastModified: prep.LastModified || null,
    checksopsEnv: prepVars.CHECKSOPS_ENV || null,
  },
  cloudwatch: {
    filterDenied: Boolean(errorLogs._denied),
    errorEvents: errorLogs._denied ? null : (errorLogs.events || []).length,
    errorSum: metric._denied ? null : errorSum,
  },
};
mkdirSync('/tmp/security', { recursive: true });
writeFileSync('/tmp/security/batch2-validate.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
