import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'url';
import {
  runGetEndorsementData,
} from '../functions/api/check-endorsement.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const ARTIFACT_DIR = '/opt/cursor/artifacts';
const SQL71 = path.join(ROOT, 'workflows/sql/71_endorsement_email_audit.sql');
const SQL72 = path.join(ROOT, 'workflows/sql/72_public_endorsement_token_lookup.sql');
const SQL73 = path.join(ROOT, 'workflows/sql/73_public_endorsement_submit_payee.sql');
const SQL73_DOWN = path.join(ROOT, 'workflows/sql/73_public_endorsement_submit_payee_rollback.sql');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CHECK_A = '33333333-3333-4333-8333-333333333333';
const CHECK_B = '44444444-4444-4444-8444-444444444444';
const CHECK_PHYS = '88888888-8888-4888-8888-888888888888';
const END_A = '55555555-5555-4555-8555-555555555555';
const END_B = '66666666-6666-4666-8666-666666666666';
const END_PHYS = '77777777-7777-4777-8777-777777777777';
const END_CONC = '12121212-1212-4121-8121-121212121212';
const PAYEE_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PAYEE_A2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAYEE_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PAYEE_PHYS = '99999999-9999-4999-8999-999999999999';
const PAYEE_CONC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PAYEE_CONC2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TOKEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_PHYS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TOKEN_EXPIRED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TOKEN_CONC = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const WRONG = '00000000-0000-4000-8000-000000000000';

const SUBMIT_REGPROC = 'public.aws_public_submit_endorsement(text,text,text,text,text,text,uuid,uuid)';
const SQL73_STAGING_MD5 = 'd388bb4ec4a9cd6ee83d7e02e193b47c';
const SQL71_SUBMIT_ROLLBACK_MD5 = '89d7c65888ee551fc2488fefdf6d287c';

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

