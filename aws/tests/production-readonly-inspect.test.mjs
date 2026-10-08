import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  assertProductionTarget,
  buildAwsArgs,
  buildInspectionSummary,
  inspectProduction,
  PRODUCTION_PINS,
} from '../../scripts/deployment-guard/production-readonly-inspect.mjs';

const SHA = (value) => createHash('sha256').update(value).digest('hex');
const INDEX_HTML = '<script type="module" src="/assets/index-test_bundle.js"></script>';
const BUNDLE = 'read-only test bundle';
const PRODUCTION_TARGET = {
  environment: 'production',
  accountId: '806168576068',
  region: 'us-east-1',
  functionName: 'checksops-production-prep-api',
  apiId: 'kiqojucc02',
  apiStage: 'prep',
  bucket: 'checksops-production-frontend-806168576068',
  distributionId: 'E1B0ZWWO5559U5',
};

const lambdaConfig = {
  FunctionName: PRODUCTION_PINS.function_name,
  Version: '$LATEST',
  CodeSha256: 'live-code-fingerprint',
  LastModified: '2026-10-08T00:00:00.000+0000',
  State: 'Active',
  RevisionId: 'live-revision',
  Environment: {
    Variables: {
      AWS_WRITES_ENABLED: 'false',
      AWS_APPLICATION_WORKFLOW_WRITES_ENABLED: 'false',
      AWS_PROVIDER_EXECUTION_ENABLED: 'false',
      DB_PASSWORD: 'database-password-must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-must-not-leak',
    },
  },
};

function mockAws(calls = [], overrides = {}) {
  return async (action, target) => {
    calls.push({ action, target });
    if (overrides[action]) return overrides[action](target);
    switch (action) {
      case 'sts:GetCallerIdentity':
        return {
          Account: '806168576068',
          Arn: 'arn:aws:sts::806168576068:assumed-role/ChecksOpsGitHubProductionReadOnlyInspect/checksops-production-readonly-inspect-test',
        };
      case 's3:HeadObject':
        return { VersionId: 'b783nvvtXDmYHqatwJVZeKx2uHcwpDk3', ETag: '"index-etag"', LastModified: '2026-10-07T00:00:00Z' };
      case 'lambda:GetFunctionConfiguration':
        return lambdaConfig;
      case 'apigateway:GET':
        if (target.resource === 'api') return { ApiId: 'kiqojucc02', Name: 'checksops-production-prep-http', ProtocolType: 'HTTP' };
        if (target.resource === 'stage') return { StageName: 'prep', DeploymentId: 'deployment-1', AutoDeploy: true };
        return { Items: [{ IntegrationUri: 'arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api' }] };
      case 'cloudfront:GetDistribution':
        return {
          ETag: 'cloudfront-etag',
          Distribution: {
            Id: 'E1B0ZWWO5559U5',
            ARN: 'arn:aws:cloudfront::806168576068:distribution/E1B0ZWWO5559U5',
            Status: 'Deployed',
            DomainName: 'dmgs35lzv89ms.cloudfront.net',
            LastModifiedTime: '2026-10-07T00:00:00Z',
          },
        };
      default:
        throw new Error(`unexpected operation: ${action}`);
    }
  };
}

function mockFetch(url, options) {
  assert.equal(new URL(url).hostname, 'checksops.com');
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  if (url.endsWith('/index.html')) {
    return Promise.resolve(new Response(INDEX_HTML, {
      status: 200,
      headers: {
        'last-modified': '2026-10-07T00:00:00Z',
        'x-amz-version-id': 'b783nvvtXDmYHqatwJVZeKx2uHcwpDk3',
        'x-cache': 'RefreshHit from cloudfront',
      },
    }));
  }
  assert.equal(url, 'https://checksops.com/assets/index-test_bundle.js');
  return Promise.resolve(new Response(BUNDLE, { status: 200 }));
}

