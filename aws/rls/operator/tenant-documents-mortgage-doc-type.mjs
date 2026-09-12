#!/usr/bin/env node
/**
 * Staging-only operator/preflight path for
 * 30_tenant_documents_mortgage_doc_type.sql.
 *
 * Not imported by completeAuth, writePlan, enableRls, or oneshot/index.mjs.
 * Never applies SQL 24 or SQL 29. No production default. Not wired to CI,
 * deploy, package scripts, Supabase Preview, or application startup.
 *
 * Modes: plan (default), preflight, apply, verify, rollback.
 * Plan never opens AWS or PostgreSQL.
 *
 * Apply requires:
 *   CHECKSOPS_EXPECTED_SQL_SHA=<sha256 of the apply SQL file>
 *   CHECKSOPS_OPERATOR_EXECUTE=1
 *   CHECKSOPS_SQL30_APPLY=I_UNDERSTAND_STAGING_TENANT_DOCUMENTS_DOC_TYPE
 *
 * Rollback requires the same execute flag plus
 *   CHECKSOPS_SQL30_ROLLBACK=I_UNDERSTAND_STAGING_TENANT_DOCUMENTS_DOC_TYPE_ROLLBACK
 * and aborts inside SQL if Mortgage Ops rows still exist.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SQL_DIR = path.resolve(ROOT, '../sql');
export const APPLY_SQL_NAME = '30_tenant_documents_mortgage_doc_type.sql';
export const ROLLBACK_SQL_NAME = '30_tenant_documents_mortgage_doc_type_rollback.sql';
export const APPLY_SQL_PATH = path.join(SQL_DIR, APPLY_SQL_NAME);
export const ROLLBACK_SQL_PATH = path.join(SQL_DIR, ROLLBACK_SQL_NAME);

export const APPLY_ACK = 'I_UNDERSTAND_STAGING_TENANT_DOCUMENTS_DOC_TYPE';
export const ROLLBACK_ACK = 'I_UNDERSTAND_STAGING_TENANT_DOCUMENTS_DOC_TYPE_ROLLBACK';

export const STAGING_GUARDS = Object.freeze({
  account: '806168576068',
  region: 'us-east-1',
  rdsIdentifier: 'checksops-staging',
  endpointHost: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
  database: 'checksops',
});

export const PREFLIGHT_SQL = `
SELECT json_build_object(
  'current_database', current_database(),
  'current_user', current_user,
  'table_exists', to_regclass('public.tenant_documents') IS NOT NULL,
  'doc_type', (
    SELECT json_build_object(
      'udt_name', c.udt_name,
      'is_nullable', c.is_nullable
    )
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'tenant_documents'
      AND c.column_name = 'doc_type'
  ),
  'constraint', (
    SELECT json_build_object(
      'name', c.conname,
      'definition_md5', md5(pg_get_constraintdef(c.oid)),
      'extracted_n', (
        SELECT count(*)::int
        FROM regexp_matches(pg_get_constraintdef(c.oid), $$'([^']+)'$$, 'g')
      )
    )
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tenant_documents'
      AND c.conname = 'tenant_documents_doc_type_check'
      AND c.contype = 'c'
  ),
  'invalid_for_target_n', (
    SELECT count(*)::bigint
    FROM public.tenant_documents
    WHERE doc_type IS NULL
       OR doc_type NOT IN (
         'w9', 'license', 'insurance', 'saas_agreement', 'terms_of_service', 'privacy_policy',
         'library:mortgage:w-9',
         'library:mortgage:contractor-license',
         'library:mortgage:general-liability-insurance',
         'library:mortgage:workers-comp-insurance',
         'library:mortgage:certificate-of-insurance',
         'library:mortgage:signed-contract',
         'library:mortgage:adjuster-tpa-letter'
       )
  ),
  'mortgage_ops_n', (
    SELECT count(*)::bigint
    FROM public.tenant_documents
    WHERE doc_type LIKE 'library:mortgage:%'
  )
) AS preflight
`;

export const VERIFY_SQL = `
SELECT json_build_object(
  'constraint_name', c.conname,
  'definition_md5', md5(pg_get_constraintdef(c.oid)),
  'extracted', (
    SELECT coalesce(array_agg(m[1] ORDER BY m[1]), ARRAY[]::text[])
    FROM regexp_matches(pg_get_constraintdef(c.oid), $$'([^']+)'$$, 'g') AS m
  )
) AS verify
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'tenant_documents'
  AND c.conname = 'tenant_documents_doc_type_check'
  AND c.contype = 'c'
`;

export const sha256File = (filePath) =>
  createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

export const applySqlSha256 = () => sha256File(APPLY_SQL_PATH);
export const rollbackSqlSha256 = () => sha256File(ROLLBACK_SQL_PATH);

const looksProduction = (value) =>
  /prod(?:uction)?|prod-|checksops-prod/i.test(String(value || ''));

export const evaluateGuards = ({ identity = {}, env = process.env } = {}) => {
  const account = String(identity.Account || env.CHECKSOPS_AWS_ACCOUNT || '');
  const region = String(identity.Region || env.AWS_REGION || env.AWS_DEFAULT_REGION || '');
  const host = String(env.RDS_HOST || env.CHECKSOPS_RDS_HOST || '');
  const identifier = String(env.CHECKSOPS_RDS_IDENTIFIER || '');
  const database = String(env.CHECKSOPS_DATABASE || env.PGDATABASE || '');
  const checks = {
    account: account === STAGING_GUARDS.account,
    region: region === STAGING_GUARDS.region,
    host: host === STAGING_GUARDS.endpointHost,
    identifier: identifier === STAGING_GUARDS.rdsIdentifier,
    database: database === STAGING_GUARDS.database,
    notProductionHost: !looksProduction(host) && host === STAGING_GUARDS.endpointHost,
    notProductionIdentifier: identifier === STAGING_GUARDS.rdsIdentifier,
    notProductionDatabase: database === STAGING_GUARDS.database && !looksProduction(database),
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    expected: STAGING_GUARDS,
  };
};

export const evaluateOperatorRequest = ({
  mode = 'plan',
  env = process.env,
  identity = {},
  expectedSha = env.CHECKSOPS_EXPECTED_SQL_SHA,
} = {}) => {
  const normalized = String(mode || 'plan').toLowerCase();
  const fileSha = applySqlSha256();
  const rollbackSha = rollbackSqlSha256();
  const shaOk = String(expectedSha || '').toLowerCase() === fileSha;
  const guards = evaluateGuards({ identity, env });
  const execute = String(env.CHECKSOPS_OPERATOR_EXECUTE || '') === '1';
  const applyAck = String(env.CHECKSOPS_SQL30_APPLY || '') === APPLY_ACK;
  const rollbackAck = String(env.CHECKSOPS_SQL30_ROLLBACK || '') === ROLLBACK_ACK;
  const mutating = normalized === 'apply' || normalized === 'rollback';
  const needsLive = normalized === 'preflight' || normalized === 'apply'
    || normalized === 'verify' || normalized === 'rollback';

  const refusals = [];
  if (!['plan', 'preflight', 'apply', 'verify', 'rollback'].includes(normalized)) {
    refusals.push('unknown_mode');
  }
  if (normalized !== 'plan' && !shaOk) {
    refusals.push('expected_sql_sha_mismatch');
  }
  if (needsLive && !guards.ok) {
    refusals.push('staging_guard_failed');
  }
  if (mutating && !execute) {
    refusals.push('execute_flag_required');
  }
  if (normalized === 'apply' && !applyAck) {
    refusals.push('apply_ack_required');
  }
  if (normalized === 'rollback' && !rollbackAck) {
    refusals.push('rollback_ack_required');
  }
  if (String(env.CHECKSOPS_SQL30_APPLY_PRODUCTION || '')) {
    refusals.push('production_token_rejected');
  }

  return {
    mode: normalized,
    operatorOnly: true,
    productionDefault: false,
    completeAuth: false,
    appliesSql24: false,
    appliesSql29: false,
    applySql: APPLY_SQL_NAME,
    rollbackSql: ROLLBACK_SQL_NAME,
    applySqlSha256: fileSha,
    rollbackSqlSha256: rollbackSha,
    expectedShaMatches: shaOk,
    guards,
    execute,
    needsLive,
    mutating,
    ok: refusals.length === 0,
    refusals,
  };
};

export const TARGET_DOC_TYPES = Object.freeze([
  'insurance',
  'library:mortgage:adjuster-tpa-letter',
  'library:mortgage:certificate-of-insurance',
  'library:mortgage:contractor-license',
  'library:mortgage:general-liability-insurance',
  'library:mortgage:signed-contract',
  'library:mortgage:w-9',
  'library:mortgage:workers-comp-insurance',
  'license',
  'privacy_policy',
  'saas_agreement',
  'terms_of_service',
  'w9',
]);

export const PREDECESSOR_DOC_TYPES = Object.freeze([
  'insurance',
  'license',
  'privacy_policy',
  'saas_agreement',
  'terms_of_service',
  'w9',
]);

const noticesFromResult = (result) =>
  (result?.notices || []).map((item) => String(item?.message || item || ''));

export const runOperator = async ({
  mode = 'plan',
  env = process.env,
  identity = {},
  expectedSha = env.CHECKSOPS_EXPECTED_SQL_SHA,
  query,
} = {}) => {
  const request = evaluateOperatorRequest({ mode, env, identity, expectedSha });
  if (request.mode === 'plan') {
    return { ...request, connected: false, applied: false };
  }
  if (!request.ok) {
    return { ...request, connected: false, applied: false, ok: false };
  }
  if (typeof query !== 'function') {
    return {
      ...request,
      connected: false,
      applied: false,
      ok: false,
      refusals: [...request.refusals, 'query_fn_required_in_this_process'],
    };
  }

  if (request.mode === 'preflight') {
    const preflight = (await query(PREFLIGHT_SQL)).rows[0]?.preflight;
    return {
      ...request,
      connected: true,
      applied: false,
      preflight,
      ok: true,
      readOnly: true,
    };
  }

  if (request.mode === 'verify') {
    const verify = (await query(VERIFY_SQL)).rows[0]?.verify;
    const extracted = [...(verify?.extracted || [])].sort();
    const current = extracted.join('\0') === TARGET_DOC_TYPES.join('\0');
    return {
      ...request,
      connected: true,
      applied: false,
      verify,
      alreadyCurrent: current,
      ok: current,
    };
  }

  if (request.mode === 'apply') {
    const captured = (await query(VERIFY_SQL)).rows[0]?.verify;
    const sql = fs.readFileSync(APPLY_SQL_PATH, 'utf8');
    const applied = await query(sql);
    const verify = (await query(VERIFY_SQL)).rows[0]?.verify;
    const notices = noticesFromResult(applied);
    const alreadyCurrent = notices.some((line) => /sql30_already_current/.test(line));
    const extracted = [...(verify?.extracted || [])].sort();
    const current = extracted.join('\0') === TARGET_DOC_TYPES.join('\0');
    return {
      ...request,
      connected: true,
      applied: true,
      capturedPredecessor: captured,
      notices,
      verify,
      alreadyCurrent,
      ok: current,
    };
  }

  const captured = (await query(VERIFY_SQL)).rows[0]?.verify;
  const sql = fs.readFileSync(ROLLBACK_SQL_PATH, 'utf8');
  const applied = await query(sql);
  const verify = (await query(VERIFY_SQL)).rows[0]?.verify;
  const notices = noticesFromResult(applied);
  const extracted = [...(verify?.extracted || [])].sort();
  const predecessor = extracted.join('\0') === PREDECESSOR_DOC_TYPES.join('\0');
  return {
    ...request,
    connected: true,
    applied: true,
    capturedRollbackFrom: captured,
    notices,
    verify,
    alreadyPredecessor: notices.some((line) => /sql30_rollback_already_predecessor/.test(line)),
    ok: predecessor,
  };
};

/**
 * Optional staging RDS connect. Not used unless the caller passes the live
 * connect flag after staging guards and expected SHA already passed.
 * This module is not a Lambda handler and is not imported by oneshot/index.
 */
