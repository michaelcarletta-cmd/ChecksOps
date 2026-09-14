import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
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
const SQL72_DOWN = path.join(ROOT, 'workflows/sql/72_public_endorsement_token_lookup_rollback.sql');
const SQL01 = path.join(ROOT, 'storage/sql/01_public_token_lookup.sql');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CHECK_A = '33333333-3333-4333-8333-333333333333';
const CHECK_B = '44444444-4444-4444-8444-444444444444';
const END_A = '55555555-5555-4555-8555-555555555555';
const END_B = '66666666-6666-4666-8666-666666666666';
const END_PHYS = '77777777-7777-4777-8777-777777777777';
const CHECK_PHYS = '88888888-8888-4888-8888-888888888888';
const PAYEE_PHYS = '99999999-9999-4999-8999-999999999999';
const TOKEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_PHYS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TOKEN_EXPIRED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WRONG = '00000000-0000-4000-8000-000000000000';

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

test('SQL 72 source is endorsement-GET only and does not replay SQL 01', () => {
  const sql72 = fs.readFileSync(SQL72, 'utf8');
  const sql01 = fs.readFileSync(SQL01, 'utf8');
  const down = fs.readFileSync(SQL72_DOWN, 'utf8');
  assert.match(sql72, /CREATE OR REPLACE FUNCTION public\.aws_public_endorsement_by_token\(p_token text\)/);
  assert.match(sql72, /SECURITY DEFINER/);
  assert.match(sql72, /row_security = off/);
  assert.match(sql72, /GRANT EXECUTE ON FUNCTION public\.aws_public_endorsement_by_token\(text\) TO checksops/);
  assert.match(sql72, /REVOKE ALL ON FUNCTION public\.aws_public_endorsement_by_token\(text\) FROM PUBLIC/);
  const sql72Body = sql72.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(sql72Body, /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION[\s\S]*aws_public_signature_by_token_hash/i);
  assert.doesNotMatch(sql72Body, /aws_public_signature_by_token_hash/);
  assert.doesNotMatch(sql72Body, /\btenant_id\b/);
  assert.doesNotMatch(sql72Body, /\bclaim_id\b/);
  assert.match(sql01, /aws_public_signature_by_token_hash/);
  assert.match(down, /DROP FUNCTION IF EXISTS public\.aws_public_endorsement_by_token\(text\)/);
  assert.doesNotMatch(down, /aws_public_submit_endorsement|aws_mark_endorsement_request_sent/);
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
  endorsement_image_path text
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
CREATE POLICY deny_endorsements ON public.check_endorsements FOR ALL TO PUBLIC USING (false);
CREATE POLICY deny_intake ON public.check_intake_items FOR ALL TO PUBLIC USING (false);
GRANT SELECT ON public.check_endorsements TO checksops;
GRANT SELECT ON public.check_intake_items TO checksops;
`;

test('SQL 72 + SQL 71 restore unused-token GET without weakening consume or CC-117', {
  timeout: 180000,
}, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }

  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-sql72-${stamp}-`));
  const port = 55300 + (process.pid % 1000);
  const dbName = `sql72_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `sql72_public_endorsement_pg_${stamp}.log`);
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

  assert.equal(scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='aws_public_endorsement_by_token'`), '1');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='aws_public_signature_by_token_hash'`), '0');
  assert.equal(scalar(`SELECT prosecdef::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='aws_public_endorsement_by_token'`), 'true');
  assert.equal(scalar(`SELECT has_function_privilege('checksops', 'public.aws_public_endorsement_by_token(text)', 'EXECUTE')::text`), 'true');
  assert.equal(scalar(`SELECT has_function_privilege('public', 'public.aws_public_endorsement_by_token(text)', 'EXECUTE')::text`), 'false');
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', 'public.aws_public_endorsement_by_token(text)', 'EXECUTE')::text`), 'false');

  psql(['-d', dbName], `
INSERT INTO public.check_intake_items (id, tenant_id, carrier_name, check_number, amount, status)
VALUES
  ('${CHECK_A}', '${TENANT_A}', 'Acme', '1001', 12.34, 'endorsements_in_progress'),
  ('${CHECK_B}', '${TENANT_B}', 'OtherCo', '2002', 99.00, 'endorsements_in_progress'),
  ('${CHECK_PHYS}', '${TENANT_A}', 'Acme', '3003', 50.00, 'needs_review');
INSERT INTO public.check_endorsements (
  id, check_id, tenant_id, payee_id, payee_name, payee_type, contact_email, status, token, token_expires_at
) VALUES
  ('${END_A}', '${CHECK_A}', '${TENANT_A}', NULL, 'Jane A', 'insured', 'jane@example.com', 'sent', '${TOKEN_A}', NULL),
  ('${END_B}', '${CHECK_B}', '${TENANT_B}', NULL, 'Bob B', 'insured', 'bob@example.com', 'sent', '${TOKEN_B}', NULL),
  ('${END_PHYS}', '${CHECK_PHYS}', '${TENANT_A}', '${PAYEE_PHYS}', 'Pat Physical', 'insured', 'pat@example.com', 'sent', '${TOKEN_PHYS}', NULL),
  (gen_random_uuid(), '${CHECK_A}', '${TENANT_A}', NULL, 'Expired', 'insured', 'exp@example.com', 'sent', '${TOKEN_EXPIRED}', now() - interval '1 hour');
INSERT INTO public.check_payees (id, check_id, tenant_id, payee_name, endorsement_status, endorsement_token)
VALUES ('${PAYEE_PHYS}', '${CHECK_PHYS}', '${TENANT_A}', 'Pat Physical', 'pending', '${TOKEN_PHYS}');
`);

  const asChecksops = (sql) => scalar(`SET ROLE checksops; ${sql}`);

  assert.equal(asChecksops(`SELECT count(*) FROM public.check_endorsements WHERE token = '${TOKEN_A}'`), '0');
  const fresh = JSON.parse(asChecksops(`SELECT public.aws_public_endorsement_by_token('${TOKEN_A}')::text`));
  assert.equal(fresh.id, END_A);
  assert.equal(fresh.payee_name, 'Jane A');
  assert.equal(fresh.status, 'sent');
  assert.equal(fresh.check_number, '1001');
  assert.equal(Number(fresh.amount), 12.34);
  assert.equal(fresh.carrier_name, 'Acme');
  assert.equal(fresh.tenant_id, undefined);
  assert.equal(fresh.claim_id, undefined);

  const jsGet = await runGetEndorsementData({
    query: async (sql, params) => {
      const compact = String(sql);
      if (compact.includes('SAVEPOINT') || compact.includes('RELEASE') || compact.includes('ROLLBACK TO')) {
        return { rows: [], rowCount: 0 };
      }
      if (compact.includes('aws_public_endorsement_by_token')) {
        const doc = JSON.parse(scalar(`SET ROLE checksops; SELECT public.aws_public_endorsement_by_token('${params[0]}')::text`));
        return { rows: [{ doc }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  }, TOKEN_A, {});
  assert.equal(jsGet.ok, true);
  assert.equal(jsGet.statusCode, 200);
  assert.equal(jsGet.payee_name, 'Jane A');
  assert.equal(jsGet.check_number, '1001');

  assert.equal(asChecksops(`SELECT public.aws_public_endorsement_by_token('${WRONG}') IS NULL::text`), 'true');
  assert.equal(asChecksops(`SELECT public.aws_public_endorsement_by_token('   ') IS NULL::text`), 'true');
  assert.equal(asChecksops(`SELECT public.aws_public_endorsement_by_token('${TOKEN_EXPIRED}') IS NULL::text`), 'true');

  const other = JSON.parse(asChecksops(`SELECT public.aws_public_endorsement_by_token('${TOKEN_B}')::text`));
  assert.equal(other.id, END_B);
  assert.equal(other.payee_name, 'Bob B');
  assert.notEqual(other.id, END_A);

  const mismatch = JSON.parse(scalar(`
SELECT public.aws_public_submit_endorsement(
  '${TOKEN_A}', 'data:image/png;base64,aaa', 'consent', '1.1.1.1', 'ua', gen_random_uuid()::text,
  '${CHECK_B}'::uuid, NULL
)::text`));
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, 'check_mismatch');
  assert.equal(asChecksops(`SELECT (public.aws_public_endorsement_by_token('${TOKEN_A}')->>'status')`), 'sent');

  const firstSubmit = JSON.parse(scalar(`
SELECT public.aws_public_submit_endorsement(
  '${TOKEN_A}', 'data:image/png;base64,aaa', 'consent', '1.1.1.1', 'ua', 'rotated-a-1', NULL, NULL
)::text`));
  assert.equal(firstSubmit.ok, true);
  assert.equal(firstSubmit.already_signed, false);
  assert.equal(firstSubmit.status, 'signed');
  assert.equal(asChecksops(`SELECT public.aws_public_endorsement_by_token('${TOKEN_A}') IS NULL::text`), 'true');
  const afterSubmitGet = await runGetEndorsementData({
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
  }, TOKEN_A, {});
  assert.equal(afterSubmitGet.ok, false);
  assert.equal(afterSubmitGet.code, 'token_consumed');

  const secondSubmit = JSON.parse(scalar(`
SELECT public.aws_public_submit_endorsement(
  '${TOKEN_A}', 'data:image/png;base64,aaa', 'consent', '1.1.1.1', 'ua', 'rotated-a-2', NULL, NULL
)::text`));
  assert.equal(secondSubmit.ok, false);
  assert.equal(secondSubmit.error, 'invalid_or_used_token');

  const reject = JSON.parse(scalar(`
SELECT public.aws_public_reject_endorsement('${TOKEN_B}', 'nope', '1.1.1.1', 'ua', 'rotated-b-1')::text`));
  assert.equal(reject.ok, true);
  assert.equal(reject.status, 'rejected');
  assert.equal(asChecksops(`SELECT public.aws_public_endorsement_by_token('${TOKEN_B}') IS NULL::text`), 'true');
  const rejectAgain = JSON.parse(scalar(`
SELECT public.aws_public_reject_endorsement('${TOKEN_B}', 'nope', '1.1.1.1', 'ua', 'rotated-b-2')::text`));
  assert.equal(rejectAgain.ok, false);

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
  const physical = {
    ok: true,
    endorsement_status: scalar(`SELECT status FROM public.check_endorsements WHERE id = '${END_PHYS}'`),
    payee_status: scalar(`SELECT endorsement_status FROM public.check_payees WHERE id = '${PAYEE_PHYS}'`),
    token_rotated: scalar(`SELECT token FROM public.check_endorsements WHERE id = '${END_PHYS}'`) !== TOKEN_PHYS,
  };
  assert.equal(physical.ok, true);
  assert.equal(physical.endorsement_status, 'signed');
  assert.equal(physical.payee_status, 'signed');
  assert.equal(physical.token_rotated, false);
  assert.equal(scalar(`SELECT token FROM public.check_endorsements WHERE id = '${END_PHYS}'`), TOKEN_PHYS);
  const physDoc = JSON.parse(asChecksops(`SELECT public.aws_public_endorsement_by_token('${TOKEN_PHYS}')::text`));
  assert.equal(physDoc.status, 'signed');
  const physGet = await runGetEndorsementData({
    query: async (sql, params) => {
      const compact = String(sql);
      if (compact.includes('SAVEPOINT') || compact.includes('RELEASE') || compact.includes('ROLLBACK TO')) {
        return { rows: [], rowCount: 0 };
      }
      if (compact.includes('aws_public_endorsement_by_token')) {
        const doc = JSON.parse(scalar(`SET ROLE checksops; SELECT public.aws_public_endorsement_by_token('${params[0]}')::text`));
        return { rows: [{ doc }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  }, TOKEN_PHYS, {});
  assert.equal(physGet.ok, false);
  assert.equal(physGet.code, 'token_consumed');

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
  const markedGet = JSON.parse(asChecksops(`SELECT public.aws_public_endorsement_by_token('mark-token')::text`));
  assert.equal(markedGet.status, 'sent');
  const markAgain = JSON.parse(scalar(`
SELECT public.aws_mark_endorsement_request_sent(
  'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'::uuid, 'jane@example.com', 'mark-token'
)::text`));
  assert.equal(markAgain.ok, true);
  assert.equal(markAgain.request_sent_at, mark.request_sent_at);

  const one = asChecksops(`SELECT public.aws_public_endorsement_by_token('mark-token')->>'id'`);
  const two = asChecksops(`SELECT public.aws_public_endorsement_by_token('mark-token')->>'id'`);
  assert.equal(one, two);

  psql(['-d', dbName, '-f', SQL72_DOWN]);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='aws_public_endorsement_by_token'`), '0');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='aws_public_submit_endorsement'`), '1');
  psql(['-d', dbName, '-f', SQL72]);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='aws_public_endorsement_by_token'`), '1');
  note('sql72 pg validation pass');
});