test('pins the production environment, account, region, and exact AWS resources', () => {
  assert.equal(assertProductionTarget(PRODUCTION_TARGET), true);
  for (const target of [
    { ...PRODUCTION_TARGET, environment: 'staging' },
    { ...PRODUCTION_TARGET, accountId: '*' },
    { ...PRODUCTION_TARGET, region: 'us-west-2' },
    { ...PRODUCTION_TARGET, functionName: 'other-function' },
    { ...PRODUCTION_TARGET, bucket: 'checksops-staging-frontend-c48b' },
    { ...PRODUCTION_TARGET, distributionId: '*' },
    { ...PRODUCTION_TARGET, arbitraryTarget: 'anything' },
    {},
  ]) {
    assert.throws(() => assertProductionTarget(target), /unexpected production target/);
  }
});

test('allowlists only pinned AWS read operations and refuses mutations or arbitrary targets', () => {
  assert.deepEqual(buildAwsArgs('sts:GetCallerIdentity'), ['sts', 'get-caller-identity']);
  assert.deepEqual(buildAwsArgs('s3:HeadObject', { bucket: PRODUCTION_PINS.bucket, key: 'index.html' }).slice(0, 4), [
    's3api', 'head-object', '--bucket', PRODUCTION_PINS.bucket,
  ]);
  assert.throws(() => buildAwsArgs('s3:PutObject', { bucket: PRODUCTION_PINS.bucket }), /not allowlisted/);
  assert.throws(() => buildAwsArgs('s3:HeadObject', { bucket: 'checksops-staging-frontend-c48b', key: 'index.html' }));
  assert.throws(() => buildAwsArgs('s3:HeadObject', { bucket: PRODUCTION_PINS.bucket, key: '*' }));
  assert.throws(() => buildAwsArgs('s3:HeadObject', { bucket: PRODUCTION_PINS.bucket, key: 'index.html', extra: 'target' }));
  assert.throws(() => buildAwsArgs('lambda:UpdateFunctionCode', { functionName: PRODUCTION_PINS.function_name }));
  assert.throws(() => buildAwsArgs('lambda:GetFunctionConfiguration', { functionName: '*' }));
  assert.throws(() => buildAwsArgs('apigateway:GET', { apiId: PRODUCTION_PINS.api_id, resource: 'stage', stage: 'staging' }));
  assert.throws(() => buildAwsArgs('cloudfront:CreateInvalidation', { distributionId: PRODUCTION_PINS.cloudfront_id }));
  assert.throws(() => buildAwsArgs('cloudfront:GetDistribution', { distributionId: '*' }));
});

test('inspects pinned production AWS reads and reports SPA locks, Lambda flags, and merged PR evidence safely', async () => {
  const awsCalls = [];
  const report = await inspectProduction({
    env: {
      AWS_REGION: 'us-east-1',
      CHECKSOPS_INSPECTOR_ENVIRONMENT: 'production',
      CHECKSOPS_PRODUCTION_READONLY_INSPECT_ROLE_ARN: PRODUCTION_PINS.readonly_role_arn,
    },
    runAws: mockAws(awsCalls),
    fetchImpl: mockFetch,
  });

  assert.equal(report.status, 'partial', JSON.stringify({ read_errors: report.read_errors, database: report.database }));
  assert.equal(report.aws_identity.account_id, PRODUCTION_PINS.account_id);
  assert.equal(report.spa.entry_bundle, '/assets/index-test_bundle.js');
  assert.equal(report.spa.index_html_sha256, SHA(INDEX_HTML));
  assert.equal(report.spa.bundle_sha256, SHA(BUNDLE));
  assert.equal(report.spa.cloudfront.id, PRODUCTION_PINS.cloudfront_id);
  assert.equal(report.spa.production_spa_lock_comparison.matches, false);
  assert.equal(report.api.target_matches_pinned_lambda, true);
  assert.equal(report.lambda.workflow_flags.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED, false);
  assert.equal(report.lambda.workflow_flags.AWS_PROVIDER_EXECUTION_ENABLED, false);
  assert.equal(report.lambda.merged_pr_live_evidence.pr_762_backend.live_status, 'unverified_no_accepted_production_code_hash');
  assert.equal(report.lambda.merged_pr_live_evidence.pr_772_workflow_gate.live_workflow_flag, false);
  assert.equal(report.database.status, 'refused_unproven_aws_production_target');
  assert.equal(awsCalls.some(({ action }) => /provider|payment|update|put|delete|publish|invalidate/i.test(action)), false);
  assert.equal(JSON.stringify(report).includes('database-password-must-not-leak'), false);
  assert.equal(JSON.stringify(report).includes('aws-secret-must-not-leak'), false);
});

