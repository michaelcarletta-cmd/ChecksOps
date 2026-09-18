import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadStatusReadCheckAltConfig } from '../functions/api/providers/production/checkalt-config.mjs';
import { persistStatusReadOutcome } from '../functions/api/providers/production/checkalt-idempotency.mjs';
import { resolveCheckAltProviderStatus } from '../functions/api/providers/amounts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL66_PATH = path.join(ROOT, 'aws/financial/sql/66_checkalt_status_read.sql');
const SQL65_PATH = path.join(ROOT, 'aws/financial/sql/65_checkalt_production_writer.sql');
const SQL66 = fs.readFileSync(SQL66_PATH, 'utf8');
const SQL65 = fs.readFileSync(SQL65_PATH, 'utf8');
const ISO_HOST = '/tmp/pg-sql65';
const ISO_PORT = 55432;
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = '11111111-1111-4111-8111-111111111111';
const DEPOSIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_DEPOSIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER = '7dbb3009-f059-4767-b5dc-1c5c72379330';

const isolatedReady = (() => {
  const probe = spawnSync('pg_isready', ['-h', ISO_HOST, '-p', String(ISO_PORT)], { encoding: 'utf8' });
  return probe.status === 0;
})();

test('SQL 66 is isolated from SQL 65 and fail-closed', () => {
  assert.match(SQL66, /DO NOT APPLY/);
  assert.match(SQL66, /SELECT 'NOT_APPLIED'/);
  assert.match(SQL66, /aws_checkalt_status_read_config\(\)/);
  assert.match(SQL66, /aws_checkalt_status_read_persist\(/);
  assert.match(SQL66, /request\.checkalt_status_read/, 'status-read GUC required');
  assert.match(SQL66, /SECURITY DEFINER/);
  assert.match(SQL66, /row_security = off/);
  assert.match(SQL66, /GRANT EXECUTE ON FUNCTION public\.aws_checkalt_status_read_config\(\) TO checksops/);
  assert.match(SQL66, /GRANT EXECUTE ON FUNCTION public\.aws_checkalt_status_read_persist\(uuid, text, jsonb, timestamptz, jsonb\) TO checksops/);
  assert.match(SQL66, /REVOKE ALL ON FUNCTION public\.aws_checkalt_status_read_config\(\) FROM PUBLIC/);
  assert.match(SQL66, /REVOKE ALL ON FUNCTION public\.aws_checkalt_status_read_persist\(uuid, text, jsonb, timestamptz, jsonb\) FROM PUBLIC/);
  assert.doesNotMatch(SQL66, /GRANT EXECUTE[^\n]+TO authenticated/);
  const configFn = SQL66.slice(SQL66.indexOf('CREATE OR REPLACE FUNCTION public.aws_checkalt_status_read_config'), SQL66.indexOf('aws_checkalt_status_read_persist'));
  assert.match(configFn, /SELECT c\.merchant,\s*c\.default_enabled,\s*c\.base_url/s);
  assert.doesNotMatch(configFn, /c\.fi_key|c\.webhook_secret|c\.cached_jwt|c\.depositor_account|c\.username|c\.password/);
  assert.doesNotMatch(SQL66, /last_register_payload/);
  assert.doesNotMatch(SQL66, /INSERT INTO public\.checkalt_deposits/);
  const persistSet = SQL66.slice(SQL66.lastIndexOf('UPDATE public.checkalt_deposits'), SQL66.indexOf('RETURNING * INTO _row'));
  assert.match(persistSet, /SET status = _next/);
  assert.doesNotMatch(persistSet, /\bamount\b|\bamount_cents\b|\btenant_id\b|\bcheckalt_reference\b/);
  assert.doesNotMatch(persistSet, /\bsubmitted_at\b|\bsubmitted_by\b|\bidempotency_key\b|\bcheck_intake_item_id\b/);
  assert.doesNotMatch(SQL66, /aws_financial_insert_checkalt_deposits|aws_financial_update_checkalt_deposits/);
  assert.doesNotMatch(SQL66, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.checkalt_deposits/);
  assert.match(SQL65, /aws_checkalt_production_config/);
  assert.match(SQL65, /aws_financial_update_checkalt_deposits/);
  assert.equal(SQL65.includes('aws_checkalt_status_read_config'), false);
  const sql65Diff = spawnSync('git', ['diff', '--', 'aws/financial/sql/65_checkalt_production_writer.sql'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(sql65Diff.status, 0);
  assert.equal(sql65Diff.stdout, '', 'SQL 65 file must remain unmodified');
});

test('status-read API files do not change submit/approve/SQL 65', () => {
  const poll = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-poll.mjs'), 'utf8');
  const approve = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-approve.mjs'), 'utf8');
  const submit = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-submit.mjs'), 'utf8');
  const config = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-config.mjs'), 'utf8');
  const idem = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-idempotency.mjs'), 'utf8');
  assert.match(poll, /loadStatusReadCheckAltConfig/);
  assert.match(poll, /persistStatusReadOutcome/);
  assert.equal(poll.includes('loadProductionCheckAltConfig'), false);
  assert.equal(poll.includes('persistPollOutcome'), false);
  assert.match(approve, /loadProductionCheckAltConfig/);
  assert.match(approve, /persistPollOutcome/);
  assert.equal(approve.includes('loadStatusReadCheckAltConfig'), false);
  assert.equal(approve.includes('persistStatusReadOutcome'), false);
  assert.match(submit, /loadProductionCheckAltConfig/);
  assert.equal(submit.includes('loadStatusReadCheckAltConfig'), false);
  assert.match(config, /aws_checkalt_status_read_config\(\)/);
  assert.match(config, /aws_checkalt_production_config\(\)/);
  assert.match(idem, /aws_checkalt_status_read_persist/);
  assert.match(idem.slice(idem.indexOf('export async function persistPollOutcome')), /UPDATE public\.checkalt_deposits/);
});

test('loadStatusReadCheckAltConfig never queries SQL 65 or raw checkalt_config', async () => {
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      return { rows: [{ merchant: 'm', default_enabled: true, base_url: 'https://api2.checkalt.com' }] };
    },
  };
  const loaded = await loadStatusReadCheckAltConfig(client, {
    credentials: {
      baseUrl: 'https://api2.checkalt.com',
      fiKey: 'secret-fi',
      username: 'user',
      password: 'pass',
    },
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.cfg.merchant, 'm');
  assert.equal(loaded.cfg.fi_key, 'secret-fi');
  assert.equal(loaded.cfg.base_url, 'https://api2.checkalt.com');
  assert.equal(loaded.cfg.depositor_account_id, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /aws_checkalt_status_read_config/);
  assert.doesNotMatch(calls[0], /aws_checkalt_production_config|FROM public\.checkalt_config/);
});

test('loadStatusReadCheckAltConfig fail-closes when the function raises', async () => {
  const client = {
    query: async () => {
      const error = new Error('checkalt status-read config requires request.checkalt_status_read=1');
      error.code = '42501';
      throw error;
    },
  };
  const loaded = await loadStatusReadCheckAltConfig(client, {
    credentials: {
      baseUrl: 'https://api2.checkalt.com',
      fiKey: 'secret-fi',
      username: 'user',
      password: 'pass',
    },
  });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error, 'checkalt_status_read_config_unreadable');
});

test('persistStatusReadOutcome calls isolated persist and never raw UPDATE', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: params[0], status: params[1], checkalt_reference: 'keep-me', amount: '10.00', tenant_id: FREEDOM }] };
    },
  };
  await persistStatusReadOutcome(client, {
    rowId: DEPOSIT,
    status: resolveCheckAltProviderStatus({ statusCode: 127, status: 'Approved' }),
    providerPayload: { statusCode: 127, status: 'Approved' },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /aws_checkalt_status_read_persist/);
  assert.doesNotMatch(calls[0].sql, /UPDATE public\.checkalt_deposits/);
  assert.equal(calls[0].params[1], 'submitted');
  assert.equal(calls[0].params[3], null);

  calls.length = 0;
  await persistStatusReadOutcome(client, {
    rowId: DEPOSIT,
    status: resolveCheckAltProviderStatus({ statusCode: 200 }),
    providerPayload: { statusCode: 200 },
  });
  assert.equal(calls[0].params[1], 'submitted');
  assert.equal(calls[0].params[3], null);

  calls.length = 0;
  await persistStatusReadOutcome(client, {
    rowId: DEPOSIT,
    status: resolveCheckAltProviderStatus({ statusCode: 200, depositDate: '2026-09-16' }),
    providerPayload: { statusCode: 200, depositDate: '2026-09-16' },
  });
  assert.equal(calls[0].params[1], 'cleared');
  assert.equal(calls[0].params[3], '2026-09-16T12:00:00.000Z');
});

