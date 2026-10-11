import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { evaluateDeployment } from '../../scripts/deployment-guard/lib/guard.mjs';
import { passingContractResults, loadContractRegistry } from '../../scripts/deployment-guard/lib/contracts.mjs';
import { hashSqlDefinition } from '../../scripts/deployment-guard/lib/sql-apply.mjs';
import { AUTHORIZED_SQL53, evaluateSqlExecutorAuthorization } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { evaluateSql53StagingApply } from '../../scripts/deployment-guard/lib/sql53-staging-apply.mjs';
import { evaluateSql53ProductionFunctionRepair } from '../../scripts/deployment-guard/lib/sql53-production-function-repair.mjs';
import {
  SQL53_PRODUCTION_APPLY_DEPLOYMENT_TYPE,
  SQL53_PRODUCTION_APPLY_PHRASE,
  createProductionDatabaseConnect,
  credentialsToProductionDatabaseUrl,
  evaluateSql53ProductionApply,
  evaluateSql53ProductionCatalog,
  evaluateSql53TrustedRunner,
  executeSql53ProductionApply,
  inspectSql53ProductionCatalog,
  isProductionAdminSecretArn,
  loadSql53ProductionApplyPin,
  resolveProductionDatabaseAccess,
  resolveProductionDatabaseUrl,
  sql53ContainsForbiddenMutation,
} from '../../scripts/deployment-guard/lib/sql53-production-apply.mjs';
import { main as productionApplyMain } from '../../scripts/deployment-guard/sql53-production-apply.mjs';
import {
  evaluateGithubSql53ProductionApply,
  githubSql53Identity,
} from '../../scripts/deployment-guard/github-sql53-production-apply.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = loadSql53ProductionApplyPin(ROOT);
const PG_BIN = '/usr/lib/postgresql/16/bin';
const SQL_PATH = path.join(ROOT, PIN.filename);
const ABSENT = PIN.absent_live_definition_sha256;

const fingerprint = {
  sql: ABSENT,
  filename: PIN.filename,
  migration_id: PIN.migration_id,
};

