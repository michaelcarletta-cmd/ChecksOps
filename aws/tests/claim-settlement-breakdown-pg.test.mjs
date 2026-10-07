import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const SQL_PATH = path.join(ROOT, 'aws/workflows/sql/53_claim_settlement_breakdown.sql');
const USER_A = 'a1000000-0000-4000-8000-000000000001';
const USER_B = 'b1000000-0000-4000-8000-000000000002';
const USER_C = 'c1000000-0000-4000-8000-000000000003';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const run = (bin, args, opts = {}) => spawnSync(bin, args, {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  ...opts,
});

const mustRun = (bin, args, opts = {}) => {
  const result = run(bin, args, opts);
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
};

test('isolated PostgreSQL settlement RPC inserts, updates, deduplicates, and denies cross-tenant access', {
  timeout: 180000,
}, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }

  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-claim-settlement-'));
  const port = 56800 + (process.pid % 1000);
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
  const psql = (sql) => {
    const result = mustRun(path.join(PG_BIN, 'psql'), [
      '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql,
    ]);
    return String(result.stdout || '').trim();
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
      CREATE TABLE public.claims (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.claim_settlements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        claim_id uuid NOT NULL REFERENCES public.claims(id),
        replacement_cost_value numeric(12,2) NOT NULL DEFAULT 0,
        non_recoverable_depreciation numeric(12,2) NOT NULL DEFAULT 0,
        recoverable_depreciation numeric(12,2) NOT NULL DEFAULT 0,
        deductible numeric(12,2) NOT NULL DEFAULT 0,
        total_settlement numeric(12,2) GENERATED ALWAYS AS (
          replacement_cost_value - non_recoverable_depreciation - deductible
        ) STORED,
        other_structures_rcv numeric DEFAULT 0,
        other_structures_recoverable_depreciation numeric DEFAULT 0,
        other_structures_non_recoverable_depreciation numeric DEFAULT 0,
        other_structures_deductible numeric DEFAULT 0,
        pwi_rcv numeric DEFAULT 0,
        pwi_recoverable_depreciation numeric DEFAULT 0,
        pwi_non_recoverable_depreciation numeric DEFAULT 0,
        pwi_deductible numeric DEFAULT 0,
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
          JOIN public.user_roles ur ON ur.user_id = auth.uid() AND ur.role IN ('admin', 'staff')
          WHERE c.id = _claim_id
        )
      $$;
      CREATE OR REPLACE FUNCTION public.touch_claim_updated_at()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        UPDATE public.claims SET updated_at = now() WHERE id = NEW.claim_id;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER touch_claim_on_settlement
        AFTER INSERT OR UPDATE ON public.claim_settlements
        FOR EACH ROW EXECUTE FUNCTION public.touch_claim_updated_at();
      INSERT INTO public.claims (id, org_id) VALUES
        ('${CLAIM_A}', '${TENANT_A}'),
        ('${CLAIM_B}', '${TENANT_B}');
      INSERT INTO public.tenant_users (user_id, tenant_id) VALUES
        ('${USER_A}', '${TENANT_A}'),
        ('${USER_B}', '${TENANT_B}'),
        ('${USER_C}', '${TENANT_A}');
      INSERT INTO public.user_roles (user_id, role) VALUES
        ('${USER_A}', 'staff'),
        ('${USER_B}', 'staff');
      GRANT USAGE ON SCHEMA public, auth TO checksops;
      GRANT EXECUTE ON FUNCTION auth.uid() TO checksops;
    `);
    mustRun(path.join(PG_BIN, 'psql'), [
      '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-f', SQL_PATH,
    ]);
    assert.equal(psql(`SELECT has_function_privilege('checksops', 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)', 'EXECUTE')`), 't');
    assert.equal(psql(`SELECT has_function_privilege('authenticated', 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)', 'EXECUTE')`), 'f');
    assert.equal(psql(`SELECT has_function_privilege('anon', 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)', 'EXECUTE')`), 'f');

    const values = JSON.stringify({
      replacement_cost_value: 15000,
      recoverable_depreciation: 500,
      non_recoverable_depreciation: 1000,
      deductible: 1500,
      other_structures_rcv: 400,
      other_structures_recoverable_depreciation: 10,
      other_structures_non_recoverable_depreciation: 20,
      other_structures_deductible: 30,
      pwi_rcv: 300,
      pwi_recoverable_depreciation: 10,
      pwi_non_recoverable_depreciation: 20,
      personal_property_rcv: 200,
      personal_property_recoverable_depreciation: 10,
      personal_property_non_recoverable_depreciation: 20,
      ale_rcv: 100,
      ale_recoverable_depreciation: 5,
      ale_non_recoverable_depreciation: 10,
    });
    const call = (userId, claimId, settlementId, payload) => (
      `SET request.app_user_id = '${userId}'; SET ROLE checksops; `
      + `SELECT public.save_claim_settlement_breakdown('${claimId}', `
      + `${settlementId ? `'${settlementId}'` : 'NULL'}, '${payload}'::jsonb); RESET ROLE;`
    );
    const inserted = JSON.parse(psql(call(USER_A, CLAIM_A, null, values)));
    assert.equal(inserted.ok, true);
    const settlementId = inserted.settlement.id;
    assert.equal(inserted.settlement.total_settlement, 12500);
    assert.equal(inserted.settlement.other_structures_rcv, 400);
    assert.equal(inserted.settlement.personal_property_non_recoverable_depreciation, 20);

    const duplicateSave = JSON.parse(psql(call(USER_A, CLAIM_A, null, values)));
    assert.equal(duplicateSave.ok, true);
    assert.equal(duplicateSave.settlement.id, settlementId);
    assert.equal(psql('SELECT count(*) FROM public.claim_settlements'), '1');

    const update = JSON.parse(psql(call(
      USER_A,
      CLAIM_A,
      settlementId,
      JSON.stringify({ replacement_cost_value: 17500 }),
    )));
    assert.equal(update.ok, true);
    assert.equal(update.settlement.id, settlementId);
    assert.equal(update.settlement.replacement_cost_value, 17500);
    assert.equal(update.settlement.other_structures_rcv, 400);
    assert.equal(psql('SELECT count(*) FROM public.claim_settlements'), '1');

    const crossTenant = JSON.parse(psql(call(
      USER_B,
      CLAIM_A,
      settlementId,
      JSON.stringify({ replacement_cost_value: 1 }),
    )));
    assert.deepEqual(crossTenant, { ok: false, code: 'not_authorized' });
    assert.equal(psql(`SELECT replacement_cost_value FROM public.claim_settlements WHERE id = '${settlementId}'`), '17500.00');

    const unauthorized = JSON.parse(psql(call(
      USER_C,
      CLAIM_A,
      settlementId,
      JSON.stringify({ replacement_cost_value: 2 }),
    )));
    assert.deepEqual(unauthorized, { ok: false, code: 'not_authorized' });
    assert.equal(psql(`SELECT replacement_cost_value FROM public.claim_settlements WHERE id = '${settlementId}'`), '17500.00');

    const directClaimsWrite = run(path.join(PG_BIN, 'psql'), [
      '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-c',
      `SET ROLE checksops; UPDATE public.claims SET org_id = '${TENANT_B}' WHERE id = '${CLAIM_A}'`,
    ]);
    assert.notEqual(directClaimsWrite.status, 0, 'checksops must not receive claims UPDATE privilege');
    assert.equal(psql(`SELECT org_id FROM public.claims WHERE id = '${CLAIM_A}'`), TENANT_A);
  } finally {
    run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(pgData, { recursive: true, force: true });
  }
});
