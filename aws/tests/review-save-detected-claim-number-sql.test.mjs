import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INTAKE_PROHIBITED_COLUMNS, WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const SQL = fs.readFileSync(path.join(ROOT, 'aws/write-path/sql/43_review_save_detected_claim_number.sql'), 'utf8');
const WRITE_SRC = fs.readFileSync(path.join(ROOT, 'aws/functions/api/write.mjs'), 'utf8');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CHECK_1 = '33333333-3333-4333-8333-333333333331';
const CHECK_2 = '33333333-3333-4333-8333-333333333332';

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

test('SQL 43 is source-controlled and does not broaden generic write rights', () => {
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('detected_claim_number'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('claim_id'), true);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('detected_claim_number'), false);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), false);
  assert.match(SQL, /NOT APPLIED/);
  assert.match(SQL, /review_save_detected_claim_number/);
  assert.match(SQL, /Existing claim_id is never rewritten/);
  assert.match(SQL, /Never inserts a claims row/);
  assert.doesNotMatch(SQL, /INSERT INTO public\.claims/);
  assert.doesNotMatch(SQL, /GRANT UPDATE/);
  assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.review_save_detected_claim_number/);
  assert.match(SQL, /REVOKE ALL ON FUNCTION public\.review_save_detected_claim_number[\s\S]*FROM authenticated/);
  assert.match(SQL, /SET detected_claim_number = v_incoming,\s*updated_at = now\(\)/);
  assert.doesNotMatch(SQL, /SET[\s\S]*claim_id\s*=/);
  assert.match(WRITE_SRC, /peelReviewClaimNumber/);
  assert.match(WRITE_SRC, /executeReviewClaimSave/);
  assert.match(WRITE_SRC, /review_save_detected_claim_number/);
  assert.match(WRITE_SRC, /pickAllowlistedValues\(table, peeled\.row\)/);
});

test('isolated PostgreSQL Review RPC preserves claim_id and denies cross-tenant', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-review-claim-'));
  const port = 55700 + (process.pid % 1000);
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
  t.after(() => {
    run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'fast', '-w', 'stop']);
    fs.rmSync(pgData, { recursive: true, force: true });
  });

  const psql = (sql) => {
    const result = mustRun(path.join(PG_BIN, 'psql'), [
      '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql,
    ]);
    return result.stdout.trim();
  };

  psql(`
    CREATE SCHEMA IF NOT EXISTS public;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops') THEN
        CREATE ROLE checksops;
      END IF;
    END $$;
    CREATE TABLE public.check_intake_items (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      detected_claim_number text,
      claim_id uuid,
      deposited_at timestamptz,
      check_stage text,
      carrier_name text,
      amount numeric,
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.claims (
      id uuid PRIMARY KEY,
      org_id uuid,
      claim_number text
    );
    CREATE OR REPLACE FUNCTION public.ocr_claim_number_key(p_value text)
    RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT NULLIF(lower(btrim(p_value)), '');
    $$;
  `);
  mustRun(path.join(PG_BIN, 'psql'), [
    '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, 'aws/write-path/sql/43_review_save_detected_claim_number.sql'),
  ]);

  psql(`
    INSERT INTO public.claims(id, org_id, claim_number) VALUES ('${CLAIM_A}', '${TENANT_A}', 'KEEP-LINK');
    INSERT INTO public.check_intake_items(id, tenant_id, detected_claim_number, claim_id, check_stage, carrier_name, amount)
    VALUES
      ('${CHECK_1}', '${TENANT_A}', 'OLD-OCR', '${CLAIM_A}', 'received', 'USAA', 18893.07),
      ('${CHECK_2}', '${TENANT_A}', 'OTHER', NULL, 'received', 'SAFE', 10);
  `);

  const written = JSON.parse(psql(
    `SELECT public.review_save_detected_claim_number('${CHECK_1}'::uuid, '${TENANT_A}'::uuid, '  USAA # 003779807  ')::text;`,
  ));
  assert.equal(written.ok, true);
  assert.equal(written.persisted, true);
  assert.equal(written.code, 'written');
  assert.equal(written.detected_claim_number, 'USAA # 003779807');

  const after = psql(
    `SELECT detected_claim_number || '|' || claim_id::text || '|' || carrier_name || '|' || amount::text FROM public.check_intake_items WHERE id = '${CHECK_1}';`,
  );
  assert.equal(after, 'USAA # 003779807|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1|USAA|18893.07');

  const claimsCount = psql('SELECT count(*) FROM public.claims;');
  assert.equal(claimsCount, '1');
  const claimNumber = psql(`SELECT claim_number FROM public.claims WHERE id = '${CLAIM_A}';`);
  assert.equal(claimNumber, 'KEEP-LINK');

  const sibling = psql(
    `SELECT detected_claim_number || '|' || coalesce(claim_id::text,'') || '|' || carrier_name FROM public.check_intake_items WHERE id = '${CHECK_2}';`,
  );
  assert.equal(sibling, 'OTHER||SAFE');

  const missing = JSON.parse(psql(
    `SELECT public.review_save_detected_claim_number('99999999-9999-4999-8999-999999999999'::uuid, '${TENANT_A}'::uuid, 'X')::text;`,
  ));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'check_not_found');

  const cross = JSON.parse(psql(
    `SELECT public.review_save_detected_claim_number('${CHECK_1}'::uuid, '${TENANT_B}'::uuid, 'HIJACK')::text;`,
  ));
  assert.equal(cross.ok, false);
  assert.equal(cross.code, 'tenant_mismatch');
  const still = psql(`SELECT detected_claim_number FROM public.check_intake_items WHERE id = '${CHECK_1}';`);
  assert.equal(still, 'USAA # 003779807');
});
