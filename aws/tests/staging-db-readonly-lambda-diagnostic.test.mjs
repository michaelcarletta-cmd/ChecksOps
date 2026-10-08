import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CORE_TABLES,
  EXPECTED_ROW_COUNTS,
  validateReadonlyCoreTables,
} from '../functions/api/db-readonly-validate.mjs';
import {
  createDiagnosticHandler,
} from '../functions/api/staging-db-readonly-diagnostic.mjs';
import {
  projectValidation,
  summarizeInvocation,
} from '../functions/api/staging-db-readonly-diagnostic-output.mjs';
import { IDENTITY_PROBE } from '../functions/api/db-health.mjs';

const STAGING_ENV = {
  CHECKSOPS_ENV: 'staging',
  DATABASE_NAME: 'checksops',
  DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops/test',
};
const SENSITIVE = 'sensitive-diagnostic-marker';

const validValidation = (overrides = {}) => ({
  ok: false,
  readOnly: true,
  writesAttempted: false,
  transactionReadOnly: 'on',
  defaultTransactionReadOnly: 'on',
  tables: CORE_TABLES.map((table) => ({
    table, present: true, countMatches: false,
    rowCount: EXPECTED_ROW_COUNTS[table], expectedCount: EXPECTED_ROW_COUNTS[table],
  })),
  privileges: [],
  catalog: {},
  issues: [{ kind: 'count_mismatch', severity: 'error', table: 'claims', rowCount: 179, expectedCount: 180, message: SENSITIVE }],
  currentDatabase: SENSITIVE,
  currentUser: SENSITIVE,
  secretDatabase: SENSITIVE,
  error: SENSITIVE,
  ...overrides,
});

