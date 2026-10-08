import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { HOST, ROLE, SECRET_ARN, inspect, main } from '../../scripts/staging-db-aws-inspect.mjs';

const SENSITIVE = 'sensitive-value-not-for-output';
const env = {
  GITHUB_REPOSITORY: 'michaelcarletta-cmd/ChecksOps', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123',
};
const identity = {
  Account: '806168576068',
  Arn: `arn:aws:sts::806168576068:assumed-role/${ROLE}/checksops-staging-db-inspect-123`,
};
const secret = { host: HOST, username: 'checksops', port: 5432, dbname: 'postgres', password: SENSITIVE };
const result = (extra = {}) => ({
  ok: false, readOnly: true, writesAttempted: false,
  transactionReadOnly: 'on', currentUser: 'checksops', currentDatabase: 'checksops',
  issues: [{ kind: 'trigger', severity: 'error', message: SENSITIVE }],
  tables: [], catalog: { publicTriggers: 164, authUidResult: SENSITIVE }, ...extra,
});
const options = (extra = {}) => ({
  env, getIdentity: async () => identity,
  getSecret: async () => ({ ARN: SECRET_ARN, SecretString: JSON.stringify(secret) }),
  validate: async () => result(), ...extra,
});
const run = async (extra = {}) => {
  const output = [];
  const summary = [];
  const code = await main(options({
    writeOutput: (text) => output.push(text), writeSummary: (text) => summary.push(text), ...extra,
  }));
  assert.deepEqual(output, summary);
  assert.equal(output.length, 1);
  assert.doesNotMatch(output[0], new RegExp(SENSITIVE));
  return { code, text: output[0] };
};

test('authenticates AWS before reading one fixed secret and reuses application validator', async () => {
  const calls = [];
  const output = await inspect(options({
    getIdentity: async () => { calls.push('identity'); return identity; },
    getSecret: async () => {
      calls.push('secret');
      return { ARN: SECRET_ARN, SecretString: JSON.stringify(secret) };
    },
    validate: async ({ loadCredentials }) => {
      calls.push('validate');
      assert.deepEqual(await loadCredentials(), {
        host: HOST, port: 5432, username: 'checksops', password: SENSITIVE,
        database: 'checksops', secretDatabase: 'postgres',
      });
      return result();
    },
  }));
  assert.deepEqual(calls, ['identity', 'secret', 'validate']);
  assert.deepEqual(output, {
    status: 'unhealthy',
    issues: [{ kind: 'trigger', severity: 'error', probe: 'triggers', expectedCount: 165, actualCount: 164 }],
  });
});

test('unchanged validator executes only read-only SQL with verified TLS and always rolls back', async () => {
  const { CORE_TABLES, EXPECTED_ROW_COUNTS, validateReadonlyCoreTables } = await import('../functions/api/db-readonly-validate.mjs');
  const { IDENTITY_PROBE } = await import('../functions/api/db-health.mjs');
  const queries = [];
  let ended = false;
  const { code, text } = await run({
    validate: (input) => validateReadonlyCoreTables({
      ...input,
      createClient: (config) => {
        assert.equal(config.host, HOST);
        assert.equal(config.user, 'checksops');
        assert.equal(config.database, 'checksops');
        assert.equal(config.ssl.rejectUnauthorized, true);
        assert.match(config.ssl.ca, /BEGIN CERTIFICATE/);
        assert.equal(config.options, '-c default_transaction_read_only=on');
        return {
          connect: async () => {},
          end: async () => { ended = true; },
          query: async (sql, params) => {
            queries.push(sql);
            assert.match(sql, /^(SELECT\b|BEGIN READ ONLY$|SAVEPOINT\b|RELEASE SAVEPOINT\b|ROLLBACK\b)/);
            if (sql === IDENTITY_PROBE) return { rows: [{
              current_database: 'checksops', current_user: 'checksops',
              transaction_read_only: 'on', default_transaction_read_only: 'on',
            }] };
            if (sql.startsWith('SELECT to_regclass($1)')) return { rows: [{ regclass: params[0] }] };
            if (sql.startsWith('SELECT count(*)::bigint')) {
              const table = sql.match(/public\."([^"]+)"/)[1];
              return { rows: [{ row_count: EXPECTED_ROW_COUNTS[table] - (table === 'claims' ? 1 : 0) }] };
            }
            if (sql.includes('has_table_privilege')) return { rows: CORE_TABLES.map((table) => ({
              table_name: table, can_select: true, rls_enabled: false,
            })) };
            if (sql.includes('_checksops_restore_complete')) return { rows: [{ present: true }] };
            if (sql.includes('has_schema_privilege')) return { rows: [{ schema_name: 'public', can_usage: true }] };
            if (sql.includes('pg_trigger')) return { rows: [{ trigger_count: 164 }] };
            return { rows: [] };
          },
        };
      },
    }),
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(text).issues, [
    { kind: 'count_mismatch', severity: 'error', probe: 'row_count', table: 'claims', expectedCount: 180, actualCount: 179 },
    { kind: 'trigger', severity: 'error', probe: 'triggers', expectedCount: 165, actualCount: 164 },
  ]);
  assert.equal(queries[0], 'BEGIN READ ONLY');
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.ok(queries.some((sql) => sql.startsWith('SAVEPOINT ')));
  assert.equal(ended, true);
});