test('SQL 73 source is submit-payee only and does not rewrite SQL 71/72 files', () => {
  const sql73 = fs.readFileSync(SQL73, 'utf8');
  const down = fs.readFileSync(SQL73_DOWN, 'utf8');
  const sql71 = fs.readFileSync(SQL71, 'utf8');
  const sql72 = fs.readFileSync(SQL72, 'utf8');
  assert.match(sql73, /CREATE OR REPLACE FUNCTION public\.aws_public_submit_endorsement\(/);
  assert.match(sql73, /UPDATE public\.check_payees/);
  assert.match(sql73, /endorsement_status = 'signed'/);
  assert.match(sql73, /SECURITY DEFINER/);
  assert.match(sql73, /row_security = off/);
  assert.match(sql73, /GRANT EXECUTE ON FUNCTION public\.aws_public_submit_endorsement\(text, text, text, text, text, text, uuid, uuid\) TO checksops/);
  assert.match(sql73, /REVOKE ALL ON FUNCTION public\.aws_public_submit_endorsement\(text, text, text, text, text, text, uuid, uuid\) FROM PUBLIC/);
  assert.match(sql73, /REVOKE ALL ON FUNCTION public\.aws_public_submit_endorsement\(text, text, text, text, text, text, uuid, uuid\) FROM authenticated/);
  assert.doesNotMatch(sql73, /GRANT\s+(UPDATE|INSERT|DELETE)\s+ON\s+TABLE/);
  assert.doesNotMatch(sql73, /GRANT UPDATE ON public\.check_payees/);
  assert.doesNotMatch(sql73, /aws_public_signature_by_token_hash/);
  assert.doesNotMatch(sql73, /aws_mark_endorsement_request_sent/);
  assert.doesNotMatch(sql73, /CREATE OR REPLACE FUNCTION public\.aws_public_reject_endorsement/);
  assert.doesNotMatch(sql73, /CREATE OR REPLACE FUNCTION public\.aws_public_endorsement_by_token/);
  const sql73Body = sql73.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(sql73Body, /\bclaim_id\b/);
  assert.match(down, /CREATE OR REPLACE FUNCTION public\.aws_public_submit_endorsement\(/);
  assert.doesNotMatch(down, /DROP FUNCTION/);
  assert.doesNotMatch(down, /UPDATE public\.check_payees/);
  assert.doesNotMatch(sql71, /73_public_endorsement_submit_payee/);
  assert.doesNotMatch(sql72, /check_payees/);
});

const bootstrap = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE OR REPLACE FUNCTION public.aws_can_write_tenant(_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  claim_id uuid,
  carrier_name text,
  check_number text,
  amount numeric,
  status text,
  check_stage text,
  deposited_at timestamptz
);
CREATE TABLE public.check_endorsements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid,
  tenant_id uuid,
  payee_id uuid,
  payee_name text,
  payee_type text,
  contact_email text,
  status text DEFAULT 'pending',
  token text,
  token_expires_at timestamptz,
  request_sent_at timestamptz,
  reminder_count integer DEFAULT 0,
  last_reminder_at timestamptz,
  signed_at timestamptz,
  signature_image_url text,
  signature_method text,
  ip_address text,
  user_agent text,
  consent_text text,
  notes text,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.check_payees (
  id uuid PRIMARY KEY,
  check_id uuid,
  tenant_id uuid,
  payee_name text,
  endorsement_status text,
  endorsed_at timestamptz,
  endorsement_token text,
  endorsement_token_expires_at timestamptz,
  endorsement_image_path text,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.email_send_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name text,
  recipient_email text,
  tenant_id uuid,
  status text DEFAULT 'pending',
  provider text,
  provider_message_id text,
  idempotency_key text UNIQUE,
  error_message text,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.endorsement_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endorsement_id uuid,
  check_id uuid,
  event_type text,
  event_description text,
  event_data jsonb,
  actor_id uuid,
  ip_address text,
  user_agent text
);
CREATE TABLE public.check_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid,
  event_type text,
  event_description text,
  event_data jsonb,
  actor_id uuid,
  tenant_id uuid
);
CREATE TABLE public.claim_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_intake_item_id uuid,
  check_stage text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.check_endorsements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_payees ENABLE ROW LEVEL SECURITY;
CREATE POLICY deny_endorsements ON public.check_endorsements FOR ALL TO PUBLIC USING (false);
CREATE POLICY deny_intake ON public.check_intake_items FOR ALL TO PUBLIC USING (false);
CREATE POLICY deny_payees ON public.check_payees FOR ALL TO PUBLIC USING (false);
GRANT SELECT ON public.check_endorsements TO checksops;
GRANT SELECT ON public.check_intake_items TO checksops;
GRANT SELECT ON public.check_payees TO checksops;
`;

test('SQL 73 atomically signs endorsement and matching payee without a second JS UPDATE', {
  timeout: 180000,
}, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }

  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-sql73-${stamp}-`));
  const port = 55400 + (process.pid % 1000);
  const dbName = `sql73_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `sql73_public_endorsement_payee_pg_${stamp}.log`);
  let started = false;
  const logChunks = [];
  const note = (line) => { logChunks.push(line); };

  const stopCluster = () => {
    if (started) {
      run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', 'stop']);
      started = false;
    }
    fs.rmSync(pgData, { recursive: true, force: true });
  };
  t.after(() => {
    try {
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(artifactLog, logChunks.join('\n'), 'utf8');
    } catch { /* ignore */ }
    stopCluster();
  });

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
  started = true;

  const psqlArgs = ['-h', pgData, '-p', String(port), '-U', 'ubuntu', '-v', 'ON_ERROR_STOP=1'];
  const psql = (extra, input) => {
    const result = run(path.join(PG_BIN, 'psql'), [...psqlArgs, ...extra], input ? { input } : {});
    if (result.status !== 0) {
      throw new Error(`psql failed: ${result.stderr || result.stdout}`);
    }
    return result;
  };
  const scalar = (sql) => {
    const out = psql(['-d', dbName, '-A', '-t', '-c', sql]).stdout.trim();
    const lines = out.split(/\r?\n/).filter((line) => line && line !== 'SET');
    return lines.at(-1) ?? '';
  };
  const asChecksops = (sql) => scalar(`SET ROLE checksops; ${sql}`);
  const submit = (token, extra = '') => JSON.parse(asChecksops(`