function productionInput(overrides = {}) {
  return {
    workstream_id: 'prod-sql53-production-executor-3bc9',
    branch: 'cursor/prod-sql53-production-executor-3bc9',
    commit: 'c80398ba871e3cbb638cfe83c94ec5e6a03547e9',
    operator: 'test-agent',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: SQL53_PRODUCTION_APPLY_DEPLOYMENT_TYPE,
    owned_components: [PIN.filename],
    filename: PIN.filename,
    migration_id: PIN.migration_id,
    source_sha256: PIN.source_sha256,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: { ok: true, reference: 'sql53-isolated-pg' },
    approval: { approved: true, workstream_id: 'prod-sql53-production-executor-3bc9' },
    build_timestamp: '2026-10-11T10:00:00.000Z',
    authorization_phrase: SQL53_PRODUCTION_APPLY_PHRASE,
    one_use_id: overrides.one_use_id || `sql53-prod-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ...overrides,
  };
}

function catalog({
  exists = false,
  settlementHash = null,
  preserved = PIN.preserved_function_definition_sha256,
} = {}) {
  return {
    functions: [
      {
        identity: PIN.function_identity,
        exists,
        definitionSha256: exists ? settlementHash : null,
      },
      ...Object.entries(preserved).map(([identity, definitionSha256]) => ({
        identity,
        exists: true,
        definitionSha256,
      })),
    ],
    settlementColumns: PIN.preserved_settlement_columns.map((column) => ({
      table: 'claim_settlements',
      column,
      exists: true,
    })),
    ledgerTriggers: PIN.preserved_ledger_triggers.map((trigger) => ({
      table: 'check_intake_items',
      trigger,
      exists: true,
    })),
  };
}

test('production apply pin reuses the approved SQL 53 file and is execute-authorized', () => {
  assert.equal(PIN.authorization, 'execute-authorized');
  assert.equal(PIN.apply_authorized, true);
  assert.equal(PIN.execute, true);
  assert.equal(PIN.deployment_type, SQL53_PRODUCTION_APPLY_DEPLOYMENT_TYPE);
  assert.equal(PIN.source_sha256, '5a8f8bc35c69f2b339c78f3637d6bb1c606117967e3ab9d83b5dec1d37561197');
  assert.equal(hashSqlDefinition.length > 0, true);
  assert.equal(fs.existsSync(SQL_PATH), true);
  assert.equal(createHash('sha256').update(fs.readFileSync(SQL_PATH)).digest('hex'), PIN.source_sha256);
  assert.equal(sql53ContainsForbiddenMutation(fs.readFileSync(SQL_PATH, 'utf8')), null);
  const applySrc = fs.readFileSync(path.join(ROOT, 'scripts/deployment-guard/lib/sql53-production-apply.mjs'), 'utf8');
  assert.doesNotMatch(applySrc, /from ['"]pg['"]/);
  assert.doesNotMatch(applySrc, /from ['"][^'"]*sql53-production-readonly-inspect\.mjs['"]/);
});

test('staging paths still refuse production and the repair pin stays evaluate-only', () => {
  const staging = evaluateSql53StagingApply({
    target_environment: 'production',
    filename: PIN.filename,
    apply: false,
  }, { root: ROOT });
  assert.equal(staging.ok, false);
  assert.equal(staging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const executor = evaluateSqlExecutorAuthorization({
    target_environment: 'production',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    function_name: 'checksops-staging-guarded-sql-executor',
    filename: PIN.filename,
    migration_id: PIN.migration_id,
    source_sha256: PIN.source_sha256,
    intended_replacement_sha256: PIN.intended_replacement_sha256,
    commit: AUTHORIZED_SQL53.commit,
  });
  assert.equal(executor.ok, false);
  assert.equal(executor.code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const repair = evaluateSql53ProductionFunctionRepair({
    target_environment: 'production',
    filename: PIN.filename,
    apply: true,
  }, { root: ROOT });
  assert.equal(repair.ok, false);
  assert.equal(repair.code, CODES.GUARD_APPLY_FORBIDDEN);
});

test('evaluateSql53ProductionApply accepts a complete production package when the pin is execute-authorized', () => {
  const ready = evaluateSql53ProductionApply(productionInput({
    inspect: catalog(),
  }), { root: ROOT });
  assert.equal(ready.ok, true, ready.message);
  assert.equal(ready.details.sql53_production_executor_ready, true);
  assert.equal(ready.details.apply_authorized, true);
  assert.equal(ready.details.execute, true);
  assert.equal(ready.details.independent_execute_authorization_required, false);

  const apply = evaluateSql53ProductionApply(productionInput({
    action: 'apply',
    execute: true,
    inspect: catalog(),
    authorization_phrase: SQL53_PRODUCTION_APPLY_PHRASE,
  }), { root: ROOT });
  assert.equal(apply.ok, true, apply.message);
  assert.equal(apply.details.execute, true);
  assert.equal(apply.details.apply_executed, false);

  const exists = evaluateSql53ProductionCatalog(catalog({
    exists: true,
    settlementHash: PIN.intended_definition_sha256,
  }), PIN);
  assert.equal(exists.ok, false);
  assert.equal(exists.code, CODES.UNRELATED_MUTATION);

  const drift = evaluateSql53ProductionCatalog(catalog({
    preserved: {
      ...PIN.preserved_function_definition_sha256,
      'public.aws_can_write_claim(uuid)': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  }), PIN);
  assert.equal(drift.ok, false);
  assert.equal(drift.code, CODES.SQL_COLLISION);
});

test('evaluateDeployment routes sql53-production-apply without weakening sql-apply', () => {
  const registry = loadContractRegistry(ROOT);
  const routed = evaluateDeployment(productionInput({
    inspect: catalog(),
    contract_results: passingContractResults(registry),
  }), { root: ROOT, skip_contracts: false });
  assert.equal(routed.ok, true, routed.message);
  assert.equal(routed.details.evaluation.deployment_type, SQL53_PRODUCTION_APPLY_DEPLOYMENT_TYPE);

  const stagingSqlApply = evaluateDeployment({
    ...productionInput(),
    deployment_type: 'sql-apply',
    target_component: 'staging-sql',
    contract_results: passingContractResults(registry),
  }, { root: ROOT, skip_contracts: true });
  assert.equal(stagingSqlApply.ok, false);
  assert.equal(stagingSqlApply.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
});

test('CLI evaluate-only succeeds and unguarded apply fails closed', async () => {
  const inputFile = path.join(os.tmpdir(), `sql53-prod-eval-${process.pid}.json`);
  fs.writeFileSync(inputFile, `${JSON.stringify(productionInput({ inspect: catalog() }), null, 2)}\n`);
  const code = await productionApplyMain(['--input', inputFile], {}, { root: ROOT });
  assert.equal(code, 0);

  const unguarded = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/sql53-production-apply.mjs'),
    '--apply',
    '--input',
    inputFile,
  ], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: os.tmpdir() },
  });
  assert.equal(unguarded.status, 2);
  assert.match(unguarded.stderr, /DEPLOYMENT_GUARD_REQUIRED/);
});

test('resolveProductionDatabaseUrl refuses missing, staging, and non-RDS hosts', () => {
  const missing = resolveProductionDatabaseUrl({}, { harness: false });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.GUARD_APPLY_FORBIDDEN);

  const staging = resolveProductionDatabaseUrl({
    CHECKSOPS_SQL53_PRODUCTION_DATABASE_URL: 'postgres://checksops@checksops-staging.c1.us-east-1.rds.amazonaws.com:5432/checksops',
  });
  assert.equal(staging.ok, false);
  assert.equal(staging.code, CODES.UNRELATED_MUTATION);

  const okUrl = resolveProductionDatabaseUrl({
    CHECKSOPS_SQL53_PRODUCTION_DATABASE_URL: 'postgres://checksops@checksops-production.c1.us-east-1.rds.amazonaws.com:5432/checksops',
  });
  assert.equal(okUrl.ok, true, okUrl.message);
  assert.equal(typeof createProductionDatabaseConnect(okUrl.details.url), 'function');
  assert.equal(createProductionDatabaseConnect(''), undefined);
});

const ADMIN_ARN = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops_admin/1790081257144';
const APP_ARN = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops/1790081257144-A2Z4bw';
const ADMIN_HOST = 'checksops-production.c1.us-east-1.rds.amazonaws.com';

test('admin secret resolver accepts only the existing production checksops_admin secret', async () => {
  assert.equal(isProductionAdminSecretArn(ADMIN_ARN), true);
  assert.equal(isProductionAdminSecretArn(APP_ARN), false);
  const admin = credentialsToProductionDatabaseUrl({
    username: 'checksops_admin',
    password: 'unused-test-password',
    host: ADMIN_HOST,
    port: 5432,
    dbname: 'checksops',
  });
  assert.equal(admin.ok, true, admin.message);
  assert.equal(admin.details.source, 'admin-secret');
  assert.match(admin.details.url, /^postgresql:\/\//);
  assert.equal(admin.details.host, ADMIN_HOST);

  const appUser = credentialsToProductionDatabaseUrl({
    username: 'checksops',
    password: 'unused-test-password',
    host: ADMIN_HOST,
    port: 5432,
    dbname: 'checksops',
  });
  assert.equal(appUser.ok, false);
  assert.equal(appUser.code, CODES.UNRELATED_MUTATION);

  const fromSecret = await resolveProductionDatabaseAccess({
    CHECKSOPS_SQL53_PRODUCTION_ADMIN_SECRET_ARN: ADMIN_ARN,
  }, {
    getSecretValue: async () => JSON.stringify({
      username: 'checksops_admin',
      password: 'unused-test-password',
      host: ADMIN_HOST,
      port: 5432,
      dbname: 'checksops',
    }),
  });
  assert.equal(fromSecret.ok, true, fromSecret.message);
  assert.equal(fromSecret.details.host, ADMIN_HOST);

  const refusedAppArn = await resolveProductionDatabaseAccess({
    CHECKSOPS_SQL53_PRODUCTION_ADMIN_SECRET_ARN: APP_ARN,
  }, { getSecretValue: async () => '{"username":"checksops"}' });
  assert.equal(refusedAppArn.ok, false);
  assert.equal(refusedAppArn.code, CODES.UNRELATED_MUTATION);
});

test('trusted runner and GitHub evaluate stay off Lambda and do not apply', () => {
  const runner = evaluateSql53TrustedRunner({}, { root: ROOT });
  assert.equal(runner.ok, true, runner.message);
  assert.equal(runner.details.github_can_apply, false);
  assert.equal(runner.details.lambda_executor_forbidden, true);
  assert.equal(runner.details.issuer_key_stays_off_lambda, true);
  assert.equal(runner.details.pin_execute, true);
  assert.equal(runner.details.pin_apply_authorized, true);
  assert.equal(runner.details.independent_execute_authorization_required, false);

  const github = evaluateGithubSql53ProductionApply({
    GITHUB_SHA: '0e586b8510d2c509586d67648818f8848d24a84f',
    GITHUB_REF_NAME: 'main',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'test-operator',
    GITHUB_RUN_ID: '12345',
    CHECKSOPS_SQL53_GITHUB_MODE: 'evaluate',
  }, { root: ROOT });
  assert.equal(github.ok, true, github.message);
  assert.equal(github.details.sql_not_executed, true);

  const applyMode = evaluateGithubSql53ProductionApply({
    GITHUB_SHA: '0e586b8510d2c509586d67648818f8848d24a84f',
    GITHUB_REF_NAME: 'main',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'test-operator',
    GITHUB_RUN_ID: '12345',
    CHECKSOPS_SQL53_GITHUB_MODE: 'apply',
  }, { root: ROOT });
  assert.equal(applyMode.ok, false);
  assert.equal(applyMode.code, CODES.GUARD_APPLY_FORBIDDEN);

  const lambda = evaluateGithubSql53ProductionApply({
    GITHUB_SHA: '0e586b8510d2c509586d67648818f8848d24a84f',
    GITHUB_REF_NAME: 'main',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'test-operator',
    GITHUB_RUN_ID: '12345',
    CHECKSOPS_SQL53_FUNCTION_NAME: 'checksops-production-prep-api',
  }, { root: ROOT });
  assert.equal(lambda.ok, false);
  assert.equal(lambda.code, CODES.UNRELATED_MUTATION);

  const identity = githubSql53Identity({
    GITHUB_SHA: '0e586b8510d2c509586d67648818f8848d24a84f',
    GITHUB_REF_NAME: 'feature',
    GITHUB_REF: 'refs/heads/feature',
    GITHUB_ACTOR: 'test-operator',
    GITHUB_RUN_ID: '12345',
  });
  assert.equal(identity.ok, false);
});

test('official CLI apply builds a production connect factory from the validated URL', async () => {
  const inputFile = path.join(os.tmpdir(), `sql53-prod-connect-${process.pid}.json`);
  fs.writeFileSync(inputFile, `${JSON.stringify(productionInput({ inspect: catalog() }), null, 2)}\n`);
  let captured;
  const code = await productionApplyMain(['--apply', '--input', inputFile], {
    CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1',
    CHECKSOPS_SQL53_PRODUCTION_DATABASE_URL: 'postgres://checksops@checksops-production.c1.us-east-1.rds.amazonaws.com:5432/checksops',
  }, {
    root: ROOT,
    pin: { ...PIN, execute: true },
    enforceScriptGuard: () => ({ ok: true }),
    execute: async (_input, ctx) => {
      captured = ctx;
      return { ok: true, details: { apply_executed: false } };
    },
  });
  assert.equal(code, 0);
  assert.equal(typeof captured.connect, 'function');
  assert.match(String(captured.databaseUrl || ''), /checksops-production/);
});

test('official CLI apply can build a connect factory from the existing admin secret', async () => {
  const inputFile = path.join(os.tmpdir(), `sql53-prod-secret-${process.pid}.json`);
  fs.writeFileSync(inputFile, `${JSON.stringify(productionInput({ inspect: catalog() }), null, 2)}\n`);
  let captured;
  let consumed = 0;
  const code = await productionApplyMain(['--apply', '--input', inputFile], {
    CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1',
    CHECKSOPS_SQL53_PRODUCTION_ADMIN_SECRET_ARN: ADMIN_ARN,
  }, {
    root: ROOT,
    pin: { ...PIN, execute: true },
    enforceScriptGuard: () => ({
      ok: true,
      details: { receipt: { mac: 'a'.repeat(64), workstream_id: 'prod-sql53-production-executor-3bc9' } },
    }),
    consumeReceiptOnce: () => {
      consumed += 1;
      return { ok: true, details: { consumed: true } };
    },
    getSecretValue: async () => JSON.stringify({
      username: 'checksops_admin',
      password: 'unused-test-password',
      host: ADMIN_HOST,
      port: 5432,
      dbname: 'checksops',
    }),
    execute: async (_input, ctx) => {
      captured = ctx;
      return { ok: true, details: { apply_executed: false } };
    },
  });
  assert.equal(code, 0);
  assert.equal(consumed, 1);
  assert.equal(typeof captured.connect, 'function');
  assert.match(String(captured.databaseUrl || ''), /checksops-production/);
});

test('official CLI apply does not consume a receipt when local apply gates refuse', async () => {
  const receipt = { mac: 'b'.repeat(64), workstream_id: 'prod-sql53-production-executor-3bc9' };
  const run = async (overrides = {}, pin = PIN) => {
    const inputFile = path.join(os.tmpdir(), `sql53-prod-gate-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(inputFile, `${JSON.stringify(productionInput({
      inspect: catalog(),
      ...overrides,
    }), null, 2)}\n`);
    let consumed = 0;
    let stderr = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk, ...args) => {
      stderr += String(chunk);
      return originalWrite.call(process.stderr, chunk, ...args);
    };
    let code;
    try {
      code = await productionApplyMain(['--apply', '--input', inputFile], {
        CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1',
      }, {
        root: ROOT,
        pin,
        enforceScriptGuard: () => ({ ok: true, details: { receipt } }),
        consumeReceiptOnce: () => {
          consumed += 1;
          return { ok: true, details: { consumed: true } };
        },
        execute: async () => ({ ok: true, details: { apply_executed: false } }),
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    return { code, consumed, stderr };
  };

  const executeFalse = await run({}, { ...PIN, execute: false });
  assert.equal(executeFalse.code, 1);
  assert.equal(executeFalse.consumed, 0);
  assert.match(executeFalse.stderr, /GUARD_APPLY_FORBIDDEN/);

  const missingPhrase = await run({ authorization_phrase: 'WRONG_PHRASE' }, { ...PIN, execute: true });
  assert.equal(missingPhrase.code, 1);
  assert.equal(missingPhrase.consumed, 0);
  assert.match(missingPhrase.stderr, /PRODUCTION_APPROVAL_REQUIRED/);

  const missingOneUse = await run({ one_use_id: '' }, { ...PIN, execute: true });
  assert.equal(missingOneUse.code, 1);
  assert.equal(missingOneUse.consumed, 0);
  assert.match(missingOneUse.stderr, /INVALID_MANIFEST/);
});

test('isolated PostgreSQL production apply path creates only the settlement function', {
  timeout: 180000,
}, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }
  let Client;
  try {
    ({ Client } = (await import('pg')).default);
  } catch {
    t.skip('pg module is not installed');
    return;
  }

  const run = (bin, args, opts = {}) => spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...opts,
  });
  const mustRun = (bin, args, opts = {}) => {
    const result = run(bin, args, opts);
    if (result.status !== 0) {
      throw new Error(`${bin} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return result;
  };

  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sql53-prod-apply-'));
  const port = 57800 + (process.pid % 1000);
  const logPath = path.join(pgData, 'pg.log');
  mustRun(path.join(PG_BIN, 'initdb'), [
    '-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8',
  ]);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `
listen_addresses = ''
port = ${port}
unix_socket_directories = '${pgData}'
logging_collector = off
shared_buffers = 32MB
max_connections = 20
`);
  const started = run(path.join(PG_BIN, 'pg_ctl'), [
    '-D', pgData, '-l', logPath, '-w', '-t', '30', 'start',
  ]);
  if (started.status !== 0) {
    throw new Error(`pg_ctl start failed: ${started.stderr || fs.readFileSync(logPath, 'utf8')}`);
  }

  const psql = (sql) => String(mustRun(path.join(PG_BIN, 'psql'), [
    '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql,
  ]).stdout || '').trim();

  const connect = async () => {
    const client = new Client({
      host: pgData,
      port,
      user: 'ubuntu',
      database: 'postgres',
    });
    await client.connect();
    return client;
  };

  try {
    psql(`
      CREATE ROLE checksops NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE anon NOLOGIN;
      CREATE SCHEMA auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.app_user_id', true), '')::uuid
      $$;
      CREATE TABLE public.tenant_users (user_id uuid NOT NULL, tenant_id uuid NOT NULL);
      CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
      CREATE TABLE public.claims (id uuid PRIMARY KEY, org_id uuid NOT NULL);
      CREATE TABLE public.claim_settlements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        claim_id uuid NOT NULL REFERENCES public.claims(id),
        replacement_cost_value numeric(12,2) NOT NULL DEFAULT 0,
        non_recoverable_depreciation numeric(12,2) NOT NULL DEFAULT 0,
        recoverable_depreciation numeric(12,2) NOT NULL DEFAULT 0,
        deductible numeric(12,2) NOT NULL DEFAULT 0,
        other_structures_rcv numeric DEFAULT 0,
        other_structures_recoverable_depreciation numeric DEFAULT 0,
        other_structures_non_recoverable_depreciation numeric DEFAULT 0,
        other_structures_deductible numeric DEFAULT 0,
        pwi_rcv numeric DEFAULT 0,
        pwi_recoverable_depreciation numeric DEFAULT 0,
        pwi_non_recoverable_depreciation numeric DEFAULT 0,
        personal_property_rcv numeric DEFAULT 0,
        personal_property_recoverable_depreciation numeric DEFAULT 0,
        personal_property_non_recoverable_depreciation numeric DEFAULT 0,
        ale_rcv numeric DEFAULT 0,
        ale_recoverable_depreciation numeric DEFAULT 0,
        ale_non_recoverable_depreciation numeric DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by uuid
      );
      CREATE OR REPLACE FUNCTION public.aws_can_write_claim(_claim_id uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.claims c
          JOIN public.tenant_users tu ON tu.tenant_id = c.org_id AND tu.user_id = auth.uid()
          WHERE c.id = _claim_id
        )
      $$;
      CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.homeowner_ledger_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text NOT NULL);
      CREATE TABLE public.claim_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount numeric NOT NULL DEFAULT 0);
      CREATE TABLE public.claim_check_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.payment_wallet_ledger (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.payment_transfers (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE OR REPLACE FUNCTION public.sync_homeowner_ledger_from_check()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO public.homeowner_ledger_events(note) VALUES ('sync');
        RETURN NEW;
      END
      $$;
      CREATE OR REPLACE FUNCTION public.hle_on_check_intake_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO public.homeowner_ledger_events(note) VALUES ('hle');
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER trg_sync_homeowner_ledger_ins
        AFTER INSERT ON public.check_intake_items
        FOR EACH ROW EXECUTE FUNCTION public.sync_homeowner_ledger_from_check();
      CREATE TRIGGER trg_sync_homeowner_ledger_upd
        AFTER UPDATE ON public.check_intake_items
        FOR EACH ROW EXECUTE FUNCTION public.sync_homeowner_ledger_from_check();
      CREATE TRIGGER trg_hle_check_intake_insert
        AFTER INSERT ON public.check_intake_items
        FOR EACH ROW EXECUTE FUNCTION public.hle_on_check_intake_insert();
      INSERT INTO public.claim_payments(amount) VALUES (12.34);
    `);

    const probe = await connect();
    const before = await inspectSql53ProductionCatalog(probe);
    await probe.end();
    assert.equal(before.ok, true, before.message);
    const missing = before.details.functions.find((row) => row.identity === PIN.function_identity);
    assert.equal(missing.exists, false);
    const synthetic = Object.fromEntries(
      before.details.functions
        .filter((row) => row.identity !== PIN.function_identity)
        .map((row) => [row.identity, row.definitionSha256]),
    );

    const consumedPath = path.join(pgData, 'consumed.json');
    const applied = await executeSql53ProductionApply(productionInput({
      harness: true,
      synthetic_baseline: synthetic,
      authorization_phrase: SQL53_PRODUCTION_APPLY_PHRASE,
    }), { root: ROOT, connect, consumedPath });
    assert.equal(applied.ok, true, applied.message);
    assert.equal(applied.details.after_hash, PIN.intended_definition_sha256);
    assert.deepEqual(applied.details.preserved_row_counts, {
      claim_settlements: 0,
      check_intake_items: 0,
      homeowner_ledger_events: 0,
      claim_payments: 1,
      claim_check_payments: 0,
      payment_wallet_ledger: 0,
      payment_transfers: 0,
    });

    assert.equal(psql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'save_claim_settlement_breakdown'`), '1');
    assert.equal(psql(`SELECT count(*) FROM public.claim_payments`), '1');
    assert.equal(psql(`SELECT count(*) FROM public.homeowner_ledger_events`), '0');
    assert.equal(psql(`SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_sync_homeowner_ledger_ins','trg_sync_homeowner_ledger_upd','trg_hle_check_intake_insert') AND NOT tgisinternal`), '3');

    const replay = await executeSql53ProductionApply(productionInput({
      harness: true,
      synthetic_baseline: synthetic,
      authorization_phrase: SQL53_PRODUCTION_APPLY_PHRASE,
    }), { root: ROOT, connect, consumedPath });
    assert.equal(replay.ok, false);
    assert.ok([CODES.UNRELATED_MUTATION, CODES.SQL_COLLISION].includes(replay.code));

    // A missing required preserved table fails closed before any write.
    psql(`
      DROP FUNCTION public.save_claim_settlement_breakdown(uuid, uuid, jsonb);
      ALTER TABLE public.homeowner_ledger_events RENAME TO homeowner_ledger_events_moved;
    `);
    const missingRequired = await executeSql53ProductionApply(productionInput({
      harness: true,
      synthetic_baseline: synthetic,
      authorization_phrase: SQL53_PRODUCTION_APPLY_PHRASE,
    }), { root: ROOT, connect, consumedPath: path.join(pgData, 'consumed-missing-required.json') });
    assert.equal(missingRequired.ok, false);
    assert.equal(missingRequired.code, CODES.SQL_COLLISION);
    assert.deepEqual(missingRequired.details.missing, ['public.homeowner_ledger_events']);
    assert.equal(psql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'save_claim_settlement_breakdown'`), '0');
  } finally {
    run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(pgData, { recursive: true, force: true });
  }
});
