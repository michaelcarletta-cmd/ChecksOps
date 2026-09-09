import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL_PATH = path.join(ROOT, 'aws/financial/sql/65_checkalt_production_writer.sql');
const SQL65 = fs.readFileSync(SQL_PATH, 'utf8');
const ISO_HOST = '/tmp/pg-sql65';
const ISO_PORT = 55432;
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CHECK_A = '44444444-4444-4444-8444-444444444444';
const CHECK_B = '55555555-5555-4555-8555-555555555555';

const isolatedReady = (() => {
  const probe = spawnSync('pg_isready', ['-h', ISO_HOST, '-p', String(ISO_PORT)], { encoding: 'utf8' });
  return probe.status === 0;
})();

test('SQL 65 source is fail-closed for unset financial GUCs and stays dark', () => {
  assert.match(SQL65, /DO NOT APPLY/);
  assert.match(SQL65, /SELECT 'NOT_APPLIED'/);
  assert.match(SQL65, /COALESCE\(\s*\n?\s*current_setting\('request\.financial_execution',\s*true\) = '1'\s*\n?\s*AND current_setting\('request\.aws_financial_permissions_activated',\s*true\) = '1',\s*\n?\s*false\s*\n?\s*\)/s);
  assert.match(SQL65, /IF NOT COALESCE\(public\.aws_financial_execution_active\(\), false\)/);
  assert.match(SQL65, /AND COALESCE\(public\.aws_financial_execution_active\(\), false\)/);
  assert.doesNotMatch(SQL65, /IF NOT public\.aws_financial_execution_active\(\)/);
  assert.doesNotMatch(SQL65, /current_setting\([^)]+\) = '1'\s*;/);
});

const bootstrapSql = `
CREATE OR REPLACE FUNCTION public.aws_is_authenticated()
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

CREATE OR REPLACE FUNCTION public.aws_can_access_tenant(_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

CREATE TABLE public.checkalt_deposits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  check_intake_item_id uuid NOT NULL,
  amount numeric,
  status text,
  checkalt_reference text,
  submitted_by uuid,
  last_status_payload jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.checkalt_config (
  singleton boolean PRIMARY KEY DEFAULT true,
  merchant text,
  fi_key text,
  base_url text,
  default_enabled boolean,
  depositor_account_id text,
  business_unit text
);

INSERT INTO public.checkalt_config (
  singleton, merchant, fi_key, base_url, default_enabled, depositor_account_id, business_unit
) VALUES (
  true, 'iso-merchant', 'iso-fi', 'https://api2.checkalt.com', true, 'acct-iso', NULL
);

INSERT INTO public.checkalt_deposits (
  id, tenant_id, check_intake_item_id, amount, status, checkalt_reference, last_status_payload
) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${FREEDOM}', '${CHECK_A}', 12.34, 'submitted', 'LEGACY-1', '{"legacy":true}'::jsonb),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '${FREEDOM}', '${CHECK_B}', 56.78, 'pending_approval', 'LEGACY-2', '{"legacy":true}'::jsonb);
`;

const expectConfigDenied = async (client, label) => {
  let code = null;
  try {
    await client.query('SELECT * FROM public.aws_checkalt_production_config()');
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, '42501', label);
};

const expectConfigAllowed = async (client, label) => {
  const rows = (await client.query('SELECT * FROM public.aws_checkalt_production_config()')).rows;
  assert.equal(rows.length, 1, label);
  assert.equal(rows[0].merchant, 'iso-merchant');
  assert.equal(rows[0].fi_key, 'iso-fi');
  assert.equal(rows[0].base_url, 'https://api2.checkalt.com');
};

