import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { handler, requestPath } from '../functions/api/index.mjs';
import {
  loadDatabaseCredentials,
  parseDatabaseSecretString,
  publicCredentialFields,
  resolveDatabaseName,
} from '../functions/api/secrets.mjs';
import {
  IDENTITY_PROBE,
  READ_ONLY_PROBE,
  VERSION_PROBE,
  probeDatabase,
  probeIsHealthy,
  buildClientConfig,
  buildWriteClientConfig,
} from '../functions/api/db-health.mjs';
import {
  CORE_TABLES,
  EXPECTED_ROW_COUNTS,
  validateReadonlyCoreTables,
} from '../functions/api/db-readonly-validate.mjs';

const savedEnv = {};

const setEnv = (key, value) => {
  if (!Object.hasOwn(savedEnv, key)) {
    savedEnv[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

beforeEach(() => {
  setEnv('CHECKSOPS_ENV', 'staging');
  setEnv(
    'DATABASE_SECRET_ARN',
    'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops/example',
  );
  setEnv('DATABASE_NAME', 'checksops');
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});

const invoke = (overrides = {}) =>
  handler({
    rawPath: '/health',
    requestContext: {
      stage: 'staging',
      http: { method: 'GET', path: '/health' },
    },
    ...overrides,
  });

const identityRow = {
  current_database: 'checksops',
  current_user: 'checksops',
  transaction_read_only: 'on',
  default_transaction_read_only: 'on',
};

const mockHealthClient = () => ({
  connect: async () => {},
  query: async (sql) => {
    if (sql === READ_ONLY_PROBE) return { rows: [{ ok: 1 }] };
    if (sql === VERSION_PROBE) return { rows: [{ server_version: '18.3' }] };
    if (sql === IDENTITY_PROBE) return { rows: [identityRow] };
    throw new Error(`unexpected query: ${sql}`);
  },
  end: async () => {},
});

test('strips HTTP API stage prefix from rawPath', () => {
  assert.equal(
    requestPath({
      rawPath: '/staging/health',
      requestContext: { stage: 'staging' },
    }),
    '/health',
  );
  assert.equal(
    requestPath({
      rawPath: '/health',
      requestContext: { stage: 'staging' },
    }),
    '/health',
  );
});

test('GET /health returns staging ok without a database password', async () => {
  const response = await invoke();
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.service, 'checksops-api');
  assert.equal(body.environment, 'staging');
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'not-connected');
  assert.equal(body.databaseSecretConfigured, true);
  assert.equal(body.databaseName, 'checksops');
  assert.equal(body.productionSupabaseChanged, false);
  assert.equal(Object.hasOwn(body, 'password'), false);
  assert.doesNotMatch(response.body, /password/i);
});

test('GET /staging/health succeeds when API Gateway includes the stage', async () => {
  const response = await invoke({
    rawPath: '/staging/health',
    requestContext: {
      stage: 'staging',
      http: { method: 'GET', path: '/staging/health' },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).status, 'ok');
});

test('unknown routes return 404', async () => {
  const response = await invoke({
    rawPath: '/v1/tenants',
    requestContext: {
      stage: 'staging',
      http: { method: 'GET', path: '/v1/tenants' },
    },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error, 'not_found');
});

test('validation routes reject non-GET methods', async () => {
  const response = await invoke({
    rawPath: '/db-readonly-validate',
    requestContext: {
      stage: 'staging',
      http: { method: 'POST', path: '/db-readonly-validate' },
    },
  });
  assert.equal(response.statusCode, 405);
  assert.equal(JSON.parse(response.body).error, 'method_not_allowed');
});

test('parses application database secret JSON without exposing it in public fields', () => {
  const credentials = parseDatabaseSecretString(JSON.stringify({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
    port: 5432,
    dbname: 'postgres',
  }));
  const published = publicCredentialFields(credentials);
  assert.equal(published.username, 'checksops');
  assert.equal(published.host, 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com');
  assert.equal(published.port, 5432);
  assert.equal(published.database, 'checksops');
  assert.equal(published.secretDatabase, 'postgres');
  assert.equal(Object.hasOwn(published, 'password'), false);
});

test('DATABASE_NAME overrides secret dbname without using admin', () => {
  setEnv('DATABASE_NAME', 'checksops');
  assert.equal(resolveDatabaseName('postgres'), 'checksops');
  setEnv('DATABASE_NAME', '');
  assert.equal(resolveDatabaseName('postgres'), 'postgres');
  setEnv('DATABASE_NAME', 'not-a-real-db');
  assert.throws(() => resolveDatabaseName('postgres'), /unexpected DATABASE_NAME/);
});

test('refuses the checksops_admin secret ARN', async () => {
  setEnv(
    'DATABASE_SECRET_ARN',
    'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops_admin/example',
  );
  await assert.rejects(
    () => loadDatabaseCredentials(async () => '{"username":"checksops_admin","password":"nope"}'),
    /checksops_admin/,
  );
});

test('GET /db-health reports current database and user without leaking secrets', async () => {
  const probe = await probeDatabase({
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      port: 5432,
      database: 'checksops',
      secretDatabase: 'postgres',
    }),
    createClient: mockHealthClient,
  });
  assert.equal(probe.secretsManager, 'ok');
  assert.equal(probe.networkTls, 'ok');
  assert.equal(probe.authentication, 'ok');
  assert.equal(probe.select1, 'ok');
  assert.equal(probe.postgresqlVersion, '18.3');
  assert.equal(probe.currentDatabase, 'checksops');
  assert.equal(probe.currentUser, 'checksops');
  assert.equal(probe.secretDatabase, 'postgres');
  assert.equal(probe.databaseNameOverride, 'checksops');
  assert.equal(probeIsHealthy(probe), true);
  assert.equal(JSON.stringify(probe).includes('unit-test-only-not-a-real-secret'), false);
});

test('TLS client config verifies certificates and stays read-only', async () => {
  const ssl = (await import('../functions/api/db-health.mjs')).tlsConfig();
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(typeof ssl.ca, 'string');
  assert.match(ssl.ca, /BEGIN CERTIFICATE/);
  const config = buildClientConfig({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    port: 5432,
    database: 'checksops',
  });
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.user, 'checksops');
  assert.equal(config.database, 'checksops');
  assert.match(config.options, /default_transaction_read_only=on/);
  const writeConfig = buildWriteClientConfig({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  });
  assert.equal(writeConfig.options, undefined);
  assert.equal(writeConfig.user, 'checksops');
  assert.throws(
    () => buildClientConfig({
      username: 'checksops_admin',
      password: 'nope',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    /checksops_admin/,
  );
});

const mockValidateClient = ({
  counts = EXPECTED_ROW_COUNTS,
  missingTables = [],
  canExecuteAuthUid = false,
  authUidError = Object.assign(new Error('permission denied for function uid'), { code: '42501' }),
  authUsersFkCount = 0,
  triggerCount = 164,
  writePrivilege = false,
  rlsEnabled = false,
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK' || sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ') || sql.startsWith('ROLLBACK TO SAVEPOINT ')) {
        return { rows: [] };
      }
      if (sql === IDENTITY_PROBE) return { rows: [identityRow] };
      if (sql.startsWith('SELECT to_regclass($1)')) {
        const name = params[0];
        const table = String(name).replace('public.', '');
        if (missingTables.includes(table)) return { rows: [{ regclass: null }] };
        return { rows: [{ regclass: name }] };
      }
      if (sql.startsWith('SELECT count(*)::bigint AS row_count FROM public.')) {
        const table = sql.match(/public\."([^"]+)"/)[1];
        return { rows: [{ row_count: counts[table] }] };
      }
      if (sql.includes('has_table_privilege')) {
        return {
          rows: CORE_TABLES.map((table) => ({
            table_name: table,
            can_select: true,
            can_insert: writePrivilege,
            can_update: false,
            can_delete: false,
            rls_enabled: rlsEnabled,
            rls_forced: false,
          })),
        };
      }
      if (sql.includes("_checksops_restore_complete")) {
        return { rows: [{ present: true }] };
      }
      if (sql.includes('has_schema_privilege')) {
        return {
          rows: [
            { schema_name: 'auth', can_usage: false },
            { schema_name: 'extensions', can_usage: false },
            { schema_name: 'public', can_usage: true },
            { schema_name: 'storage', can_usage: false },
          ],
        };
      }
      if (sql.includes("c.relname = 'users'") && sql.includes("n.nspname = 'auth'")) {
        return { rows: [{ present: true }] };
      }
      if (sql.includes('pg_constraint')) {
        return { rows: [{ fk_count: authUsersFkCount }] };
      }
      if (sql.includes('pg_trigger')) {
        return { rows: [{ trigger_count: triggerCount }] };
      }
      if (sql.includes('prokind')) {
        return {
          rows: [{
            function_count: 960,
            auth_uid_functions: 40,
            net_functions: 4,
            cron_functions: 2,
            vault_functions: 5,
            pgmq_functions: 5,
          }],
        };
      }
      if (sql.includes('has_function_privilege')) {
        return { rows: [{ can_execute: canExecuteAuthUid }] };
      }
      if (sql.includes('SELECT auth.uid()')) {
        if (authUidError) throw authUidError;
        return { rows: [{ auth_uid: null }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    end: async () => {},
  };
};

test('read-only core table validation matches expected counts and reports skipped FKs', async () => {
  const client = mockValidateClient();
  const validation = await validateReadonlyCoreTables({
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      port: 5432,
      database: 'checksops',
      secretDatabase: 'postgres',
    }),
    createClient: () => client,
  });
  assert.equal(validation.ok, true);
  assert.equal(validation.writesAttempted, false);
  assert.equal(validation.currentDatabase, 'checksops');
  assert.equal(validation.currentUser, 'checksops');
  assert.equal(validation.tables.length, CORE_TABLES.length);
  assert.equal(validation.tables.every((row) => row.countMatches), true);
  assert.equal(validation.privileges.every((row) => row.canSelect && !row.canInsert), true);
  assert.equal(validation.catalog.restoredAuthUsersForeignKeys, 0);
  assert.equal(validation.catalog.canExecuteAuthUid, false);
  assert.equal(validation.catalog.schemaUsage.public, true);
  assert.equal(validation.catalog.schemaUsage.auth, false);
  assert.equal(validation.issues.some((item) => item.kind === 'missing_fk' && item.severity === 'expected'), true);
  assert.equal(validation.issues.some((item) => item.kind === 'function' && item.severity === 'expected'), true);
  assert.equal(validation.issues.some((item) => item.kind === 'permission' && item.severity === 'expected'), true);
  assert.equal(validation.issues.some((item) => item.severity === 'error'), false);
  assert.equal(client.queries.some((item) => /INSERT|UPDATE|DELETE/i.test(item.sql) && !item.sql.includes('has_table_privilege')), false);
  assert.equal(JSON.stringify(validation).includes('unit-test-only-not-a-real-secret'), false);
});

test('read-only validation fails closed on a count mismatch', async () => {
  const validation = await validateReadonlyCoreTables({
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
      secretDatabase: 'postgres',
    }),
    createClient: () => mockValidateClient({ counts: { ...EXPECTED_ROW_COUNTS, tenants: 0 } }),
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.issues.some((item) => item.kind === 'count_mismatch' && item.table === 'tenants'), true);
});

test('read-only validation accepts global RLS fail-closed counts without identity', async () => {
  const zeroCounts = Object.fromEntries(CORE_TABLES.map((table) => [table, 0]));
  const validation = await validateReadonlyCoreTables({
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
      secretDatabase: 'postgres',
    }),
    createClient: () => mockValidateClient({ counts: zeroCounts, rlsEnabled: true }),
  });
  assert.equal(validation.ok, true);
  assert.equal(validation.rlsMode, 'on');
  assert.equal(validation.restoredTablesRlsEnabled, true);
  assert.equal(validation.failClosedWithoutIdentity, true);
  assert.equal(validation.issues.some((item) => item.severity === 'error'), false);
});

test('read-only validation fails open if RLS is on and restore rows are still visible', async () => {
  const validation = await validateReadonlyCoreTables({
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
      secretDatabase: 'postgres',
    }),
    createClient: () => mockValidateClient({ rlsEnabled: true }),
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.rlsMode, 'on');
  assert.equal(validation.failClosedWithoutIdentity, false);
  assert.equal(validation.issues.some((item) => /without request.app_user_id/.test(item.message)), true);
});