const bootstrapSql = `
CREATE OR REPLACE FUNCTION public.aws_can_access_tenant(_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('request.app_user_id', true), '') IS NULL THEN true
    WHEN current_setting('request.app_user_id', true) = '${OWNER}' AND _tenant = '${FREEDOM}'::uuid THEN true
    ELSE false
  END;
$$;

CREATE TABLE public.checkalt_config (
  singleton boolean PRIMARY KEY DEFAULT true,
  merchant text,
  fi_key text,
  base_url text,
  default_enabled boolean,
  depositor_account_id text,
  business_unit text,
  webhook_secret text,
  cached_jwt text
);

INSERT INTO public.checkalt_config (
  singleton, merchant, fi_key, base_url, default_enabled, depositor_account_id, business_unit, webhook_secret, cached_jwt
) VALUES (
  true, 'iso-merchant', 'iso-fi-secret', 'https://api2.checkalt.com', true, 'acct-secret', 'BU-1', 'whsec', 'jwt-secret'
);

CREATE TABLE public.checkalt_deposits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  check_intake_item_id uuid,
  amount numeric,
  amount_cents bigint,
  status text,
  checkalt_reference text,
  last_status_payload jsonb,
  last_polled_at timestamptz,
  cleared_at timestamptz,
  returned_at timestamptz,
  submitted_at timestamptz,
  submitted_by uuid,
  idempotency_key text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

INSERT INTO public.checkalt_deposits (
  id, tenant_id, check_intake_item_id, amount, amount_cents, status, checkalt_reference
) VALUES
  ('${DEPOSIT}', '${FREEDOM}', '44444444-4444-4444-8444-444444444444', 12.34, 1234, 'pending_approval', 'REF-9562'),
  ('${OTHER_DEPOSIT}', '${OTHER}', '55555555-5555-4555-8555-555555555555', 56.78, 5678, 'submitted', 'REF-OTHER');
`;

