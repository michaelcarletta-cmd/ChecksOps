import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INTAKE_PROHIBITED_COLUMNS } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const SQL = fs.readFileSync(path.join(ROOT, 'aws/write-path/sql/41_ocr_detected_claim_number.sql'), 'utf8');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CLAIM_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const CLAIM_B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const CHECK_1 = '33333333-3333-4333-8333-333333333331';
const CHECK_2 = '33333333-3333-4333-8333-333333333332';
const CHECK_3 = '33333333-3333-4333-8333-333333333333';
const CHECK_4 = '33333333-3333-4333-8333-333333333334';
const CHECK_5 = '33333333-3333-4333-8333-333333333335';
const LINKED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9';

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

test('SQL artifact keeps generic write prohibited and is not an apply script', () => {
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('detected_claim_number'), true);
  assert.match(SQL, /NOT APPLIED/);
  assert.doesNotMatch(SQL, /^GRANT UPDATE/m);
  assert.match(SQL, /ocr_unique_tenant_claim_id/);
  assert.match(SQL, /v_count IS DISTINCT FROM 1/);
  assert.match(SQL, /c\.org_id IS NOT DISTINCT FROM p_tenant_id/);
  assert.doesNotMatch(SQL, /checkalt-submit|moov-webhook|amount\s*=/);
});

