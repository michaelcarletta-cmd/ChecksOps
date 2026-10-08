import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  assertAllowedInspectionSql,
  assertProductionTarget,
  buildAwsArgs,
  INSPECTION_SQL,
  inspectProduction,
  PRODUCTION_PINS,
} from '../../scripts/deployment-guard/production-readonly-inspect.mjs';

const SHA = (value) => createHash('sha256').update(value).digest('hex');
const INDEX_HTML = '<script type="module" src="/assets/index-test_bundle.js"></script>';
const BUNDLE = 'read-only test bundle';
const DB_URL = `postgres:${'/'}${'/'}checksops_readonly:unit-test-password@db.nbcqwpysqgyxrrbgtmkw.supabase.co:5432/postgres?sslmode=verify-full`;
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

const databaseRows = (sql) => {
  if (sql === INSPECTION_SQL.sessionPosture) {
    return [{
      database_name: 'postgres',
      database_user: 'checksops_readonly',
      is_superuser: false,
      can_create_role: false,
      can_create_database: false,
      can_replicate: false,
      bypasses_rls: false,
      default_transaction_read_only: 'on',
    }];
  }
  if (sql === INSPECTION_SQL.micrColumnGrants) {
    return [
      { column_name: 'routing_number', checksops_role_exists: true, checksops_update: true },
      { column_name: 'account_number', checksops_role_exists: true, checksops_update: true },
    ];
  }
  if (sql === INSPECTION_SQL.settlementFunction) {
    return [{
      definition: "CREATE FUNCTION save_claim_settlement_breakdown() SECURITY DEFINER AS $$ BEGIN password := 'routine-secret-value'; END $$",
      signature: 'p_claim_id uuid, p_settlement_id uuid, p_values jsonb',
      result_type: 'jsonb',
      owner: 'postgres',
      security_definer: true,
      function_settings: ['search_path=pg_catalog, public', 'row_security=off'],
      checksops_can_execute: true,
      authenticated_can_execute: false,
      anon_can_execute: false,
      public_can_execute: false,
    }];
  }
  if (sql === INSPECTION_SQL.homeownerLedgerFunction) {
    return [{
      definition: "CREATE FUNCTION sync_homeowner_ledger_from_check() AS $$ v_event_type <> 'endorsements_sent' $$",
      signature: '',
      owner: 'postgres',
      security_definer: true,
      function_settings: ['search_path=public'],
    }];
  }
  if (sql === INSPECTION_SQL.homeownerLedgerTriggers) {
    return [{
      table_schema: 'public',
      table_name: 'check_intake_items',
      trigger_name: 'trg_sync_homeowner_ledger_upd',
      definition: 'CREATE TRIGGER trg_sync_homeowner_ledger_upd AFTER UPDATE ON public.check_intake_items',
      enabled_state: 'O',
    }];
  }
  assert.fail('Unexpected SQL was executed');
};

