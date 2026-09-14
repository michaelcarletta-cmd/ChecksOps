import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const ARTIFACT_DIR = '/opt/cursor/artifacts';

const FILES = {
  sql31: path.join(ROOT, 'rls/sql/31_mortgage_ops_agent_access.sql'),
  sql52: path.join(ROOT, 'workflows/sql/52_mortgage_ops_staff_grants.sql'),
  sql39: path.join(ROOT, 'write-path/sql/39_detected_claim_number_grant.sql'),
  sql69: path.join(ROOT, 'workflows/sql/69_staging_homeowner_ledger_view.sql'),
  sql71: path.join(ROOT, 'workflows/sql/71_endorsement_email_audit.sql'),
  sql72: path.join(ROOT, 'workflows/sql/72_public_endorsement_token_lookup.sql'),
  sql73: path.join(ROOT, 'workflows/sql/73_public_endorsement_submit_payee.sql'),
  sql30: path.join(ROOT, 'rls/sql/30_tenant_documents_mortgage_doc_type.sql'),
};

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

const bootstrap = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION public.aws_is_cross_tenant_reader()
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION public.aws_can_access_tenant(_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION public.aws_can_write_tenant(_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION public.aws_is_authenticated()
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

CREATE OR REPLACE FUNCTION public.mortgage_agent_can_view_check(_check_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION public.mortgage_agent_can_view_claim(_claim_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

CREATE TABLE public.tenants (
  id uuid PRIMARY KEY,
  name text
);
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  claim_id uuid,
  detected_claim_number text,
  amount numeric,
  status text,
  check_stage text,
  check_number text
);
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  status text,
  assigned_employee_id uuid,
  accepted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  check_intake_item_id uuid
);
CREATE TABLE public.email_send_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name text,
  recipient_email text,
  tenant_id uuid,
  status text DEFAULT 'pending',
  provider text,
  provider_message_id text,
  idempotency_key text,
  error_message text,
  metadata jsonb,
  message_id text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.check_endorsements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid,
  tenant_id uuid,
  payee_id uuid,
  payee_name text,
  contact_email text,
  status text DEFAULT 'pending',
  token text,
  token_expires_at timestamptz,
  request_sent_at timestamptz,
  reminder_count integer DEFAULT 0,
  last_reminder_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.check_payees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
CREATE TABLE public.homeowner_ledger_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  claim_id uuid,
  token text UNIQUE,
  homeowner_email text,
  homeowner_name text,
  revoked_at timestamptz,
  expires_at timestamptz,
  last_viewed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.homeowner_ledger_check_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  token_id uuid,
  claim_id uuid,
  front_path text,
  status text,
  amount_estimate numeric,
  homeowner_note text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.claims (
  id uuid PRIMARY KEY,
  claim_number text,
  policyholder_address text,
  loss_type text,
  status text,
  created_at timestamptz
);
CREATE TABLE public.homeowner_ledger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  claim_id uuid,
  check_id uuid,
  event_type text,
  occurred_at timestamptz,
  amount numeric,
  actor_label text,
  payload_json jsonb
);

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_handling_requests ENABLE ROW LEVEL SECURITY;
`;

const REPO = path.join(ROOT, '..');
const UNAPPLIED_SQL = [
  '69_staging_homeowner_ledger_view.sql',
  '71_endorsement_email_audit.sql',
  '72_public_endorsement_token_lookup.sql',
  '73_public_endorsement_submit_payee.sql',
];

const applyPattern = (name) => new RegExp(
  String.raw`(?:readSql|applySql)\(\s*['"]${name.replace('.', '\\.')}['"]\s*\)`,
);

test('SQL 71 stays historical, SQL 73 is the final public-submit body, and 69/71/72/73 stay unapplied', () => {
  const sql71 = fs.readFileSync(FILES.sql71, 'utf8');
  const sql72 = fs.readFileSync(FILES.sql72, 'utf8');
  const sql73 = fs.readFileSync(FILES.sql73, 'utf8');
  const down = fs.readFileSync(path.join(ROOT, 'workflows/sql/73_public_endorsement_submit_payee_rollback.sql'), 'utf8');

  assert.match(sql71, /CREATE OR REPLACE FUNCTION public\.aws_public_submit_endorsement\(/);
  assert.doesNotMatch(sql71, /UPDATE public\.check_payees/);
  assert.doesNotMatch(sql71, /sql73_payee_persist_failed/);
  assert.match(sql72, /CREATE OR REPLACE FUNCTION public\.aws_public_endorsement_by_token\(p_token text\)/);
  assert.doesNotMatch(sql72, /CREATE OR REPLACE FUNCTION public\.aws_public_submit_endorsement/);
  assert.doesNotMatch(sql72, /check_payees/);
  assert.match(sql73, /CREATE OR REPLACE FUNCTION public\.aws_public_submit_endorsement\(/);
  assert.match(sql73, /UPDATE public\.check_payees/);
  assert.match(sql73, /sql73_payee_persist_failed/);
  assert.match(down, /CREATE OR REPLACE FUNCTION public\.aws_public_submit_endorsement\(/);
  assert.doesNotMatch(down, /UPDATE public\.check_payees/);

  const thisFile = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const idx71 = thisFile.indexOf("applyTwice('71_endorsement_email_audit'");
  const idx72 = thisFile.indexOf("applyTwice('72_public_endorsement_token_lookup'");
  const idx73 = thisFile.indexOf("applyTwice('73_public_endorsement_submit_payee'");
  assert.ok(idx71 > 0 && idx72 > idx71 && idx73 > idx72, 'coherent preflight must apply 71 → 72 → 73');

  const applyRoots = [
    path.join(ROOT, 'rls/oneshot/completeAuth.mjs'),
    path.join(ROOT, 'rls/oneshot/index.mjs'),
    path.join(ROOT, 'rls/oneshot/writePlan.mjs'),
    path.join(ROOT, 'rls/oneshot/enableRls.mjs'),
    path.join(REPO, 'package.json'),
    path.join(REPO, '.github/workflows/aws-migration-ci.yml'),
  ];
  for (const file of applyRoots) {
    const text = fs.readFileSync(file, 'utf8');
    for (const name of UNAPPLIED_SQL) {
      assert.equal(applyPattern(name).test(text), false, `${path.basename(file)} must not apply ${name}`);
      assert.doesNotMatch(text, new RegExp(String.raw`psql[^\n]*-f[^\n]*${name.replace('.', '\\.')}`));
    }
  }

  const walk = (dir, acc = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'tests') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (/\.(mjs|js|yml|yaml|sh|json)$/.test(entry.name)) acc.push(full);
    }
    return acc;
  };
  const autoApplyHits = [];
  for (const file of [
    ...walk(path.join(REPO, 'scripts')),
    ...walk(path.join(ROOT, 'rls/oneshot')),
    ...walk(path.join(ROOT, 'cutover/scripts')),
    path.join(REPO, '.github/workflows/aws-migration-ci.yml'),
    path.join(REPO, 'package.json'),
  ]) {
    const text = fs.readFileSync(file, 'utf8');
    const idx71Apply = text.search(/71_endorsement_email_audit\.sql/);
    const idx73Apply = text.search(/73_public_endorsement_submit_payee\.sql/);
    if (idx71Apply >= 0 && idx73Apply >= 0 && idx71Apply > idx73Apply) {
      autoApplyHits.push(`${path.relative(REPO, file)} reapplies SQL 71 after SQL 73`);
    }
    for (const name of UNAPPLIED_SQL) {
      if (applyPattern(name).test(text) || new RegExp(String.raw`psql[^\n]*-f[^\n]*${name.replace('.', '\\.')}`).test(text)) {
        autoApplyHits.push(`${path.relative(REPO, file)} auto-applies ${name}`);
      }
    }
  }
  assert.deepEqual(autoApplyHits, []);
});

test('SQL 31/52/39/69/71/72/73 apply twice on disposable PG16 and keep SQL 30 unapplied', {
  timeout: 180000,
}, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }
  for (const [name, file] of Object.entries(FILES)) {
    if (name === 'sql30') continue;
    assert.equal(fs.existsSync(file), true, name);
  }

  const sql31 = fs.readFileSync(FILES.sql31, 'utf8');
  const sql52 = fs.readFileSync(FILES.sql52, 'utf8');
  const sql39 = fs.readFileSync(FILES.sql39, 'utf8');
  const sql71 = fs.readFileSync(FILES.sql71, 'utf8');
  assert.match(sql31, /CREATE OR REPLACE FUNCTION public\.aws_mortgage_agent_queue_visible/);
  assert.match(sql31, /DROP POLICY IF EXISTS aws_select_mortgage_handling_requests/);
  assert.match(sql52, /GRANT UPDATE \(\s*assigned_employee_id/);
  assert.match(sql39, /GRANT UPDATE \(detected_claim_number\)/);
  assert.match(sql71, /aws_email_send_log_peek/);
  assert.match(sql71, /aws_email_send_log_reserve/);
  assert.match(sql71, /aws_email_send_log_finalize/);
  assert.doesNotMatch(sql31, /DROP FUNCTION public\.aws_can_access_tenant/);
  assert.doesNotMatch(sql52, /claim_payments|payment_transfers/);
  assert.doesNotMatch(sql39, /GRANT UPDATE \(amount\)|GRANT UPDATE \(claim_id\)/);

  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-coherent-sql-${stamp}-`));
  const port = 55200 + (process.pid % 1000);
  const dbName = `coherent_sql_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `coherent_sql_preflight_pg_${stamp}.log`);
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
  const scalar = (sql) => psql(['-d', dbName, '-A', '-t', '-c', sql]).stdout.trim();

  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);
  psql(['-d', dbName, '-c', 'CREATE ROLE checksops NOLOGIN']);
  psql(['-d', dbName, '-f', path.join(ROOT, 'rls/sql/01_role_shim.sql')]);
  psql(['-d', dbName, '-f', path.join(ROOT, 'identity/sql/02_auth_uid_guc.sql')]);
  psql(['-d', dbName, '-c', "CREATE TYPE public.app_role AS ENUM ('admin','owner','member','mortgage_agent')"]);
  psql(['-d', dbName], bootstrap);

  const applyTwice = (label, file) => {
    note(`apply ${label}`);
    psql(['-d', dbName, '-f', file]);
    psql(['-d', dbName, '-f', file]);
  };

  applyTwice('31_mortgage_ops_agent_access', FILES.sql31);
  applyTwice('52_mortgage_ops_staff_grants', FILES.sql52);
  applyTwice('39_detected_claim_number_grant', FILES.sql39);
  applyTwice('69_staging_homeowner_ledger_view', FILES.sql69);
  applyTwice('71_endorsement_email_audit', FILES.sql71);
  applyTwice('72_public_endorsement_token_lookup', FILES.sql72);
  applyTwice('73_public_endorsement_submit_payee', FILES.sql73);

  const functions = scalar(`
SELECT string_agg(p.proname, ',' ORDER BY p.proname)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'aws_mortgage_agent_queue_visible',
    'aws_mortgage_agent_can_see_tenant',
    'aws_mortgage_agent_can_see_check',
    'aws_public_homeowner_ledger_bundle',
    'aws_public_homeowner_ledger_mint_sign_link',
    'aws_public_homeowner_ledger_upload_insert',
    'aws_email_send_log_peek',
    'aws_email_send_log_reserve',
    'aws_email_send_log_finalize',
    'aws_mark_endorsement_request_sent',
    'aws_public_submit_endorsement',
    'aws_public_reject_endorsement',
    'aws_public_endorsement_by_token',
    'aws_public_signature_by_token_hash'
  )
`);
  note(`functions ${functions}`);
  for (const name of [
    'aws_mortgage_agent_queue_visible',
    'aws_email_send_log_peek',
    'aws_email_send_log_reserve',
    'aws_email_send_log_finalize',
    'aws_public_submit_endorsement',
    'aws_public_homeowner_ledger_bundle',
    'aws_public_endorsement_by_token',
  ]) {
    assert.match(functions, new RegExp(name));
  }
  assert.doesNotMatch(functions || '', /aws_public_signature_by_token_hash/);
  assert.equal(scalar(`SELECT has_function_privilege('checksops', 'public.aws_public_endorsement_by_token(text)', 'EXECUTE')::text`), 'true');
  assert.equal(scalar(`SELECT has_function_privilege('public', 'public.aws_public_endorsement_by_token(text)', 'EXECUTE')::text`), 'false');
  assert.equal(scalar(`SELECT has_function_privilege('checksops', 'public.aws_public_submit_endorsement(text,text,text,text,text,text,uuid,uuid)', 'EXECUTE')::text`), 'true');
  assert.equal(scalar(`SELECT has_function_privilege('public', 'public.aws_public_submit_endorsement(text,text,text,text,text,text,uuid,uuid)', 'EXECUTE')::text`), 'false');
  assert.equal(scalar(`
SELECT (p.prosrc ILIKE '%UPDATE public.check_payees%'
        AND p.prosrc ILIKE '%sql73_payee_persist_failed%')::text
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'aws_public_submit_endorsement'
`), 'true');
  note('SQL 73 is the live aws_public_submit_endorsement body after 71→72→73');

  const claimGrant = scalar(`
SELECT count(*)::text
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name = 'check_intake_items'
  AND column_name = 'detected_claim_number'
  AND grantee = 'checksops'
  AND privilege_type = 'UPDATE'
`);
  assert.equal(claimGrant, '1');

  const amountGrant = scalar(`
SELECT count(*)::text
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name = 'check_intake_items'
  AND column_name = 'amount'
  AND grantee = 'checksops'
  AND privilege_type = 'UPDATE'
`);
  assert.equal(amountGrant, '0');

  const sql30Applied = scalar(`
SELECT count(*)::text
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
WHERE t.relname = 'tenant_documents'
  AND c.conname = 'tenant_documents_doc_type_check'
`);
  assert.equal(sql30Applied, '0');

  const policies = scalar(`
SELECT string_agg(policyname, ',' ORDER BY policyname)
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    policyname LIKE 'aws_%mortgage%'
    OR policyname LIKE 'aws_select_%'
    OR policyname LIKE 'aws_insert_mortgage%'
    OR policyname LIKE 'aws_update_mortgage%'
    OR policyname LIKE 'aws_delete_mortgage%'
  )
`);
  note(`policies ${policies}`);
  assert.match(policies || '', /aws_select_mortgage_handling_requests/);
  assert.match(policies || '', /aws_update_mortgage_handling_requests/);
});