test('rejects a non-production caller identity before any AWS or HTTPS read', async () => {
  const calls = [];
  await assert.rejects(inspectProduction({
    runAws: async (action) => {
      calls.push(action);
      return { Account: '000000000000' };
    },
    fetchImpl: () => assert.fail('HTTPS must not be called for an unexpected AWS identity'),
  }), /production account identity check failed/);
  assert.deepEqual(calls, ['sts:GetCallerIdentity']);
});

test('rejects same-account credentials that are not from the pinned inspector role', async () => {
  await assert.rejects(inspectProduction({
    runAws: async () => ({
      Account: '806168576068',
      Arn: 'arn:aws:sts::806168576068:assumed-role/Administrator/not-the-inspector',
    }),
    fetchImpl: () => assert.fail('HTTPS must not be called for an unexpected role'),
  }), /production account identity check failed/);
});

test('rejects environment, region, and role drift before AWS access', async () => {
  let called = false;
  const runAws = async () => {
    called = true;
    return {};
  };
  for (const env of [
    { CHECKSOPS_INSPECTOR_ENVIRONMENT: 'staging' },
    { AWS_DEFAULT_REGION: 'us-west-2' },
    { CHECKSOPS_PRODUCTION_READONLY_INSPECT_ROLE_ARN: 'arn:aws:iam::806168576068:role/other' },
  ]) {
    await assert.rejects(inspectProduction({ env, runAws }), /unexpected/);
  }
  assert.equal(called, false);
});

test('reports missing read permissions without leaking AWS error details', async () => {
  const report = await inspectProduction({
    runAws: mockAws([], {
      'lambda:GetFunctionConfiguration': () => {
        const error = new Error('AccessDenied: secret account detail');
        error.stderr = 'AccessDeniedException: hidden-policy-detail';
        throw error;
      },
    }),
    fetchImpl: mockFetch,
  });
  assert.equal(report.status, 'partial');
  assert.ok(report.missing_read_permissions.some((item) => item.action === 'lambda:GetFunctionConfiguration'));
  assert.equal(JSON.stringify(report).includes('hidden-policy-detail'), false);
  assert.equal(JSON.stringify(report).includes('secret account detail'), false);
  const summary = buildInspectionSummary(report);
  assert.equal(summary.lambda, null);
  assert.deepEqual(summary.missing_read_permissions, report.missing_read_permissions);
  assert.deepEqual(summary.read_errors, report.read_errors);
  assert.deepEqual(summary.database, report.database);
});

test('evidence summary allowlists nested fields and flags and excludes secret-like values', async () => {
  const report = await inspectProduction({ runAws: mockAws(), fetchImpl: mockFetch });
  const secret = 'opaque-secret-must-not-be-persisted';
  report.raw_credentials = secret;
  report.aws_identity.session_token = secret;
  report.target = { ...report.target, database_url: secret };
  report.spa.s3_index_metadata.raw = secret;
  report.spa.cloudfront.DistributionConfig = secret;
  report.spa.production_spa_lock_comparison.evidence_refs = [secret];
  report.spa.production_spa_lock_comparison.expected.raw = secret;
  report.api.name = secret;
  report.api.stage.raw = secret;
  report.api.definitions = secret;
  report.lambda.Environment = { Variables: { DB_PASSWORD: secret } };
  report.lambda.code = secret;
  report.lambda.workflow_flags.AWS_SECRET_ACCESS_KEY = secret;
  report.lambda.workflow_flags.AWS_WRITES_ENABLED = secret;
  report.lambda.merged_pr_live_evidence.unapproved = secret;
  report.lambda.merged_pr_live_evidence.pr_762_backend.definition = secret;
  report.lambda.merged_pr_live_evidence.pr_762_backend.current_source[0].content = secret;
  report.database.data = secret;
  report.read_errors = [{
    action: 'lambda:GetFunctionConfiguration', resource: PRODUCTION_PINS.function_name,
    reason: 'read_failed', stderr: secret,
  }];
  report.lambda.version = ['Bearer', 'known-token-must-not-leak'].join(' ');

  const evidence = buildInspectionSummary(report);
  const json = JSON.stringify(evidence);
  for (const value of [secret, 'known-token-must-not-leak', 'database-password-must-not-leak', 'aws-secret-must-not-leak']) {
    assert.equal(json.includes(value), false, value);
  }
  assert.deepEqual(Object.keys(evidence), [
    'status', 'target', 'spa', 'api', 'lambda', 'database', 'missing_read_permissions', 'read_errors',
  ]);
  assert.equal(evidence.spa.bundle_sha256, SHA(BUNDLE));
  assert.equal(evidence.api.target_matches_pinned_lambda, true);
  assert.equal(evidence.lambda.code_sha256, lambdaConfig.CodeSha256);
  assert.equal(evidence.lambda.workflow_flags.AWS_WRITES_ENABLED, null);
  assert.ok(Object.values(evidence.lambda.workflow_flags).every((value) => value === null || typeof value === 'boolean'));
  assert.equal(evidence.lambda.merged_pr_live_evidence.pr_772_workflow_gate.live_status, 'unverified_no_accepted_production_code_hash');
  assert.deepEqual(evidence.database, { status: report.database.status, reason: report.database.reason });
  assert.equal(evidence.read_errors[0].stderr, undefined);
});