test('rejects non-manual, non-main, wrong repository and malformed SHA before AWS', async () => {
  for (const overrides of [
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REF: 'refs/heads/production' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REPOSITORY: 'other/ChecksOps' },
    { GITHUB_SHA: '' }, { GITHUB_RUN_ID: '' },
  ]) {
    const { code, text } = await run({
      env: { ...env, ...overrides }, getIdentity: async () => assert.fail('no AWS'),
    });
    assert.equal(code, 2);
    assert.match(text, /workflow_identity_rejected/);
  }
});

test('rejects wrong AWS account, role and session before secret retrieval', async () => {
  for (const bad of [null, { ...identity, Account: 'other' }, { ...identity, Arn: 'production' },
    { ...identity, Arn: identity.Arn.replace('-123', '-124') }]) {
    assert.equal((await run({
      getIdentity: async () => bad, getSecret: async () => assert.fail('no secret'),
    })).code, 2);
  }
});

test('rejects production, admin, wrong database/port/ARN and malformed secrets before DB access', async () => {
  for (const bad of [
    { ...secret, host: 'production.example' }, { ...secret, username: 'checksops_admin' },
    { ...secret, dbname: 'other' }, { ...secret, database: 'other' },
    { ...secret, port: 5433 }, { ...secret, password: '' }, null,
  ]) {
    assert.equal((await run({
      getSecret: async () => ({ ARN: SECRET_ARN, SecretString: JSON.stringify(bad) }),
      validate: async () => assert.fail('no DB access'),
    })).code, 2);
  }
  for (const response of [{ ARN: 'production', SecretString: '{}' }, { ARN: SECRET_ARN, SecretString: SENSITIVE }]) {
    assert.equal((await run({ getSecret: async () => response })).code, 2);
  }
});

test('never prints SDK, CLI, database errors or sensitive validator fields', async () => {
  for (const key of ['getIdentity', 'getSecret', 'validate']) {
    assert.equal((await run({ [key]: async () => { throw new Error(SENSITIVE); } })).code, 2);
  }
  const { code, text } = await run({ validate: async () => result({
    password: SENSITIVE, rows: [SENSITIVE],
    issues: [
      { kind: 'count_mismatch', severity: 'error', table: 'claims', rowCount: 179, expectedCount: 180, message: SENSITIVE },
      { kind: 'permission', severity: 'error', table: 'profiles', message: 'FORCE ROW LEVEL SECURITY is set on public.profiles' },
      { kind: 'missing_relation', severity: 'error', probe: 'sentinel', message: SENSITIVE },
      { kind: 'query', severity: 'error', probe: 'functions', message: SENSITIVE },
      { kind: 'missing_fk', severity: 'error', restored: 46, message: SENSITIVE },
    ],
  }) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(text).issues.map((item) => item.probe),
    ['row_count', 'force_rls', 'sentinel', 'functions', 'auth_users_fks']);
});

test('fails closed on mutable, wrong identity or unexpected validation contracts', async () => {
  for (const extra of [
    { readOnly: false }, { writesAttempted: true }, { transactionReadOnly: 'off' },
    { ok: true, issues: [], transactionReadOnly: null },
    { currentDatabase: 'production' }, { currentUser: 'checksops_admin' },
    { tables: [{ table: SENSITIVE }] }, { ok: true },
  ]) assert.equal((await run({ validate: async () => result(extra) })).code, 2);
  assert.equal((await run({ validate: async () => result({ ok: true, issues: [] }) })).code, 0);
  const failed = await run({ validate: async () => result({
    currentDatabase: null, currentUser: null, transactionReadOnly: null,
    issues: [{ kind: 'networkTls', severity: 'error', message: SENSITIVE }],
  }) });
  assert.equal(failed.code, 1);
  assert.match(failed.text, /networkTls/);
});

test('workflow is protected, exact-SHA, no configurable targets or deployment permissions', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/staging-db-aws-inspect.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: staging/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /git rev-parse HEAD.*\$GITHUB_SHA/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /needs: prerequisites/);
  assert.match(workflow, /checksops-staging-db-readonly/);
  assert.match(workflow, /test "\$READY" = "true"/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /--ignore-scripts/);
  assert.match(workflow, /unset-current-credentials: true/);
  assert.match(workflow, /role-duration-seconds: 900/);
  assert.ok(workflow.includes(`"Resource":"${SECRET_ARN}"`));
  assert.doesNotMatch(workflow, /pull_request:|push:|inputs:|secrets\.|upload-artifact|continue-on-error|set -x|"Action":"(?:lambda|s3|rds|iam):|\bdeploy\b/);
  const script = fs.readFileSync(new URL('../../scripts/staging-db-aws-inspect.mjs', import.meta.url), 'utf8');
  assert.match(script, /validateReadonlyCoreTables\(options\)/);
  assert.doesNotMatch(script, /console\.error|SecretBinary|process\.env\.(?:DATABASE|RDS)|lambda.*invoke/);
});
