import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  commandFor,
  compareSpaToLock,
  DATABASE_READ_ONLY_SQL,
  databaseConnectionOptions,
  extractBundlePath,
  ACCEPTANCE_REQUIRED_BEFORE_PROMOTION,
  inspectDatabase,
  normalizeFlags,
  normalizeSqlBody,
  READ_ONLY_AWS_OPERATIONS,
  sqlFunctionBody,
  validateLambdaCodeLocation,
  verifyInspectionWorkflowIdentity,
} from '../../scripts/deployment-guard/production-readonly-inspect.mjs';

const ROOT = new URL('../..', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, ROOT), 'utf8');

test('production inspector is pinned to one reviewed main commit', () => {
  const base = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'a'.repeat(40),
  };
  assert.equal(verifyInspectionWorkflowIdentity(base, base.GITHUB_SHA, base.GITHUB_SHA), base.GITHUB_SHA);
  assert.throws(() => verifyInspectionWorkflowIdentity({ ...base, GITHUB_REF: 'refs/heads/staging' }, base.GITHUB_SHA, base.GITHUB_SHA));
  assert.throws(() => verifyInspectionWorkflowIdentity(base, base.GITHUB_SHA, 'b'.repeat(40)));
  assert.throws(() => verifyInspectionWorkflowIdentity({ ...base, GITHUB_ACTIONS: 'false' }, base.GITHUB_SHA, base.GITHUB_SHA));
});

test('SPA entry parsing accepts only one local hashed production index bundle', () => {
  assert.equal(
    extractBundlePath('<script type="module" src="/assets/index-Abc_123.js"></script>'),
    '/assets/index-Abc_123.js',
  );
  assert.equal(extractBundlePath('<script src="/assets/index-a.js"></script><script src="/assets/index-b.js"></script>'), null);
  assert.equal(extractBundlePath('<script src="https://attacker.example/a.js"></script>'), null);
  assert.equal(extractBundlePath('<script src="/assets/../index.js"></script>'), null);
});

test('production lock comparison reports live drift and stale linked proof independently', () => {
  const lock = {
    artifact: { name: '/assets/index-live.js' },
    deployment_fingerprint: { spa_sha256: 'a'.repeat(64) },
  };
  const live = { entry: '/assets/index-live.js', bundle_sha256: 'a'.repeat(64) };
  assert.deepEqual(compareSpaToLock(live, lock, {
    entry: '/assets/index-old.js',
    bundle_sha256: 'b'.repeat(64),
  }), {
    lock_matches_live: true,
    proof_matches_lock: false,
    drift: ['linked SPA proof disagrees with the current production lock'],
  });
  assert.equal(compareSpaToLock({ ...live, bundle_sha256: 'c'.repeat(64) }, lock, {
    entry: lock.artifact.name,
    bundle_sha256: lock.deployment_fingerprint.spa_sha256,
  }).lock_matches_live, false);
});

test('feature flag report allowlists only non-secret flags and normalizes values', () => {
  assert.deepEqual(normalizeFlags({
    AWS_APPLICATION_WORKFLOW_WRITES_ENABLED: 'true',
    AWS_WRITES_ENABLED: 'TRUE',
    DATABASE_URL: 'should-not-be-reported',
    AWS_SECRET_ACCESS_KEY: 'secret',
  }), {
    AWS_WRITES_ENABLED: 'unset',
    AWS_APPLICATION_WORKFLOW_WRITES_ENABLED: 'true',
    AWS_CHECK_WORKFLOW_WRITES_ENABLED: 'unset',
    AWS_STORAGE_WRITES_ENABLED: 'unset',
    AWS_PROVIDER_EXECUTION_ENABLED: 'unset',
    AWS_PROVIDER_LIVE_READS_ENABLED: 'unset',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'unset',
  });
});

test('production AWS operation map contains reads only and rejects retargeting', () => {
  assert.ok(READ_ONLY_AWS_OPERATIONS.every((operation) => /^(lambda\.get-|lambda\.list-|apigatewayv2\.get-|cloudfront\.get-|s3api\.(head|get)-)/.test(operation)));
  assert.deepEqual(commandFor('lambda.get-function', { qualifier: '17' }).slice(0, 4), [
    'lambda', 'get-function', '--function-name', 'checksops-production-prep-api',
  ]);
  assert.throws(() => commandFor('lambda.update-function-code'));
  assert.throws(() => commandFor('lambda.get-function', { qualifier: 'prod;update' }));
  assert.throws(() => commandFor('s3api.head-object', { key: '../other-bucket/object' }));
  assert.throws(() => commandFor('s3api.head-object', { key: 'assets/unhashed.js' }));
});

