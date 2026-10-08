#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lookupSharedBucket,
  lookupSharedCloudFront,
  lookupSharedLambda,
} from './lib/shared-targets.mjs';

const REGION = 'us-east-1';
const ACCOUNT_ID = '806168576068';
const API_ID = 'kiqojucc02';
const API_STAGE = 'prep';
const API_HOST = 'kiqojucc02.execute-api.us-east-1.amazonaws.com';
const SPA_HOST = 'checksops.com';
const FUNCTION_NAME = 'checksops-production-prep-api';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION_ID = 'E1B0ZWWO5559U5';
const EXPECTED_ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/ChecksOpsGitHubProductionReadOnlyInspect`;
const EXPECTED_SESSION_ARN_PREFIX = `arn:aws:sts::${ACCOUNT_ID}:assumed-role/ChecksOpsGitHubProductionReadOnlyInspect/checksops-production-readonly-inspect-`;
const FLAG_NAMES = [
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
const LAMBDA_QUERY = `{FunctionName:FunctionName,Version:Version,CodeSha256:CodeSha256,LastModified:LastModified,State:State,RevisionId:RevisionId,Environment:{Variables:{${FLAG_NAMES.map((name) => `${name}:Environment.Variables.${name}`).join(',')}}}}`;
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELEASE_LOCKS = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'ops/release-locks/locked-components.json'), 'utf8'));
const SPA_LOCK = RELEASE_LOCKS.components?.['production-spa'];
const SHARED_LAMBDA = lookupSharedLambda(FUNCTION_NAME);
const SHARED_BUCKET = lookupSharedBucket(BUCKET);
const SHARED_CLOUDFRONT = lookupSharedCloudFront(DISTRIBUTION_ID);

if (
  !SPA_LOCK
  || SPA_LOCK.environment !== 'production'
  || SPA_LOCK.classification !== 'PRODUCTION_LOCKED'
  || SPA_LOCK.artifact?.name !== '/assets/index-CBOwj-7W.js'
  || SPA_LOCK.deployment_fingerprint?.cloudfront_id !== DISTRIBUTION_ID
  || !SHARED_LAMBDA || SHARED_LAMBDA.target_environment !== 'production'
  || !SHARED_BUCKET || SHARED_BUCKET.target_environment !== 'production'
  || !SHARED_CLOUDFRONT || SHARED_CLOUDFRONT.target_environment !== 'production'
) {
  throw new Error('production inspector pins do not match current guard metadata');
}

export const PRODUCTION_PINS = Object.freeze({
  environment: 'production',
  account_id: ACCOUNT_ID,
  region: REGION,
  function_name: FUNCTION_NAME,
  api_id: API_ID,
  api_stage: API_STAGE,
  api_host: API_HOST,
  bucket: BUCKET,
  cloudfront_id: DISTRIBUTION_ID,
  spa_host: SPA_HOST,
  readonly_role_arn: EXPECTED_ROLE_ARN,
});

const AWS_ACTIONS = Object.freeze({
  'sts:GetCallerIdentity': '*',
  's3:HeadObject': `s3:GetObject on arn:aws:s3:::${BUCKET}/index.html and ${BUCKET}/assets/index-*.js`,
  'lambda:GetFunctionConfiguration': `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}`,
  'apigateway:GET': `arn:aws:apigateway:${REGION}::/apis/${API_ID}/*`,
  'cloudfront:GetDistribution': `arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DISTRIBUTION_ID}`,
});

export function assertProductionTarget(target = {}) {
  const expected = {
    environment: PRODUCTION_PINS.environment,
    accountId: PRODUCTION_PINS.account_id,
    region: PRODUCTION_PINS.region,
    functionName: PRODUCTION_PINS.function_name,
    apiId: PRODUCTION_PINS.api_id,
    apiStage: PRODUCTION_PINS.api_stage,
    bucket: PRODUCTION_PINS.bucket,
    distributionId: PRODUCTION_PINS.cloudfront_id,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (target[key] !== undefined && target[key] !== value) {
      throw new Error(`unexpected production target: ${key}`);
    }
  }
  if (Object.keys(target).length !== Object.keys(expected).length
      || Object.keys(expected).some((key) => target[key] === undefined)
      || Object.keys(target).some((key) => !(key in expected))) {
    throw new Error('unexpected production target field');
  }
  return true;
}

export function buildAwsArgs(action, target = {}) {
  switch (action) {
    case 'sts:GetCallerIdentity':
      if (Object.keys(target).length) throw new Error('unexpected AWS target');
      return ['sts', 'get-caller-identity'];
    case 's3:HeadObject': {
      if (Object.keys(target).length !== 2 || target.bucket !== BUCKET || !isApprovedSpaKey(target.key)) {
        throw new Error('unexpected production S3 target');
      }
      return [
        's3api', 'head-object', '--bucket', BUCKET, '--key', target.key,
        '--query', '{VersionId:VersionId,ETag:ETag,LastModified:LastModified,ContentLength:ContentLength}',
      ];
    }
    case 'lambda:GetFunctionConfiguration':
      if (Object.keys(target).length !== 1 || target.functionName !== FUNCTION_NAME) {
        throw new Error('unexpected production Lambda target');
      }
      return [
        'lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME,
        '--query', LAMBDA_QUERY,
      ];
    case 'apigateway:GET':
      if (target.apiId !== API_ID || !['api', 'stage', 'integrations'].includes(target.resource)
          || Object.keys(target).some((key) => !['apiId', 'resource', 'stage'].includes(key))) {
        throw new Error('unexpected production API Gateway target');
      }
      if (target.resource === 'api') {
        if (Object.keys(target).length !== 2) throw new Error('unexpected production API target');
        return ['apigatewayv2', 'get-api', '--api-id', API_ID];
      }
      if (target.resource === 'stage') {
        if (Object.keys(target).length !== 3 || target.stage !== API_STAGE) {
          throw new Error('unexpected production API stage');
        }
        return ['apigatewayv2', 'get-stage', '--api-id', API_ID, '--stage-name', API_STAGE];
      }
      if (Object.keys(target).length !== 2) throw new Error('unexpected production API target');
      return ['apigatewayv2', 'get-integrations', '--api-id', API_ID];
    case 'cloudfront:GetDistribution':
      if (Object.keys(target).length !== 1 || target.distributionId !== DISTRIBUTION_ID) {
        throw new Error('unexpected production CloudFront target');
      }
      return ['cloudfront', 'get-distribution', '--id', DISTRIBUTION_ID];
    default:
      throw new Error('AWS operation is not allowlisted');
  }
}

function isApprovedSpaKey(key) {
  return key === 'index.html' || /^assets\/index-[A-Za-z0-9_-]+\.js$/.test(String(key || ''));
}

function awsEnvironment(env) {
  const allowed = ['PATH', 'HOME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
  const cleaned = Object.fromEntries(allowed.filter((key) => env[key]).map((key) => [key, env[key]]));
  cleaned.AWS_REGION = REGION;
  cleaned.AWS_DEFAULT_REGION = REGION;
  cleaned.AWS_EC2_METADATA_DISABLED = 'true';
  cleaned.AWS_CONFIG_FILE = '/dev/null';
  cleaned.AWS_SHARED_CREDENTIALS_FILE = '/dev/null';
  cleaned.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = 'true';
  return cleaned;
}

function awsJson(action, target = {}, { env = process.env } = {}) {
  const args = buildAwsArgs(action, target);
  return JSON.parse(execFileSync('aws', [
    ...args, '--region', REGION, '--no-cli-pager', '--output', 'json',
  ], {
    encoding: 'utf8',
    env: awsEnvironment(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  }) || '{}');
}

function permissionFailure(error) {
  const message = String(error?.stderr || error?.message || '');
  return /accessdenied|unauthorizedoperation|not authorized|permission denied|forbidden/i.test(message)
    ? 'permission_denied'
    : 'read_failed';
}

function safeHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function redactText(value) {
  return String(value)
    .replace(/\b(Authorization|Bearer|password|passwd|secret|token|api[_-]?key|access[_-]?key|connection[_-]?string)\b(\s*(?::=|=>|=|:)\s*)(['"][^'"]*['"]|[^,\s;]+)/gi, '$1$2[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
}

function redact(value, key = '') {
  if (/(?:password|passwd|secret|token|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?string|database[_-]?url)/i.test(key)) {
    return value == null ? null : '[REDACTED]';
  }
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  }
  return value;
}

function flagsFromConfiguration(config) {
  const variables = config?.Environment?.Variables || {};
  return Object.fromEntries(FLAG_NAMES.map((name) => [name, variables[name] === undefined ? null : variables[name] === 'true']));
}

function releaseLockComparison(spa, cloudfront) {
  const actual = {
    entry_bundle: spa?.entry_bundle || null,
    bundle_sha256: spa?.bundle_sha256 || null,
    index_html_sha256: spa?.index_html_sha256 || null,
    s3_version: spa?.s3_version || null,
    cloudfront_id: cloudfront?.Id || null,
  };
  const expected = {
    entry_bundle: SPA_LOCK.artifact.name,
    bundle_sha256: SPA_LOCK.artifact.hash,
    index_html_sha256: SPA_LOCK.deployment_fingerprint.config_hash,
    s3_version: SPA_LOCK.artifact.version,
    cloudfront_id: SPA_LOCK.deployment_fingerprint.cloudfront_id,
  };
  return {
    expected,
    actual,
    matches: Object.keys(expected).every((key) => actual[key] !== null && actual[key] === expected[key]),
    locked_source_git_sha: SPA_LOCK.source.git_sha,
    locked_source_pr: SPA_LOCK.source.merged_pr,
    lock_recorded_at: SPA_LOCK.production_validation.recorded_at,
    evidence_refs: SPA_LOCK.production_validation.evidence_refs,
  };
}

function sourceEvidence() {
  const sources = {
    sql52_micr_column_grant: ['aws/workflows/sql/52_verified_ocr_micr_column_grant.sql', /GRANT UPDATE \(routing_number, account_number\)[\s\S]*TO checksops/],
    pr_762_claim_settlement_rpc: ['aws/functions/api/claim-settlement-rpc.mjs', /save_claim_settlement_breakdown/],
    pr_762_settlement_sql: ['aws/workflows/sql/53_claim_settlement_breakdown.sql', /SECURITY DEFINER[\s\S]*GRANT EXECUTE/],
    pr_772_workflow_gate: ['aws/functions/api/workflow-flags.mjs', /AWS_APPLICATION_WORKFLOW_WRITES_ENABLED/],
  };
  return Object.fromEntries(Object.entries(sources).map(([key, [relativePath, marker]]) => {
    const content = fs.readFileSync(path.join(SOURCE_ROOT, relativePath), 'utf8');
    return [key, {
      repository_path: relativePath,
      sha256: safeHash(content),
      marker_present: marker.test(content),
    }];
  }));
}

function prEvidence(lambda, flags) {
  const expectedCodeHash = SPA_LOCK.deployment_fingerprint.lambda_code_hash || null;
  const codeHashMatches = expectedCodeHash && lambda?.CodeSha256
    ? expectedCodeHash === lambda.CodeSha256
    : null;
  const source = sourceEvidence();
  const evidence = (pr, commit, sourceKeys, liveFlag = null) => ({
    pr,
    merged: true,
    merged_head_sha: commit,
    current_source: sourceKeys.map((key) => source[key]),
    live_lambda_code_sha256: lambda?.CodeSha256 || null,
    accepted_lambda_code_sha256: expectedCodeHash,
    code_hash_matches_accepted_pin: codeHashMatches,
    live_workflow_flag: liveFlag,
    live_status: codeHashMatches === true && sourceKeys.every((key) => source[key].marker_present)
      ? 'verified_by_accepted_code_hash'
      : 'unverified_no_accepted_production_code_hash',
  });
  return {
    pr_762_backend: evidence(
      762,
      '28c796f4fbcaec44b8dfae6d1d7a57197b478658',
      ['pr_762_claim_settlement_rpc', 'sql52_micr_column_grant', 'pr_762_settlement_sql'],
    ),
    pr_772_workflow_gate: evidence(
      772,
      '752ed50a254b3b636c6bfe08f93d7db25c8ac3c8',
      ['pr_772_workflow_gate'],
      flags.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED,
    ),
  };
}

async function fetchLiveSpa(fetchImpl) {
  const request = async (url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== SPA_HOST || parsed.port || parsed.username || parsed.password) {
      throw new Error('unexpected production SPA URL');
    }
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('production SPA read failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) throw new Error('production SPA response exceeded size limit');
    return { bytes, headers: response.headers };
  };
  const index = await request(`https://${SPA_HOST}/index.html`);
  const html = index.bytes.toString('utf8');
  const entry = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] || null;
  if (!entry) throw new Error('production SPA entry bundle was not found');
  const bundle = await request(`https://${SPA_HOST}${entry}`);
  return {
    entry_bundle: entry,
    index_html_sha256: safeHash(index.bytes),
    bundle_sha256: safeHash(bundle.bytes),
    last_modified: index.headers.get('last-modified'),
    s3_version: index.headers.get('x-amz-version-id'),
    cache_status: index.headers.get('x-cache'),
  };
}

async function safeRead(readErrors, action, target, invoke) {
  try {
    return await invoke(action, target);
  } catch (error) {
    const resource = AWS_ACTIONS[action];
    readErrors.push({
      action,
      resource,
      reason: permissionFailure(error),
    });
    return null;
  }
}

export async function inspectProduction({
  env = process.env,
  runAws = (action, target) => awsJson(action, target, { env }),
  fetchImpl = fetch,
} = {}) {
  assertProductionTarget({
    environment: 'production',
    accountId: ACCOUNT_ID,
    region: REGION,
    functionName: FUNCTION_NAME,
    apiId: API_ID,
    apiStage: API_STAGE,
    bucket: BUCKET,
    distributionId: DISTRIBUTION_ID,
  });
  if ((env.AWS_REGION && env.AWS_REGION !== REGION)
      || (env.AWS_DEFAULT_REGION && env.AWS_DEFAULT_REGION !== REGION)) {
    throw new Error('unexpected AWS region');
  }
  if (env.CHECKSOPS_INSPECTOR_ENVIRONMENT && env.CHECKSOPS_INSPECTOR_ENVIRONMENT !== 'production') {
    throw new Error('unexpected inspector environment');
  }
  if (env.CHECKSOPS_PRODUCTION_READONLY_INSPECT_ROLE_ARN
      && env.CHECKSOPS_PRODUCTION_READONLY_INSPECT_ROLE_ARN !== EXPECTED_ROLE_ARN) {
    throw new Error('unexpected production inspector role');
  }

  const readErrors = [];
  const identity = await safeRead(readErrors, 'sts:GetCallerIdentity', {}, runAws);
  if (
    !identity
    || identity.Account !== ACCOUNT_ID
    || !String(identity.Arn || '').startsWith(EXPECTED_SESSION_ARN_PREFIX)
  ) {
    throw new Error('production account identity check failed');
  }

  const [indexHead, lambda, api, stage, integrations, cloudfront] = await Promise.all([
    safeRead(readErrors, 's3:HeadObject', { bucket: BUCKET, key: 'index.html' }, runAws),
    safeRead(readErrors, 'lambda:GetFunctionConfiguration', { functionName: FUNCTION_NAME }, runAws),
    safeRead(readErrors, 'apigateway:GET', { apiId: API_ID, resource: 'api' }, runAws),
    safeRead(readErrors, 'apigateway:GET', { apiId: API_ID, resource: 'stage', stage: API_STAGE }, runAws),
    safeRead(readErrors, 'apigateway:GET', { apiId: API_ID, resource: 'integrations' }, runAws),
    safeRead(readErrors, 'cloudfront:GetDistribution', { distributionId: DISTRIBUTION_ID }, runAws),
  ]);

  const config = lambda && {
    FunctionName: lambda.FunctionName,
    Version: lambda.Version,
    CodeSha256: lambda.CodeSha256,
    LastModified: lambda.LastModified,
    State: lambda.State,
    RevisionId: lambda.RevisionId,
    Environment: { Variables: lambda.Environment?.Variables || {} },
  };
  const flags = flagsFromConfiguration(config);
  const distribution = cloudfront?.Distribution || null;
  const apiIntegrations = integrations?.Items || [];
  const expectedIntegrationArn = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}`;
  const apiTargetMatches = Boolean(
    api?.ApiId === API_ID
    && stage?.StageName === API_STAGE
    && apiIntegrations.length > 0
    && apiIntegrations.every((item) => item.IntegrationUri === expectedIntegrationArn),
  );
  const targetDrift = Boolean(
    (lambda?.FunctionName && lambda.FunctionName !== FUNCTION_NAME)
    || (api?.ApiId && api.ApiId !== API_ID)
    || (stage?.StageName && stage.StageName !== API_STAGE)
    || (integrations && (!apiIntegrations.length || apiIntegrations.some((item) => item.IntegrationUri !== expectedIntegrationArn)))
    || (distribution?.Id && distribution.Id !== DISTRIBUTION_ID)
  );
  const liveSpa = await (async () => {
    try {
      return await fetchLiveSpa(fetchImpl);
    } catch (error) {
      readErrors.push({ action: 'HTTPS:GetObject', resource: `https://${SPA_HOST}/index.html and active bundle`, reason: permissionFailure(error) });
      return null;
    }
  })();
  const head = indexHead && {
    VersionId: indexHead.VersionId,
    ETag: indexHead.ETag,
    LastModified: indexHead.LastModified,
    ContentLength: indexHead.ContentLength,
  };
  const spa = liveSpa && {
    ...liveSpa,
    cloudfront_id: distribution?.Id || null,
  };
  const database = {
    status: 'refused_unproven_aws_production_target',
    reason: 'current accepted AWS production metadata does not identify a database target',
  };

  const comparison = releaseLockComparison(spa, distribution);
  const report = {
    status: targetDrift ? 'target_drift' : readErrors.length || database.status !== 'complete' ? 'partial' : 'complete',
    target: PRODUCTION_PINS,
    aws_identity: { account_id: identity.Account, arn: identity.Arn },
    spa: {
      ...spa,
      s3_index_metadata: head,
      cloudfront: distribution && {
        id: distribution.Id,
        arn: distribution.ARN,
        status: distribution.Status,
        domain_name: distribution.DomainName,
        last_modified: distribution.LastModifiedTime,
        etag: cloudfront.ETag,
      },
      production_spa_lock_comparison: comparison,
    },
    api: {
      pinned_api_id: API_ID,
      observed_api_id: api?.ApiId || null,
      name: api?.Name || null,
      protocol_type: api?.ProtocolType || null,
      stage: stage && {
        stage_name: stage.StageName,
        deployment_id: stage.DeploymentId,
        auto_deploy: stage.AutoDeploy,
      },
      integration_lambda_arns: apiIntegrations.map((item) => item.IntegrationUri || null),
      target_matches_pinned_lambda: apiTargetMatches,
    },
    lambda: config && {
      function_name: config.FunctionName,
      version: config.Version,
      code_sha256: config.CodeSha256,
      revision_id: config.RevisionId,
      last_modified: config.LastModified,
      state: config.State,
      release_lock_code_sha256: SPA_LOCK.deployment_fingerprint.lambda_code_hash || null,
      release_lock_revision_id: SPA_LOCK.deployment_fingerprint.lambda_version || null,
      code_sha256_matches_release_lock: SPA_LOCK.deployment_fingerprint.lambda_code_hash && config.CodeSha256
        ? SPA_LOCK.deployment_fingerprint.lambda_code_hash === config.CodeSha256
        : null,
      revision_matches_release_lock: SPA_LOCK.deployment_fingerprint.lambda_version
        ? SPA_LOCK.deployment_fingerprint.lambda_version === config.RevisionId
        : null,
      workflow_flags: flags,
      merged_pr_live_evidence: prEvidence(config, flags),
    },
    database,
    missing_read_permissions: readErrors.filter((item) => item.reason === 'permission_denied'),
    read_errors: readErrors,
  };
  return redact(report);
}

export async function main({
  env = process.env,
  writeOutput = console.log,
  ...dependencies
} = {}) {
  const report = await inspectProduction({ env, ...dependencies });
  writeOutput(JSON.stringify(report, null, 2));
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    process.exitCode = await main();
  } catch {
    console.error(JSON.stringify({ status: 'refused', reason: 'production inspection precondition failed' }));
    process.exitCode = 2;
  }
}