export const connectStagingClient = async ({ env = process.env, identity = {} } = {}) => {
  const request = evaluateOperatorRequest({ mode: 'preflight', env, identity });
  if (!request.ok) {
    throw new Error(`sql30_connect_refused:${request.refusals.join(',')}`);
  }
  if (String(env.CHECKSOPS_SQL30_ALLOW_LIVE_CONNECT || '') !== '1') {
    throw new Error('sql30_connect_refused:live_connect_flag_required');
  }
  const [{ Client }, { SecretsManagerClient, GetSecretValueCommand }] = await Promise.all([
    import('pg'),
    import('@aws-sdk/client-secrets-manager'),
  ]);
  const arn = env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn) || !/checksops-staging/i.test(arn)) {
    throw new Error('sql30_connect_refused:admin_secret_not_staging');
  }
  const sm = new SecretsManagerClient({ region: STAGING_GUARDS.region });
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  const host = parsed.host && parsed.host !== 'localhost' && parsed.host !== '127.0.0.1'
    ? parsed.host
    : env.RDS_HOST;
  if (host !== STAGING_GUARDS.endpointHost) {
    throw new Error('sql30_connect_refused:host_mismatch');
  }
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('sql30_connect_refused:username');
  }
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: STAGING_GUARDS.database,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 8000,
    query_timeout: 30000,
  });
  await client.connect();
  const db = (await client.query('SELECT current_database() AS d')).rows[0];
  if (db.d !== STAGING_GUARDS.database) {
    await client.end();
    throw new Error(`sql30_connect_refused:database_${db.d}`);
  }
  return client;
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const mode = process.argv[2] || process.env.CHECKSOPS_SQL30_MODE || 'plan';
  const request = evaluateOperatorRequest({ mode, env: process.env });
  let result = await runOperator({ mode, env: process.env });
  if (request.needsLive && request.ok && String(process.env.CHECKSOPS_SQL30_ALLOW_LIVE_CONNECT || '') === '1') {
    const client = await connectStagingClient({ env: process.env });
    try {
      const notices = [];
      client.on('notice', (msg) => notices.push({ message: msg.message || String(msg) }));
      result = await runOperator({
        mode,
        env: process.env,
        query: async (sql) => {
          const queryResult = await client.query(sql);
          queryResult.notices = notices.splice(0, notices.length);
          return queryResult;
        },
      });
    } finally {
      await client.end();
    }
  }
  console.log(JSON.stringify({
    package: '30_tenant_documents_mortgage_doc_type',
    unappliedAwsOperatorPackage: true,
    productionDefault: false,
    completeAuth: false,
    appliesSql24: false,
    appliesSql29: false,
    connected: result.connected === true,
    applied: result.applied === true,
    mode: result.mode,
    ok: result.ok,
    refusals: result.refusals,
    applySqlSha256: result.applySqlSha256,
    rollbackSqlSha256: result.rollbackSqlSha256,
    expectedShaMatches: result.expectedShaMatches,
    guards: result.guards,
  }, null, 2));
  process.exit(result.mode === 'plan' || !result.ok ? 2 : 0);
}