function mockDatabaseClient(queries = []) {
  return {
    connect: async () => {},
    query: async (sql) => {
      assertAllowedInspectionSql(sql);
      queries.push(sql);
      return { rows: databaseRows(sql) };
    },
    end: async () => {},
  };
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

test('accepts only fixed catalog SELECTs and rejects mutation, DDL, DCL, CALL, and multi-statement SQL', () => {
  for (const sql of Object.values(INSPECTION_SQL)) assert.equal(assertAllowedInspectionSql(sql), true);
  for (const sql of [
    'UPDATE public.check_intake_items SET status = $1',
    'DELETE FROM public.check_intake_items',
    'INSERT INTO public.check_intake_items DEFAULT VALUES',
    'CREATE TABLE public.inspector_write(id int)',
    'ALTER TABLE public.check_intake_items ADD COLUMN forbidden int',
    'DROP TABLE public.check_intake_items',
    'GRANT UPDATE ON public.check_intake_items TO checksops',
    'REVOKE SELECT ON public.check_intake_items FROM checksops',
    'CALL public.save_claim_settlement_breakdown()',
    'SELECT 1; DELETE FROM public.check_intake_items',
    'SELECT pg_catalog.pg_sleep(1)',
  ]) {
    assert.throws(() => assertAllowedInspectionSql(sql), /not an allowlisted single catalog SELECT/);
  }
});

test('inspects pinned production reads and reports SPA locks, Lambda flags, SQL state, and merged PR evidence safely', async () => {
  const awsCalls = [];
  const sqlCalls = [];
  const report = await inspectProduction({
    env: {
      AWS_REGION: 'us-east-1',
      CHECKSOPS_INSPECTOR_ENVIRONMENT: 'production',
      CHECKSOPS_PRODUCTION_READONLY_INSPECT_ROLE_ARN: PRODUCTION_PINS.readonly_role_arn,
      CHECKSOPS_PRODUCTION_READONLY_DATABASE_URL: DB_URL,
    },
    runAws: mockAws(awsCalls),
    fetchImpl: mockFetch,
    createDatabaseClient: (options) => {
      assert.equal(options.ssl.rejectUnauthorized, true);
      assert.equal(options.options, '-c default_transaction_read_only=on');
      return mockDatabaseClient(sqlCalls);
    },
  });

  assert.equal(report.status, 'complete', JSON.stringify({ read_errors: report.read_errors, database: report.database }));
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
  assert.equal(report.database.sql52_routing_account_column_grants.length, 2);
  assert.equal(report.database.sql53_save_claim_settlement_breakdown.security_definer, true);
  assert.equal(report.database.sql53_save_claim_settlement_breakdown.checksops_can_execute, true);
  assert.equal(report.database.sync_homeowner_ledger_from_check.endorsement_event_suppression_observed, true);
  assert.equal(report.database.sync_homeowner_ledger_from_check.triggers[0].enabled_state, 'O');
  assert.equal(awsCalls.some(({ action }) => /provider|payment|update|put|delete|publish|invalidate/i.test(action)), false);
  assert.equal(sqlCalls.length, Object.values(INSPECTION_SQL).length);
  assert.equal(JSON.stringify(report).includes('database-password-must-not-leak'), false);
  assert.equal(JSON.stringify(report).includes('aws-secret-must-not-leak'), false);
  assert.equal(JSON.stringify(report).includes('sample-password'), false);
  assert.equal(JSON.stringify(report).includes('routine-secret-value'), false);
  assert.match(report.database.sql53_save_claim_settlement_breakdown.definition, /\[REDACTED\]/);
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

test('rejects alternate DB hosts, pooler targets, unverified TLS, and injected URL options before connecting', async () => {
  for (const url of [
    DB_URL.replace('db.nbcqwpysqgyxrrbgtmkw.supabase.co', 'db.other-project.supabase.co'),
    DB_URL.replace(':5432/', ':6543/'),
    DB_URL.replace('sslmode=verify-full', 'sslmode=require'),
    `${DB_URL}&options=-c%20default_transaction_read_only%3Doff`,
  ]) {
    let connected = false;
    const report = await inspectProduction({
      env: { CHECKSOPS_PRODUCTION_READONLY_DATABASE_URL: url },
      runAws: mockAws(),
      fetchImpl: mockFetch,
      createDatabaseClient: () => {
        connected = true;
        return mockDatabaseClient();
      },
    });
    assert.equal(report.database.status, 'refused_unexpected_database_target');
    assert.equal(connected, false);
  }
});

test('read workflow is manually dispatched, uses protected environment and no mutation or secret-read IAM actions', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/inspect-production-readonly.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: production-readonly/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /s3:GetObject/);
  assert.match(workflow, /lambda:GetFunctionConfiguration/);
  assert.match(workflow, /cloudfront:GetDistribution/);
  assert.match(workflow, /apigateway:GET/);
  assert.doesNotMatch(workflow, /secretsmanager:GetSecretValue|s3:PutObject|lambda:UpdateFunction|lambda:PublishVersion|cloudfront:CreateInvalidation|apigateway:POST|apigateway:PATCH/i);
  assert.doesNotMatch(workflow, /\b(?:put-object|sync\s+--delete|delete-object|create-invalidation|update-function-code|update-function-configuration|provider|payment)\b/i);
});