test('SQL 66 isolated apply is fail-closed and cannot mark 127/200-without-date cleared', {
  skip: isolatedReady ? false : 'isolated Postgres at /tmp/pg-sql65:55432 is not running',
}, async () => {
  const requireFromApi = createRequire(new URL('../functions/api/package.json', import.meta.url));
  const { Client } = requireFromApi('pg');
  const dbName = `sql66_status_read_${process.pid}_${Date.now()}`;
  const admin = new Client({ host: ISO_HOST, port: ISO_PORT, database: 'postgres', user: 'ubuntu' });
  await admin.connect();
  await admin.query(`
    DO $$ BEGIN
      CREATE ROLE checksops;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const connect = () => new Client({ host: ISO_HOST, port: ISO_PORT, database: dbName, user: 'ubuntu' });
  const client = connect();
  await client.connect();
  try {
    await client.query(bootstrapSql);
    await client.query(SQL66);
    await client.query(SQL66);

    const unset = connect();
    await unset.connect();
    try {
      await unset.query("SELECT set_config('request.financial_execution', '0', false)");
      let code = null;
      try {
        await unset.query('SELECT * FROM public.aws_checkalt_status_read_config()');
      } catch (error) {
        code = error.code;
      }
      assert.equal(code, '42501', 'config denied without status-read GUC');
      code = null;
      try {
        await unset.query(
          `SELECT * FROM public.aws_checkalt_status_read_persist($1::uuid, 'submitted', '{}'::jsonb, NULL, '{}'::jsonb)`,
          [DEPOSIT],
        );
      } catch (error) {
        code = error.code;
      }
      assert.equal(code, '42501', 'persist denied without status-read GUC');
    } finally {
      await unset.end();
    }

    const allowed = connect();
    await allowed.connect();
    try {
      await allowed.query("SELECT set_config('request.checkalt_status_read', '1', false)");
      await allowed.query("SELECT set_config('request.financial_execution', '0', false)");
      await allowed.query("SELECT set_config('request.aws_financial_permissions_activated', '0', false)");
      await allowed.query(`SELECT set_config('request.app_user_id', '${OWNER}', false)`);

      const cfg = (await allowed.query('SELECT * FROM public.aws_checkalt_status_read_config()')).rows[0];
      assert.equal(cfg.merchant, 'iso-merchant');
      assert.equal(cfg.default_enabled, true);
      assert.equal(cfg.base_url, 'https://api2.checkalt.com');
      assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'fi_key'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'webhook_secret'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'cached_jwt'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'depositor_account_id'), false);

      const approved = (await allowed.query(
        `SELECT * FROM public.aws_checkalt_status_read_persist($1::uuid, 'cleared', $2::jsonb, $3::timestamptz, $4::jsonb)`,
        [DEPOSIT, JSON.stringify({ last_poll: { status: 'cleared' } }), '2026-09-16T12:00:00.000Z', JSON.stringify({ statusCode: 127, status: 'Approved', depositDate: '2026-09-16' })],
      )).rows[0];
      assert.equal(approved.status, 'submitted');
      assert.equal(approved.cleared_at, null);
      assert.equal(approved.checkalt_reference, 'REF-9562');
      assert.equal(String(approved.amount), '12.34');
      assert.equal(approved.tenant_id, FREEDOM);

      const noDate = (await allowed.query(
        `SELECT * FROM public.aws_checkalt_status_read_persist($1::uuid, 'cleared', $2::jsonb, NULL, $3::jsonb)`,
        [DEPOSIT, JSON.stringify({ last_poll: { status: 'cleared' } }), JSON.stringify({ statusCode: 200 })],
      )).rows[0];
      assert.equal(noDate.status, 'submitted');
      assert.equal(noDate.cleared_at, null);

      const settled = (await allowed.query(
        `SELECT * FROM public.aws_checkalt_status_read_persist($1::uuid, 'cleared', $2::jsonb, $3::timestamptz, $4::jsonb)`,
        [DEPOSIT, JSON.stringify({ last_poll: { status: 'cleared', depositDate: '2026-09-16T12:00:00.000Z' } }), '2026-09-16T12:00:00.000Z', JSON.stringify({ statusCode: 200, depositDate: '2026-09-16' })],
      )).rows[0];
      assert.equal(settled.status, 'cleared');
      assert.ok(settled.cleared_at);
      assert.equal(settled.checkalt_reference, 'REF-9562');
      assert.equal(String(settled.amount), '12.34');
      assert.equal(settled.tenant_id, FREEDOM);

      let otherCode = null;
      try {
        await allowed.query(
          `SELECT * FROM public.aws_checkalt_status_read_persist($1::uuid, 'submitted', '{}'::jsonb, NULL, '{}'::jsonb)`,
          [OTHER_DEPOSIT],
        );
      } catch (error) {
        otherCode = error.code;
      }
      assert.equal(otherCode, '42501', 'cannot persist another tenant deposit');

      await allowed.query("SELECT set_config('request.app_user_id', '', false)");
      const missing = await allowed.query(
        `SELECT * FROM public.aws_checkalt_status_read_persist($1::uuid, 'submitted', '{}'::jsonb, NULL, '{}'::jsonb)`,
        ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
      ).then(() => null).catch((error) => error.code);
      assert.equal(missing, 'P0002');
    } finally {
      await allowed.end();
    }
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
});