SELECT public.aws_public_submit_endorsement(
  '${token}', 'data:image/png;base64,aaa', 'consent', '1.1.1.1', 'ua',
  gen_random_uuid()::text
  ${extra}
)::text`));

  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);
  psql(['-d', dbName, '-c', 'CREATE ROLE checksops NOLOGIN']);
  psql(['-d', dbName, '-f', path.join(ROOT, 'rls/sql/01_role_shim.sql')]);
  psql(['-d', dbName], bootstrap);

  const applyTwice = (label, file) => {
    note(`apply ${label}`);
    psql(['-d', dbName, '-f', file]);
    psql(['-d', dbName, '-f', file]);
  };
  applyTwice('71_endorsement_email_audit', SQL71);
  applyTwice('72_public_endorsement_token_lookup', SQL72);
  applyTwice('73_public_endorsement_submit_payee', SQL73);

  const fingerprint = (label) => {
    const row = scalar(`
SELECT json_build_object(
  'proname', p.proname,
  'prosecdef', p.prosecdef,
  'pronargs', p.pronargs,
  'proconfig', p.proconfig,
  'md5', md5(pg_get_functiondef(p.oid)),
  'has_payee_update', (p.prosrc ILIKE '%UPDATE public.check_payees%')
)::text
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'aws_public_submit_endorsement'
`);
    note(`${label} ${row}`);
    return JSON.parse(row);
  };

  const fp1 = fingerprint('fingerprint-after-first-pair');
  applyTwice('73_public_endorsement_submit_payee-reapply', SQL73);
  const fp2 = fingerprint('fingerprint-after-reapply');
  assert.equal(fp1.proname, 'aws_public_submit_endorsement');
  assert.equal(fp1.prosecdef, true);
  assert.equal(fp1.pronargs, 8);
  assert.equal(fp1.has_payee_update, true);
  assert.equal(fp1.md5, SQL73_STAGING_MD5);
  assert.equal(fp1.md5, fp2.md5);
  assert.ok(Array.isArray(fp1.proconfig));
  assert.ok(fp1.proconfig.some((item) => String(item).includes('search_path')));
  assert.ok(fp1.proconfig.some((item) => String(item).includes('row_security')));

  assert.equal(scalar(`SELECT has_function_privilege('checksops', '${SUBMIT_REGPROC}', 'EXECUTE')::text`), 'true');
  assert.equal(scalar(`SELECT has_function_privilege('public', '${SUBMIT_REGPROC}', 'EXECUTE')::text`), 'false');
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', '${SUBMIT_REGPROC}', 'EXECUTE')::text`), 'false');
  assert.equal(scalar(`SELECT has_function_privilege('anon', '${SUBMIT_REGPROC}', 'EXECUTE')::text`), 'false');
  assert.equal(scalar(`
SELECT has_table_privilege('checksops', 'public.check_payees', 'UPDATE')::text
`), 'false');
  assert.equal(asChecksops(`SELECT count(*) FROM public.check_payees`), '0');

  psql(['-d', dbName], `
INSERT INTO public.check_intake_items (id, tenant_id, carrier_name, check_number, amount, status)
VALUES
  ('${CHECK_A}', '${TENANT_A}', 'Acme', '1001', 12.34, 'endorsements_in_progress'),
  ('${CHECK_B}', '${TENANT_B}', 'OtherCo', '2002', 99.00, 'endorsements_in_progress'),
  ('${CHECK_PHYS}', '${TENANT_A}', 'Acme', '3003', 50.00, 'needs_review');
INSERT INTO public.check_endorsements (
  id, check_id, tenant_id, payee_id, payee_name, payee_type, contact_email, status, token, token_expires_at
) VALUES
  ('${END_A}', '${CHECK_A}', '${TENANT_A}', '${PAYEE_A}', 'Jane A', 'insured', 'jane@example.com', 'sent', '${TOKEN_A}', NULL),
  ('${END_B}', '${CHECK_B}', '${TENANT_B}', '${PAYEE_B}', 'Bob B', 'insured', 'bob@example.com', 'sent', '${TOKEN_B}', NULL),
  ('${END_PHYS}', '${CHECK_PHYS}', '${TENANT_A}', '${PAYEE_PHYS}', 'Pat Physical', 'insured', 'pat@example.com', 'sent', '${TOKEN_PHYS}', NULL),
  (gen_random_uuid(), '${CHECK_A}', '${TENANT_A}', NULL, 'Expired', 'insured', 'exp@example.com', 'sent', '${TOKEN_EXPIRED}', now() - interval '1 hour'),
  ('${END_CONC}', '${CHECK_A}', '${TENANT_A}', '${PAYEE_CONC}', 'Concurrent A', 'insured', 'conc@example.com', 'sent', '${TOKEN_CONC}', NULL);
INSERT INTO public.check_payees (
  id, check_id, tenant_id, payee_name, endorsement_status, endorsement_token
) VALUES
  ('${PAYEE_A}', '${CHECK_A}', '${TENANT_A}', 'Jane A', 'pending', '${TOKEN_A}'),
  ('${PAYEE_A2}', '${CHECK_A}', '${TENANT_A}', 'Other Payee Same Check', 'pending', 'unrelated-a2'),
  ('${PAYEE_B}', '${CHECK_B}', '${TENANT_B}', 'Bob B', 'pending', '${TOKEN_B}'),
  ('${PAYEE_PHYS}', '${CHECK_PHYS}', '${TENANT_A}', 'Pat Physical', 'pending', '${TOKEN_PHYS}'),
  ('${PAYEE_CONC}', '${CHECK_A}', '${TENANT_A}', 'Concurrent A', 'pending', '${TOKEN_CONC}'),
  ('${PAYEE_CONC2}', '${CHECK_A}', '${TENANT_A}', 'Concurrent Other', 'pending', 'unrelated-conc2');
`);

  const jsGet = async (token) => runGetEndorsementData({
    query: async (sql, params) => {
      const compact = String(sql);
      if (compact.includes('SAVEPOINT') || compact.includes('RELEASE') || compact.includes('ROLLBACK TO')) {
        return { rows: [], rowCount: 0 };
      }
      if (compact.includes('aws_public_endorsement_by_token')) {
        const raw = scalar(`SET ROLE checksops; SELECT COALESCE(public.aws_public_endorsement_by_token('${params[0]}')::text, 'null')`);
        const doc = raw === 'null' ? null : JSON.parse(raw);
        return { rows: [{ doc }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  }, token, {});

  const freshGet = await jsGet(TOKEN_A);
  assert.equal(freshGet.ok, true);
  assert.equal(freshGet.statusCode, 200);
  assert.equal(freshGet.payee_name, 'Jane A');
  note('fresh GET 200');

  const snapA2 = scalar(`SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_A2}'`);
  const firstSubmit = JSON.parse(asChecksops(`
SELECT public.aws_public_submit_endorsement(
  '${TOKEN_A}', 'data:image/png;base64,aaa', 'consent', '1.1.1.1', 'ua',
  'rotated-a-1', '${CHECK_A}'::uuid, '${PAYEE_A}'::uuid
)::text`));
  assert.equal(firstSubmit.ok, true);
  assert.equal(firstSubmit.already_signed, false);
  assert.equal(firstSubmit.status, 'signed');
  assert.equal(firstSubmit.payee_status, 'signed');
  assert.equal(firstSubmit.payee_id, PAYEE_A);
  assert.equal(firstSubmit.tenant_id, TENANT_A);
  assert.equal(firstSubmit.claim_id, undefined);
  assert.equal(scalar(`SELECT status FROM public.check_endorsements WHERE id = '${END_A}'`), 'signed');
  assert.equal(scalar(`SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_A}'`), 'signed');
  assert.ok(scalar(`SELECT endorsed_at IS NOT NULL::text FROM public.check_payees WHERE id = '${PAYEE_A}'`) === 'true');
  assert.equal(scalar(`SELECT endorsement_token FROM public.check_payees WHERE id = '${PAYEE_A}'`), 'rotated-a-1');
  assert.equal(scalar(`SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_A2}'`), snapA2);
  assert.equal(asChecksops(`SELECT public.aws_public_endorsement_by_token('${TOKEN_A}') IS NULL::text`), 'true');
  const afterSubmitGet = await jsGet(TOKEN_A);
  assert.equal(afterSubmitGet.ok, false);
  assert.equal(afterSubmitGet.code, 'invalid_link');
  note('fresh submit signed endorsement+payee, unrelated payee unchanged, rotated token GET is invalid_link');

  const secondSubmit = submit(TOKEN_A);
  assert.equal(secondSubmit.ok, false);
  assert.equal(secondSubmit.error, 'invalid_or_used_token');
  assert.equal(scalar(`SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_A2}'`), 'pending');

  const unknownGet = await jsGet(WRONG);
  assert.equal(unknownGet.ok, false);
  assert.equal(unknownGet.code, 'invalid_link');
  note('P8: never-valid UUID GET is invalid_link; signed/rejected/waived/expired rows with a still-present token remain token_consumed');

  const beforeWrong = scalar(`
SELECT json_build_object(
  'end_a', (SELECT status FROM public.check_endorsements WHERE id = '${END_A}'),
  'payee_a', (SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_A}'),
  'payee_a2', (SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_A2}'),
  'end_b', (SELECT status FROM public.check_endorsements WHERE id = '${END_B}'),
  'payee_b', (SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_B}')
)::text`);
  const wrongToken = submit(WRONG);
  assert.equal(wrongToken.ok, false);
  assert.equal(wrongToken.error, 'invalid_or_used_token');
  const checkMismatch = JSON.parse(asChecksops(`
SELECT public.aws_public_submit_endorsement(
  '${TOKEN_B}', 'data:image/png;base64,aaa', 'consent', '1.1.1.1', 'ua',
  gen_random_uuid()::text, '${CHECK_A}'::uuid, NULL
)::text`));
  assert.equal(checkMismatch.ok, false);
  assert.equal(checkMismatch.error, 'check_mismatch');
  const payeeMismatch = JSON.parse(asChecksops(`
SELECT public.aws_public_submit_endorsement(
  '${TOKEN_B}', 'data:image/png;base64,aaa', 'consent', '1.1.1.1', 'ua',
  gen_random_uuid()::text, '${CHECK_B}'::uuid, '${PAYEE_A}'::uuid
)::text`));
  assert.equal(payeeMismatch.ok, false);
  assert.equal(payeeMismatch.error, 'payee_mismatch');
  const afterWrong = scalar(`
SELECT json_build_object(
  'end_a', (SELECT status FROM public.check_endorsements WHERE id = '${END_A}'),
  'payee_a', (SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_A}'),
  'payee_a2', (SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_A2}'),
  'end_b', (SELECT status FROM public.check_endorsements WHERE id = '${END_B}'),
  'payee_b', (SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_B}')
)::text`);
  assert.equal(afterWrong, beforeWrong);
  assert.equal(asChecksops(`SELECT (public.aws_public_endorsement_by_token('${TOKEN_B}')->>'status')`), 'sent');
  note('wrong token/check/payee denied with no row changes');

  const reject = JSON.parse(asChecksops(`
SELECT public.aws_public_reject_endorsement('${TOKEN_B}', 'nope', '1.1.1.1', 'ua', 'rotated-b-1')::text`));
  assert.equal(reject.ok, true);
  assert.equal(reject.status, 'rejected');
  assert.equal(scalar(`SELECT status FROM public.check_endorsements WHERE id = '${END_B}'`), 'rejected');
  assert.equal(scalar(`SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_B}'`), 'pending');
  assert.equal(asChecksops(`SELECT public.aws_public_endorsement_by_token('${TOKEN_B}') IS NULL::text`), 'true');
  note('reject does not mark payee signed');

  psql(['-d', dbName], `
UPDATE public.check_endorsements
SET status = 'signed',
    signed_at = now(),
    signature_method = 'manual',
    notes = 'CC-117 physical on-check persist',
    updated_at = now()
WHERE id = '${END_PHYS}'
  AND status IS DISTINCT FROM 'signed'
  AND status IS DISTINCT FROM 'waived';
UPDATE public.check_payees
SET endorsement_status = 'signed',
    endorsed_at = now()
WHERE id = '${PAYEE_PHYS}';
`);
  assert.equal(scalar(`SELECT status FROM public.check_endorsements WHERE id = '${END_PHYS}'`), 'signed');
  assert.equal(scalar(`SELECT signature_method FROM public.check_endorsements WHERE id = '${END_PHYS}'`), 'manual');
  assert.equal(scalar(`SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_PHYS}'`), 'signed');
  assert.equal(scalar(`SELECT token FROM public.check_endorsements WHERE id = '${END_PHYS}'`), TOKEN_PHYS);
  const physGet = await jsGet(TOKEN_PHYS);
  assert.equal(physGet.ok, false);
  assert.equal(physGet.code, 'token_consumed');
  note('CC-117 manual path still signs endorsement+payee without rotating the public token');

  const mark = JSON.parse(scalar(`
INSERT INTO public.check_endorsements (id, check_id, tenant_id, payee_name, status, token)
VALUES ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '${CHECK_A}', '${TENANT_A}', 'Mark Me', 'pending', 'mark-token');
SELECT public.aws_mark_endorsement_request_sent(
  'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'::uuid, 'jane@example.com', 'mark-token'
)::text
`));
  assert.equal(mark.ok, true);
  assert.equal(mark.status, 'sent');
  assert.ok(mark.request_sent_at);
  const markAgain = JSON.parse(scalar(`
SELECT public.aws_mark_endorsement_request_sent(
  'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'::uuid, 'jane@example.com', 'mark-token'
)::text`));
  assert.equal(markAgain.ok, true);
  assert.equal(markAgain.request_sent_at, mark.request_sent_at);
  note('email/idempotency mark-sent unchanged');

  const concSql = `
SELECT public.aws_public_submit_endorsement(
  '${TOKEN_CONC}', 'data:image/png;base64,aaa', 'consent', '1.1.1.1', 'ua',
  gen_random_uuid()::text, '${CHECK_A}'::uuid, '${PAYEE_CONC}'::uuid
)::text`;
  const spawnSubmit = () => new Promise((resolve) => {
    const child = spawn(path.join(PG_BIN, 'psql'), [
      ...psqlArgs, '-d', dbName, '-A', '-t', '-c', `SET ROLE checksops; ${concSql}`,
    ], { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const [left, right] = await Promise.all([spawnSubmit(), spawnSubmit()]);
  const parseDoc = (result) => {
    const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== 'SET');
    const last = lines.at(-1) || '';
    try { return JSON.parse(last); } catch {
      return { ok: false, error: 'parse_failed', raw: last, stderr: result.stderr, status: result.status };
    }
  };
  const docs = [parseDoc(left), parseDoc(right)];
  note(`concurrency ${JSON.stringify(docs)}`);
  const successes = docs.filter((doc) => doc.ok === true && doc.already_signed !== true);
  const denials = docs.filter((doc) => doc.ok === false);
  const already = docs.filter((doc) => doc.ok === true && doc.already_signed === true);
  assert.equal(successes.length, 1);
  assert.equal(successes.length + denials.length + already.length, 2);
  assert.equal(scalar(`SELECT status FROM public.check_endorsements WHERE id = '${END_CONC}'`), 'signed');
  assert.equal(scalar(`SELECT count(*) FROM public.check_payees WHERE id IN ('${PAYEE_CONC}','${PAYEE_CONC2}') AND endorsement_status = 'signed'`), '1');
  assert.equal(scalar(`SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_CONC}'`), 'signed');
  assert.equal(scalar(`SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_CONC2}'`), 'pending');
  assert.equal(asChecksops(`SELECT public.aws_public_endorsement_by_token('${TOKEN_CONC}') IS NULL::text`), 'true');
  note('concurrent submits cannot double-sign or update the unrelated payee');

  const sql71BodyHasPayee = scalar(`
SELECT (p.prosrc ILIKE '%UPDATE public.check_payees%')::text
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public' AND p.proname='aws_public_submit_endorsement'
`);
  assert.equal(sql71BodyHasPayee, 'true');
  psql(['-d', dbName, '-f', SQL73_DOWN]);
  const afterDown = fingerprint('fingerprint-after-rollback');
  assert.equal(afterDown.has_payee_update, false);
  assert.equal(afterDown.md5, SQL71_SUBMIT_ROLLBACK_MD5);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='aws_public_submit_endorsement'`), '1');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='aws_public_endorsement_by_token'`), '1');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='aws_public_reject_endorsement'`), '1');
  psql(['-d', dbName, '-f', SQL73]);
  const restored = fingerprint('fingerprint-after-restore');
  assert.equal(restored.has_payee_update, true);
  assert.equal(restored.md5, fp1.md5);
  note('sql73 pg validation pass');
});