test('SQL 65 isolated apply is fail-closed, idempotent, and leaves legacy rows unchanged', {
  skip: isolatedReady ? false : 'isolated Postgres at /tmp/pg-sql65:55432 is not running',
}, async () => {
  const requireFromApi = createRequire(new URL('../functions/api/package.json', import.meta.url));
  const { Client } = requireFromApi('pg');
  const dbName = `sql65_phase26_${process.pid}_${Date.now()}`;
  const admin = new Client({ host: ISO_HOST, port: ISO_PORT, database: 'postgres', user: 'ubuntu' });
  await admin.connect();
  await admin.query(`
    DO $$ BEGIN
      CREATE ROLE checksops;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  await admin.query(`
    DO $$ BEGIN
      CREATE ROLE authenticated;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const connect = () => new Client({ host: ISO_HOST, port: ISO_PORT, database: dbName, user: 'ubuntu' });
  const client = connect();
  await client.connect();
  try {
    await client.query(bootstrapSql);
    const before = (await client.query(`
      SELECT id, tenant_id, check_intake_item_id, amount::text, status, checkalt_reference,
             last_status_payload
      FROM public.checkalt_deposits
      ORDER BY id
    `)).rows;
    assert.equal(before.length, 2);

    await client.query(SQL65);
    await client.query(SQL65);

    const after = (await client.query(`
      SELECT id, tenant_id, check_intake_item_id, amount::text, status, checkalt_reference,
             last_status_payload, idempotency_key, amount_cents, provider_http_attempted_at
      FROM public.checkalt_deposits
      ORDER BY id
    `)).rows;
    assert.equal(after.length, 2);
    assert.deepEqual(after.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      check_intake_item_id: row.check_intake_item_id,
      amount: row.amount,
      status: row.status,
      checkalt_reference: row.checkalt_reference,
      last_status_payload: row.last_status_payload,
    })), before);
    assert.equal(after.every((row) => row.idempotency_key == null), true);
    assert.equal(after.every((row) => row.amount_cents == null), true);
    assert.equal(after.every((row) => row.provider_http_attempted_at == null), true);

    const indexes = (await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'checkalt_deposits'
        AND indexname IN ('checkalt_deposits_tenant_idempotency_key_uq', 'idx_checkalt_deposits_idempotency_key')
    `)).rows;
    assert.equal(indexes.length, 2);

    const unset = connect();
    await unset.connect();
    try {
      await expectConfigDenied(unset, 'both GUCs unset');
    } finally {
      await unset.end();
    }

    const onlyExec = connect();
    await onlyExec.connect();
    try {
      await onlyExec.query("SELECT set_config('request.financial_execution', '1', false)");
      await expectConfigDenied(onlyExec, 'only execution true, permissions unset');
    } finally {
      await onlyExec.end();
    }

    const onlyPerms = connect();
    await onlyPerms.connect();
    try {
      await onlyPerms.query("SELECT set_config('request.aws_financial_permissions_activated', '1', false)");
      await expectConfigDenied(onlyPerms, 'only permissions true, execution unset');
    } finally {
      await onlyPerms.end();
    }

    const bothFalse = connect();
    await bothFalse.connect();
    try {
      await bothFalse.query("SELECT set_config('request.financial_execution', '0', false)");
      await bothFalse.query("SELECT set_config('request.aws_financial_permissions_activated', '0', false)");
      await expectConfigDenied(bothFalse, 'both GUCs false');
    } finally {
      await bothFalse.end();
    }

    const execTruePermsFalse = connect();
    await execTruePermsFalse.connect();
    try {
      await execTruePermsFalse.query("SELECT set_config('request.financial_execution', '1', false)");
      await execTruePermsFalse.query("SELECT set_config('request.aws_financial_permissions_activated', '0', false)");
      await expectConfigDenied(execTruePermsFalse, 'only execution true');
    } finally {
      await execTruePermsFalse.end();
    }

    const permsTrueExecFalse = connect();
    await permsTrueExecFalse.connect();
    try {
      await permsTrueExecFalse.query("SELECT set_config('request.financial_execution', '0', false)");
      await permsTrueExecFalse.query("SELECT set_config('request.aws_financial_permissions_activated', '1', false)");
      await expectConfigDenied(permsTrueExecFalse, 'only permissions true');
    } finally {
      await permsTrueExecFalse.end();
    }

    const bothTrue = connect();
    await bothTrue.connect();
    try {
      await bothTrue.query("SELECT set_config('request.financial_execution', '1', false)");
      await bothTrue.query("SELECT set_config('request.aws_financial_permissions_activated', '1', false)");
      await expectConfigAllowed(bothTrue, 'both GUCs explicitly true');
    } finally {
      await bothTrue.end();
    }
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
});