test('Lambda ZIP download is limited to HTTPS AWS S3 URLs', () => {
  assert.equal(
    new URL(validateLambdaCodeLocation('https://awslambda-us-east-1-tasks.s3.us-east-1.amazonaws.com/object')).hostname,
    'awslambda-us-east-1-tasks.s3.us-east-1.amazonaws.com',
  );
  assert.throws(() => validateLambdaCodeLocation('http://127.0.0.1/latest/meta-data/'));
  assert.throws(() => validateLambdaCodeLocation('https://attacker.example/package.zip'));
  assert.throws(() => validateLambdaCodeLocation('https://package.s3.attacker.amazonaws.com/package.zip'));
  assert.throws(() => validateLambdaCodeLocation('https://awslambda-eu-west-1-tasks.s3.eu-west-1.amazonaws.com/package.zip'));
});

test('database connection is pinned to the dedicated read-only production role and TLS', () => {
  const url = `postgresql://${encodeURIComponent('checksops_prod_inspector')}:${encodeURIComponent('example-password')}@db.nbcqwpysqgyxrrbgtmkw.supabase.co:5432/postgres?sslmode=verify-full`;
  const options = databaseConnectionOptions(url);
  assert.equal(options.connectionString, url);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.match(options.options, /default_transaction_read_only=on/);
  const stagingUrl = new URL(url);
  stagingUrl.hostname = 'staging.example';
  assert.throws(() => databaseConnectionOptions(stagingUrl.toString()));
  assert.throws(() => databaseConnectionOptions('postgresql://checksops_prod_inspector@db.nbcqwpysqgyxrrbgtmkw.supabase.co:5432/postgres'));
  const unsafeUrl = new URL(url);
  unsafeUrl.searchParams.set('options', '-c role=postgres');
  assert.throws(() => databaseConnectionOptions(unsafeUrl.toString()));
});

test('every database inspection statement is a fixed SELECT with no application function calls', () => {
  for (const query of Object.values(DATABASE_READ_ONLY_SQL)) {
    assert.match(query, /^\s*SELECT\b/i);
    const sqlCode = query.replace(/'(?:''|[^'])*'/g, "''");
    assert.doesNotMatch(sqlCode, /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|CALL)\b/i);
    assert.doesNotMatch(sqlCode, /save_claim_settlement_breakdown\s*\(/i);
  }
  assert.match(DATABASE_READ_ONLY_SQL.endorsement, /trg_sync_homeowner_ledger_upd/);
  assert.match(DATABASE_READ_ONLY_SQL.endorsement, /status_column\.attnum = ANY\(t\.tgattr\)/);
  const workflow = read('.github/workflows/production-readonly-inspect.yml');
  assert.match(workflow, /environment:\s*production-readonly/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /checksops-staging|lambda invoke|update-function|s3api (put|delete|copy)|cloudfront (create|update)/i);
  assert.match(workflow, /CHECKSOPS_PRODUCTION_INSPECT_DATABASE_URL/);
  assert.doesNotMatch(read('aws/functions/api/write-allowlist.mjs'), /\bclaim_settlements\b/);
  assert.ok(ACCEPTANCE_REQUIRED_BEFORE_PROMOTION.some((item) => item.includes('Delete Check, Signature Requests')));
  assert.ok(ACCEPTANCE_REQUIRED_BEFORE_PROMOTION.some((item) => item.includes('Payee and issue-date')));
});

test('production workflow has only scoped read actions and a protected manual environment', () => {
  const workflow = read('.github/workflows/production-readonly-inspect.yml');
  const policy = workflow.match(/inline-session-policy:\s*>-\s*\n((?:\s{12,}.+\n)+)/)?.[1];
  assert.ok(policy);
  const actions = JSON.parse(policy.trim().split('\n').map((line) => line.trim()).join(' ')).Statement
    .flatMap((statement) => statement.Action);
  assert.deepEqual(actions.sort(), [
    'apigateway:GET',
    'cloudfront:GetDistribution',
    'lambda:GetFunction',
    'lambda:GetFunctionConfiguration',
    'lambda:ListAliases',
    's3:GetObject',
  ].sort());
  assert.match(workflow, /environment:\s*production-readonly/);
  assert.match(workflow, /name:\s*Production read-only fingerprint inspection/);
  assert.doesNotMatch(workflow, /secretsmanager:|ssm:|lambda:Invoke|lambda:Update|lambda:Publish|s3:Put|s3:Delete|cloudfront:Create|cloudfront:Update/i);
});