test('isolated PostgreSQL unique-tenant claim persist and auto-link', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true);
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ocr-claim-'));
  const port = 55600 + (process.pid % 1000);
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
  mustRun(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', logPath, '-w', 'start']);
  t.after(() => {
    run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', 'stop']);
    fs.rmSync(pgData, { recursive: true, force: true });
  });
  const psql = (sql) => mustRun(path.join(PG_BIN, 'psql'), [
    '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql,
  ]).stdout.trim();
    psql(`
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE checksops NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE TABLE public.claims (
  id uuid PRIMARY KEY,
  org_id uuid,
  claim_number text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  claim_id uuid,
  detected_claim_number text,
  freedom_claim_id uuid,
  freedom_claim_number text,
  front_image_path text NOT NULL DEFAULT 'x',
  updated_at timestamptz DEFAULT now()
);
`);
    mustRun(path.join(PG_BIN, 'psql'), [
      '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
      '-f', path.join(ROOT, 'aws/write-path/sql/41_ocr_detected_claim_number.sql'),
    ]);
    psql(`
CREATE TRIGGER trg_auto_link_check_to_claim
BEFORE INSERT OR UPDATE OF freedom_claim_id, detected_claim_number, claim_id
ON public.check_intake_items
FOR EACH ROW EXECUTE FUNCTION public.auto_link_check_to_claim();
CREATE TRIGGER trg_auto_link_check_to_claim_upd
BEFORE UPDATE OF detected_claim_number ON public.check_intake_items
FOR EACH ROW
WHEN (NEW.claim_id IS NULL AND NEW.detected_claim_number IS DISTINCT FROM OLD.detected_claim_number)
EXECUTE FUNCTION public.tg_auto_link_check_to_claim();

INSERT INTO public.claims(id, org_id, claim_number) VALUES
  ('${CLAIM_A1}', '${TENANT_A}', '00412-AB/9'),
  ('${CLAIM_A2}', '${TENANT_A}', 'DUP-99'),
  ('${CLAIM_B1}', '${TENANT_B}', '00412-AB/9'),
  ('${LINKED}', '${TENANT_A}', 'KEEP-LINK');
INSERT INTO public.claims(id, org_id, claim_number) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '${TENANT_A}', 'dup-99');

INSERT INTO public.check_intake_items(id, tenant_id, detected_claim_number, claim_id) VALUES
  ('${CHECK_1}', '${TENANT_A}', NULL, NULL),
  ('${CHECK_2}', '${TENANT_A}', NULL, NULL),
  ('${CHECK_3}', '${TENANT_A}', NULL, NULL),
  ('${CHECK_4}', '${TENANT_A}', NULL, '${LINKED}'),
  ('${CHECK_5}', '${TENANT_A}', '38-99V2-97X', NULL);
`);

    const written = JSON.parse(psql(`SELECT public.ocr_persist_detected_claim_number('${CHECK_1}'::uuid, '${TENANT_A}'::uuid, '  00412-AB/9  ')::text;`));
    assert.equal(written.code, 'written');
    assert.equal(written.persisted, true);
    assert.equal(written.linked, true);
    const row1 = psql(`SELECT detected_claim_number || '|' || coalesce(claim_id::text,'') FROM public.check_intake_items WHERE id = '${CHECK_1}';`);
    assert.equal(row1, `00412-AB/9|${CLAIM_A1}`);

    const zero = JSON.parse(psql(`SELECT public.ocr_persist_detected_claim_number('${CHECK_2}'::uuid, '${TENANT_A}'::uuid, 'NO-SUCH-CLAIM')::text;`));
    assert.equal(zero.code, 'written');
    assert.equal(zero.linked, false);
    const row2 = psql(`SELECT detected_claim_number || '|' || coalesce(claim_id::text,'') FROM public.check_intake_items WHERE id = '${CHECK_2}';`);
    assert.equal(row2, 'NO-SUCH-CLAIM|');

    const many = JSON.parse(psql(`SELECT public.ocr_persist_detected_claim_number('${CHECK_3}'::uuid, '${TENANT_A}'::uuid, 'DUP-99')::text;`));
    assert.equal(many.code, 'written');
    assert.equal(many.linked, false);
    const row3 = psql(`SELECT detected_claim_number || '|' || coalesce(claim_id::text,'') FROM public.check_intake_items WHERE id = '${CHECK_3}';`);
    assert.equal(row3, 'DUP-99|');

    const existing = JSON.parse(psql(`SELECT public.ocr_persist_detected_claim_number('${CHECK_4}'::uuid, '${TENANT_A}'::uuid, '00412-AB/9')::text;`));
    assert.equal(existing.code, 'written');
    const row4 = psql(`SELECT claim_id::text FROM public.check_intake_items WHERE id = '${CHECK_4}';`);
    assert.equal(row4, LINKED);

    const conflict = JSON.parse(psql(`SELECT public.ocr_persist_detected_claim_number('${CHECK_5}'::uuid, '${TENANT_A}'::uuid, '00412-AB/9')::text;`));
    assert.equal(conflict.code, 'conflict_preserved');
    const row5 = psql(`SELECT detected_claim_number || '|' || coalesce(claim_id::text,'') FROM public.check_intake_items WHERE id = '${CHECK_5}';`);
    assert.equal(row5, '38-99V2-97X|');

    const same = JSON.parse(psql(`SELECT public.ocr_persist_detected_claim_number('${CHECK_1}'::uuid, '${TENANT_A}'::uuid, '00412-ab/9')::text;`));
    assert.equal(same.code, 'unchanged');

    const cross = JSON.parse(psql(`SELECT public.ocr_persist_detected_claim_number('${CHECK_2}'::uuid, '${TENANT_B}'::uuid, '00412-AB/9')::text;`));
    assert.equal(cross.code, 'tenant_mismatch');
    const row2b = psql(`SELECT detected_claim_number || '|' || coalesce(claim_id::text,'') FROM public.check_intake_items WHERE id = '${CHECK_2}';`);
    assert.equal(row2b, 'NO-SUCH-CLAIM|');

    const punct = psql(`SELECT public.ocr_unique_tenant_claim_id('${TENANT_A}'::uuid, '00412AB9') IS NULL;`);
    assert.equal(punct, 't');

    const execAuth = psql(`SELECT has_function_privilege('authenticated', 'public.ocr_persist_detected_claim_number(uuid,uuid,text)', 'EXECUTE');`);
    assert.equal(execAuth, 'f');
    const execApp = psql(`SELECT has_function_privilege('checksops', 'public.ocr_persist_detected_claim_number(uuid,uuid,text)', 'EXECUTE');`);
    assert.equal(execApp, 't');
    const colGrant = psql(`SELECT has_column_privilege('checksops', 'public.check_intake_items', 'detected_claim_number', 'UPDATE');`);
    assert.equal(colGrant, 'f');
    const colGrantAuth = psql(`SELECT has_column_privilege('authenticated', 'public.check_intake_items', 'detected_claim_number', 'UPDATE');`);
    assert.equal(colGrantAuth, 'f');
});