test('fixed handler is staging-only, ignores input, and fails closed on unverified read-only state', async () => {
  let calls = 0;
  const handler = createDiagnosticHandler({
    environment: () => STAGING_ENV,
    validate: async (...args) => {
      calls += 1;
      assert.deepEqual(args, []);
      return validValidation();
    },
  });
  const response = await handler({
    body: JSON.stringify({ sql: 'DELETE FROM claims', provider: 'send-payment', secret: SENSITIVE }),
    queryStringParameters: { sql: 'SELECT * FROM claims' },
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 'unhealthy');
  assert.doesNotMatch(JSON.stringify(response), /DELETE|SELECT|send-payment|sensitive-diagnostic-marker/);

  for (const environment of [
    { ...STAGING_ENV, CHECKSOPS_ENV: 'production' },
    { ...STAGING_ENV, DATABASE_NAME: 'postgres' },
    { ...STAGING_ENV, DATABASE_SECRET_ARN: STAGING_ENV.DATABASE_SECRET_ARN.replace('/checksops/', '/checksops_admin/') },
  ]) {
    const result = await createDiagnosticHandler({
      environment: () => environment,
      validate: async () => assert.fail('must not connect'),
    })({});
    assert.equal(result.classification, 'staging_configuration_unavailable');
  }

  const unverified = await createDiagnosticHandler({
    environment: () => STAGING_ENV,
    validate: async () => validValidation({ defaultTransactionReadOnly: 'off' }),
  })({});
  assert.equal(unverified.classification, 'readonly_boundary_unverified');
});

test('projection contains only allowlisted diagnostic labels, booleans, and safe counts', () => {
  const validation = validValidation({
    issues: [
      { kind: 'count_mismatch', severity: 'error', table: 'claims', rowCount: 179, expectedCount: 180, message: SENSITIVE },
      { kind: SENSITIVE, severity: 'error', table: SENSITIVE, probe: SENSITIVE, message: SENSITIVE },
    ],
    tables: CORE_TABLES.map((table) => ({
      table, present: true, countMatches: true,
      rowCount: 0, expectedCount: EXPECTED_ROW_COUNTS[table], error: SENSITIVE,
    })),
    privileges: [{
      table: 'claims', canSelect: true, canInsert: false, canUpdate: false,
      canDelete: false, rlsEnabled: true, rlsForced: false, owner: SENSITIVE,
    }, { table: SENSITIVE, canSelect: true }],
    catalog: {
      publicTriggers: 164, authUsersPresent: true, sentinelPresent: true,
      schemaUsage: { public: true, auth: false, storage: false, extensions: true },
      authUidResult: SENSITIVE, rawError: SENSITIVE,
    },
    rlsMode: 'on',
    rlsAudit: { matrix: SENSITIVE, roles: [SENSITIVE], summary: { tableCount: 16, missingRls: 0 } },
  });
  const result = projectValidation(validation);
  assert.equal(result.tables.length, 16);
  assert.deepEqual(result.issues[0], {
    check: 'row_count', classification: 'count_mismatch', status: 'fail',
    table: 'claims', expectedCount: 180, actualCount: 179,
  });
  assert.equal(result.catalog.publicTriggers, 164);
  assert.equal(result.privileges.length, 1);
  assert.deepEqual(result.tables.find((row) => row.table === 'claims'), {
    table: 'claims', status: 'fail', present: true, countMatches: true, expectedCount: 0, actualCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SENSITIVE));
  assert.doesNotMatch(JSON.stringify(result), /currentDatabase|currentUser|secretDatabase|authUidResult|matrix/);
});

test('existing validator enforces TLS/session/transaction read-only and never dispatches writes', async () => {
  const queries = [];
  let connectionConfig;
  const identity = {
    current_database: 'checksops', current_user: 'checksops',
    transaction_read_only: 'on', default_transaction_read_only: 'on',
  };
  const client = {
    connect: async () => {},
    query: async (sql, params) => {
      queries.push(sql);
      if (sql === IDENTITY_PROBE) return { rows: [identity] };
      if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK'
          || sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')
          || sql.startsWith('ROLLBACK TO SAVEPOINT ')) return { rows: [] };
      if (sql.startsWith('SELECT to_regclass($1)')) return { rows: [{ regclass: params[0] }] };
      if (sql.startsWith('SELECT count(*)::bigint AS row_count')) {
        const table = sql.match(/public\."([^"]+)"/)[1];
        return { rows: [{ row_count: EXPECTED_ROW_COUNTS[table] }] };
      }
      if (sql.includes('has_table_privilege')) return { rows: CORE_TABLES.map((table) => ({
        table_name: table, can_select: true, can_insert: false, can_update: false,
        can_delete: false, rls_enabled: false, rls_forced: false,
      })) };
      if (sql.includes('_checksops_restore_complete')) return { rows: [{ present: true }] };
      if (sql.includes('has_schema_privilege')) return { rows: [
        { schema_name: 'public', can_usage: true }, { schema_name: 'auth', can_usage: false },
        { schema_name: 'storage', can_usage: false }, { schema_name: 'extensions', can_usage: false },
      ] };
      if (sql.includes("c.relname = 'users'")) return { rows: [{ present: true }] };
      if (sql.includes('pg_constraint')) return { rows: [{ fk_count: 0 }] };
      if (sql.includes('pg_trigger')) return { rows: [{ trigger_count: 165 }] };
      if (sql.includes('prokind')) return { rows: [{
        function_count: 0, auth_uid_functions: 0, net_functions: 0, cron_functions: 0,
        vault_functions: 0, pgmq_functions: 0,
      }] };
      if (sql.includes('has_function_privilege')) return { rows: [{ can_execute: false }] };
      if (sql.includes('SELECT auth.uid()')) throw Object.assign(new Error(SENSITIVE), { code: '42501' });
      if (sql.includes('FROM pg_roles')) return { rows: [] };
      if (sql.includes('relrowsecurity')) return { rows: [] };
      if (sql.includes('FROM pg_policies')) return { rows: [] };
      return { rows: [] };
    },
    end: async () => {},
  };
  const result = await validateReadonlyCoreTables({
    loadCredentials: async () => ({
      username: 'checksops', password: SENSITIVE, host: 'db.example.internal',
      database: 'checksops', secretDatabase: 'checksops',
    }),
    createClient: (config) => { connectionConfig = config; return client; },
  });
  assert.equal(result.transactionReadOnly, 'on');
  assert.equal(result.defaultTransactionReadOnly, 'on');
  assert.equal(connectionConfig.ssl.rejectUnauthorized, true);
  assert.match(connectionConfig.options, /default_transaction_read_only=on/);
  assert.ok(queries.includes('BEGIN READ ONLY'));
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(queries.some((sql) => /^\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/i.test(sql)), false);
});