test('database inspection pins a READ ONLY transaction and rolls back without executing writes', async () => {
  const calls = [];
  const connection = `postgresql://${encodeURIComponent('checksops_prod_inspector')}:${encodeURIComponent('example-password')}@db.nbcqwpysqgyxrrbgtmkw.supabase.co:5432/postgres?sslmode=verify-full`;
  const sql53 = read('aws/workflows/sql/53_claim_settlement_breakdown.sql');
  const migration = read('supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql');
  const results = new Map([
    [DATABASE_READ_ONLY_SQL.identity, { rows: [{
      role_name: 'checksops_prod_inspector',
      database_name: 'postgres',
      transaction_read_only: 'on',
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      can_create_in_database: false,
      can_create_in_public: false,
    }] }],
    [DATABASE_READ_ONLY_SQL.micr, { rows: [{
      checksops_routing_update: true,
      checksops_account_update: true,
      explicit_routing_column_grant: true,
      explicit_account_column_grant: true,
      authenticated_routing_update: false,
      authenticated_account_update: false,
      anon_routing_update: false,
      anon_account_update: false,
    }] }],
    [DATABASE_READ_ONLY_SQL.settlement, { rows: [{
      exists: true,
      definition: sql53,
      owner: 'postgres',
      security_definer: true,
      settings: ['search_path=pg_catalog, public', 'row_security=off'],
      public_execute: false,
      checksops_execute: true,
      authenticated_execute: false,
      anon_execute: false,
    }] }],
    [DATABASE_READ_ONLY_SQL.endorsement, { rows: [{
      function_exists: true,
      definition: migration,
      body: sqlFunctionBody(migration),
      owner: 'postgres',
      security_definer: true,
      settings: ['search_path=public'],
      enabled_status_update_trigger: true,
      status_update_trigger_definition: 'CREATE TRIGGER trg_sync_homeowner_ledger_upd AFTER UPDATE OF status ON public.check_intake_items FOR EACH ROW EXECUTE FUNCTION public.sync_homeowner_ledger_from_check()',
    }] }],
    [DATABASE_READ_ONLY_SQL.settlement_write_privileges, { rows: [{
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_truncate: false,
    }] }],
  ]);
  const client = {
    async connect() { calls.push('CONNECT'); },
    async query(query) {
      calls.push(query);
      if (query === 'BEGIN READ ONLY' || query === 'ROLLBACK') return { rows: [] };
      return results.get(query);
    },
    async end() { calls.push('END'); },
  };
  const report = await inspectDatabase({
    env: {
      CHECKSOPS_PRODUCTION_INSPECT_DATABASE_URL: connection,
    },
    createClient: () => client,
  });
  assert.equal(report.status, 'verified');
  assert.equal(report.sql52.intended_state, true);
  assert.equal(report.sql53.intended_state, true);
  assert.equal(report.endorsement_trigger.intended_state, true);
  assert.equal(report.generic_claim_settlements_writes_blocked, true);
  assert.equal(calls[0], 'CONNECT');
  assert.equal(calls[1], 'BEGIN READ ONLY');
  assert.equal(calls.at(-2), 'ROLLBACK');
  assert.equal(calls.at(-1), 'END');
  assert.ok(calls.slice(2, -2).every((query) => /^\s*SELECT\b/i.test(query)));
  assert.ok(!JSON.stringify(report).includes('example-password'));
});

test('the endorsement source body comparator normalizes whitespace only', () => {
  const source = read('supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql');
  const expected = sqlFunctionBody(source);
  assert.ok(expected);
  assert.equal(normalizeSqlBody(expected), normalizeSqlBody(`\n${expected.replace(/\s+/g, ' ')}\n`));
  assert.notEqual(
    normalizeSqlBody("RETURN jsonb_build_object('code', 'not found');"),
    normalizeSqlBody("RETURN jsonb_build_object('code', 'notfound');"),
  );
  assert.match(expected, /v_event_type <> 'endorsements_sent'/);
});