test('workflow writes only the redacted evidence JSON and uses identical JSON in the run summary', async () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/inspect-production-readonly.yml', import.meta.url), 'utf8');
  const inlineScript = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/)[1]
    .replace(/^          /gm, '');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'production-readonly-evidence-'));
  try {
    const report = await inspectProduction({ runAws: mockAws(), fetchImpl: mockFetch });
    report.raw_secret = 'runner-secret-must-not-be-uploaded';
    fs.writeFileSync(path.join(temp, 'production-readonly-inspection.json'), JSON.stringify(report));
    const summaryPath = path.join(temp, 'step-summary');
    execFileSync(process.execPath, ['--input-type=module'], {
      input: inlineScript,
      cwd: new URL('../../', import.meta.url),
      env: { ...process.env, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summaryPath },
    });
    const artifactPath = path.join(temp, 'production-readonly-evidence.json');
    const evidence = fs.readFileSync(artifactPath, 'utf8');
    assert.deepEqual(JSON.parse(evidence), buildInspectionSummary(report));
    assert.equal(evidence.includes('runner-secret-must-not-be-uploaded'), false);
    assert.ok(fs.readFileSync(summaryPath, 'utf8').includes(evidence.trim()));
    assert.equal(fs.statSync(artifactPath).mode & 0o777, 0o600);
    assert.match(workflow, /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
    assert.match(workflow, /name: production-readonly-evidence-\$\{\{ github.sha \}\}-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
    assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/production-readonly-evidence\.json\n/);
    assert.match(workflow, /if-no-files-found: error\n/);
    assert.match(workflow, /retention-days: 30\n/);
    assert.match(workflow, /include-hidden-files: false\n/);
    assert.equal((workflow.match(/uses: actions\/upload-artifact@/g) || []).length, 1);
    assert.doesNotMatch(workflow, /if:.*always\(\)|overwrite: true/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('marks resource identity drift instead of reporting a successful inspection', async () => {
  const report = await inspectProduction({
    runAws: mockAws([], {
      'cloudfront:GetDistribution': () => ({
        ETag: 'other-etag',
        Distribution: { Id: 'unexpected-distribution', Status: 'Deployed' },
      }),
    }),
    fetchImpl: mockFetch,
  });
  assert.equal(report.status, 'target_drift');
});

test('refuses Supabase database targets and has no database connection path', async () => {
  const supabaseHost = ['db', 'unapproved-project', 'supabase', 'co'].join('.');
  const supabaseUrl = ['postgresql:', '', `${supabaseHost}:5432/postgres`].join('/');
  assert.equal(new URL(supabaseUrl).hostname, supabaseHost);
  assert.throws(() => assertProductionTarget({ ...PRODUCTION_TARGET, databaseHost: supabaseHost }), /unexpected production target field/);
  assert.throws(() => assertProductionTarget({ ...PRODUCTION_TARGET, databaseUrl: supabaseUrl }), /unexpected production target field/);

  let connected = false;
  const report = await inspectProduction({
    env: { CHECKSOPS_PRODUCTION_READONLY_DATABASE_URL: supabaseUrl },
    runAws: mockAws(),
    fetchImpl: mockFetch,
    createDatabaseClient: () => {
      connected = true;
      throw new Error('database access must not be attempted');
    },
  });
  assert.equal(report.database.status, 'refused_unproven_aws_production_target');
  assert.equal(report.database.host, undefined);
  assert.equal(connected, false);

  const inspector = fs.readFileSync(new URL('../../scripts/deployment-guard/production-readonly-inspect.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(inspector, /supabase|CHECKSOPS_PRODUCTION_READONLY_DATABASE_URL|postgres(?:ql)?:\/\/|import\(['"]pg['"]\)|createDatabaseClient/i);
});

test('read workflow is manually dispatched, uses protected environment and no mutation or secret-read IAM actions', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/inspect-production-readonly.yml', import.meta.url), 'utf8');
  const docs = fs.readFileSync(new URL('../../ops/production-readonly-inspector.md', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: production-readonly/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /id-token: write/);
  assert.equal((workflow.match(/permissions:/g) || []).length, 1);
  assert.equal(workflow.match(/^permissions:\n([\s\S]*?)\n\n/m)[1], '  contents: read\n  id-token: write');
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  const policy = JSON.parse(workflow.match(/inline-session-policy: >-\n\s+(\{[^\n]+\})/)[1]);
  assert.deepEqual(policy.Statement.map(({ Effect, Action }) => ({ Effect, Action })), [
    { Effect: 'Allow', Action: ['sts:GetCallerIdentity'] },
    { Effect: 'Allow', Action: ['s3:GetObject'] },
    { Effect: 'Allow', Action: ['lambda:GetFunctionConfiguration'] },
    { Effect: 'Allow', Action: ['apigateway:GET'] },
    { Effect: 'Allow', Action: ['cloudfront:GetDistribution'] },
  ]);
  assert.deepEqual(policy.Statement.map(({ Resource }) => Resource), [
    '*',
    [`arn:aws:s3:::${PRODUCTION_PINS.bucket}/index.html`, `arn:aws:s3:::${PRODUCTION_PINS.bucket}/assets/index-*.js`],
    `arn:aws:lambda:${PRODUCTION_PINS.region}:${PRODUCTION_PINS.account_id}:function:${PRODUCTION_PINS.function_name}`,
    [`arn:aws:apigateway:${PRODUCTION_PINS.region}::/apis/${PRODUCTION_PINS.api_id}`, `arn:aws:apigateway:${PRODUCTION_PINS.region}::/apis/${PRODUCTION_PINS.api_id}/stages/${PRODUCTION_PINS.api_stage}`, `arn:aws:apigateway:${PRODUCTION_PINS.region}::/apis/${PRODUCTION_PINS.api_id}/integrations`],
    `arn:aws:cloudfront::${PRODUCTION_PINS.account_id}:distribution/${PRODUCTION_PINS.cloudfront_id}`,
  ]);
  assert.match(workflow, /s3:GetObject/);
  assert.match(workflow, /lambda:GetFunctionConfiguration/);
  assert.match(workflow, /cloudfront:GetDistribution/);
  assert.match(workflow, /apigateway:GET/);
  assert.doesNotMatch(workflow, /secretsmanager:GetSecretValue|s3:PutObject|lambda:UpdateFunction|lambda:PublishVersion|cloudfront:CreateInvalidation|apigateway:POST|apigateway:PATCH/i);
  assert.doesNotMatch(workflow, /supabase|CHECKSOPS_PRODUCTION_READONLY_DATABASE_URL|database connection secret/i);
  assert.doesNotMatch(workflow, /npm ci|PostgreSQL inspection dependency/i);
  assert.match(docs, /refused_unproven_aws_production_target/);
  assert.doesNotMatch(docs, /supabase|CHECKSOPS_PRODUCTION_READONLY_DATABASE_URL|database connection secret/i);
  assert.doesNotMatch(workflow, /\b(?:put-object|sync\s+--delete|delete-object|create-invalidation|update-function-code|update-function-configuration|provider|payment)\b/i);
});