test('invocation summary checks published version and reconstructs only safe output', () => {
  const result = projectValidation(validValidation());
  const metadata = { ExecutedVersion: '12' };
  const summary = summarizeInvocation({ metadata, payload: result, expectedVersion: '12' });
  assert.equal(summary.status, 'unhealthy');
  assert.equal(summary.issues[0].table, 'claims');
  assert.equal(summarizeInvocation({
    metadata: { ExecutedVersion: '13' }, payload: result, expectedVersion: '12',
  }).classification, 'target_version_mismatch');
  assert.equal(summarizeInvocation({
    metadata, payload: { ...result, status: 'ok', issues: [{ message: SENSITIVE }] }, expectedVersion: '12',
  }).classification, 'response_contract_mismatch');
  assert.equal(summarizeInvocation({
    metadata, payload: { ...result, unexpected: SENSITIVE }, expectedVersion: '12',
  }).status, 'unhealthy');
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(SENSITIVE));
});

test('workflow and SAM target are staging-only, exact-version, isolated, and do not weaken deployment guards', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/staging-db-readonly-lambda-diagnostic.yml', import.meta.url), 'utf8');
  const template = fs.readFileSync(new URL('../staging-db-readonly-diagnostic/template.yaml', import.meta.url), 'utf8');
  const apiTemplate = fs.readFileSync(new URL('../template.yaml', import.meta.url), 'utf8');
  const handler = fs.readFileSync(new URL('../functions/api/staging-db-readonly-diagnostic.mjs', import.meta.url), 'utf8');
  const invocation = fs.readFileSync(new URL('../../scripts/staging-db-readonly-lambda-invocation.mjs', import.meta.url), 'utf8');
  const output = fs.readFileSync(new URL('../functions/api/staging-db-readonly-diagnostic-output.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: staging/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /git rev-parse HEAD.*\$GITHUB_SHA/);
  assert.match(workflow, /CHECKSOPS_STAGING_DB_DIAGNOSTIC_ROLE_ARN/);
  assert.match(workflow, /CHECKSOPS_STAGING_DB_DIAGNOSTIC_VERSION_ARN/);
  assert.match(workflow, /CHECKSOPS_STAGING_DIAGNOSTIC_VERSION=/);
  assert.match(workflow, /lambda:InvokeFunction/);
  assert.match(workflow, /--function-name "\$DIAGNOSTIC_TARGET_ARN"/);
  assert.match(output, /ExecutedVersion/);
  assert.doesNotMatch(workflow, /production|CHECKSOPS_STAGING_DIAGNOSTIC_ID_TOKEN|secrets\./i);
  assert.doesNotMatch(workflow, /CHECKSOPS_[A-Z_]*TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(workflow, /pull_request:|push:|upload-artifact|continue-on-error|set -x/);
  assert.match(template, /FunctionName: checksops-staging-db-readonly-diagnostic/);
  assert.match(template, /Handler: staging-db-readonly-diagnostic\.handler/);
  assert.match(template, /AWSSecretsManagerGetSecretValuePolicy:[\s\S]*?SecretArn: !Ref DatabaseSecretArn/);
  assert.match(template, /PROVIDER_SECRETS_ARN: ''/);
  assert.doesNotMatch(apiTemplate, /StagingDbReadonlyDiagnosticFunction/);
  for (const flag of [
    'AWS_WRITES_ENABLED', 'AWS_CHECK_WORKFLOW_WRITES_ENABLED', 'AWS_STORAGE_WRITES_ENABLED',
    'AWS_APPLICATION_WORKFLOW_WRITES_ENABLED', 'AWS_PROVIDER_EXECUTION_ENABLED',
    'AWS_PROVIDER_LIVE_READS_ENABLED', 'AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED',
    'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
  ]) assert.match(template, new RegExp(`${flag}: 'false'`));
  assert.match(handler, /validateReadonlyCoreTables/);
  assert.doesNotMatch(handler, /providers\.mjs|workflow\.mjs|financial\.mjs|storage\.mjs|process\.env\.[A-Z_]*TOKEN/);
});

test('CLI invocation summary never writes raw invocation metadata or payload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-diagnostic-'));
  try {
    const metadataPath = path.join(dir, 'metadata.json');
    const payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(metadataPath, JSON.stringify({ ExecutedVersion: '12' }));
    fs.writeFileSync(payloadPath, JSON.stringify({
      ...projectValidation(validValidation()),
      rawError: SENSITIVE,
    }));
    const { main } = await import('../../scripts/staging-db-readonly-lambda-invocation.mjs');
    let output;
    const status = main({
      metadataPath, payloadPath, expectedVersion: '12', writeOutput: (value) => { output = value; },
    });
    assert.equal(status, 1);
    assert.doesNotMatch(output, new RegExp(SENSITIVE));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
