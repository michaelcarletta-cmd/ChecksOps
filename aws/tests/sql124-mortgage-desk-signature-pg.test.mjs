/**
 * SQL 124 (the Mortgage Desk sends a check's document for signature, reads the check, posts
 * homeowner timeline updates) against PostgreSQL 16: the real AWS RLS helper files (through the
 * shared stakeholder fixture), the real check_messages / check_files / mortgage_handling_requests /
 * signature_requests / signature_signers / signature_fields / esign_event_logs policies (12, 24,
 * SQL 50, SQL 90, SQL 100), SQL 99, SQL 122, then
 * aws/workflows/sql/124_mortgage_desk_signature_and_reads.sql applied by a non-superuser login that
 * owns the Desk, check and e-sign tables (like checksops_admin).
 *
 * The functions are called as the API will call them (a later, separate change): checksops, RLS
 * on, request.app_user_id set, one committed transaction per request.
 *
 *   - the file refuses a login that does not own the tables it reads and writes, and is idempotent;
 *   - the assigned agent (and the platform owner) reads the check's thread (from_desk marked,
 *     deleted messages left out), files and signature requests (no token columns); another agent,
 *     the tenant's member and another tenant's member are refused; the storage-read check answers
 *     only for that check's files and the Desk upload prefix;
 *   - the agent creates a draft signature request on a .pdf / .docx of the check (signers in order,
 *     token hashes as esign.mjs computes them, the fields, the check file linked, the event log);
 *     every malformed input is the function's own error; a repeat, a reused token or field id and
 *     the eleventh request in 24 hours are refused; the tenant member reads it, another tenant
 *     does not; agents still cannot write signature_requests directly;
 *   - the agent records the email sends once, as esign.mjs does (partial failure, all sent); a
 *     request not created through the Desk request, not on its check or no longer a draft is
 *     refused;
 *   - the agent posts follow-ups and updates on the homeowner timeline (never mortgage_request_id);
 *   - once completed: reads and the delivery record still work; create and timeline posts stop.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, applyBaseSchema, pgSkipReason, policyBlock, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { executeSafeWriteRpc } from '../functions/api/workflow-rpc.mjs';

const SQL_50 = path.join(AWS_ROOT, 'workflows/sql/50_tranche5_write_grants.sql');
const SQL_90 = path.join(AWS_ROOT, 'workflows/sql/90_users_only_tenant_roles.sql');
const SQL_99 = path.join(AWS_ROOT, 'workflows/sql/99_mortgage_desk_completion_messages.sql');
const SQL_100 = path.join(AWS_ROOT, 'workflows/sql/100_mortgage_desk_live_access.sql');
const SQL_122 = path.join(AWS_ROOT, 'workflows/sql/122_mortgage_desk_return_to_tenant.sql');
const SQL_124 = path.join(AWS_ROOT, 'workflows/sql/124_mortgage_desk_signature_and_reads.sql');

const sliceFrom = (file, start, end) => {
  const text = fs.readFileSync(file, 'utf8');
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${start} not found in ${file}`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `${end} not found after ${start} in ${file}`);
  return text.slice(from, to + end.length);
};

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const MEMBER = 'a1000000-0000-4000-8000-000000000001';
const MEMBER_B = 'a1000000-0000-4000-8000-000000000002';
const AGENT = 'a1000000-0000-4000-8000-000000000003';
const OTHER_AGENT = 'a1000000-0000-4000-8000-000000000004';
const OWNER = 'a1000000-0000-4000-8000-00000000000b';
const CHECK_1 = 'c1000000-0000-4000-8000-000000000001';
const CHECK_B = 'c1000000-0000-4000-8000-000000000002';
const CLAIM_1 = 'e1000000-0000-4000-8000-000000000001';
const REQ_1 = 'd1000000-0000-4000-8000-000000000001';
const REQ_B = 'd1000000-0000-4000-8000-000000000002';
const REQ_NEW = 'd1000000-0000-4000-8000-000000000003';
const MISSING = 'd1000000-0000-4000-8000-0000000000ff';
const DESK_PDF = `checks/${CHECK_1}/mortgage-ops/1700000000000-payoff.pdf`;
const TENANT_DOCX = `claims/${CLAIM_1}/contract.docx`;
const PHOTO = `checks/${CHECK_1}/photo.png`;
const B_PDF = `checks/${CHECK_B}/mortgage-ops/b.pdf`;

const SCHEMA = `
CREATE TABLE public.recipient_tax_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, recipient_key text NOT NULL, tin text);
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE sql124_outsider LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin, sql124_outsider;
GRANT USAGE ON SCHEMA auth TO checksops_admin, sql124_outsider;
ALTER TABLE public.check_intake_items ADD COLUMN check_number text;
ALTER TABLE public.tenants ADD COLUMN slug text, ADD COLUMN company_email text;
CREATE TABLE public.check_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  check_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  body text NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 5000),
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_files (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  check_intake_item_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  file_name text NOT NULL, file_path text NOT NULL, file_type text, file_size bigint,
  category text NOT NULL DEFAULT 'other', source text NOT NULL DEFAULT 'manual',
  signature_request_id uuid, uploaded_by uuid REFERENCES public.identity_accounts(application_user_id),
  description text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid, claim_id uuid,
  mortgage_company text, mortgage_servicer text, loan_number text, note text, work_notes text,
  property_address text, claim_number text, insurance_company text,
  homeowner_name text, homeowner_email text, homeowner_phone text, requested_by uuid,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'in_progress', 'completed', 'cancelled')),
  assigned_employee_id uuid,
  accepted_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  mail_to_name text, mail_to_address text, shipping_label_path text, shipping_label_name text,
  shipping_label_carrier text, shipping_label_tracking text, shipping_label_uploaded_at timestamptz,
  shipping_label_uploaded_by uuid, check_sent_date timestamptz, check_received_back_date timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.homeowner_ledger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, claim_id uuid NOT NULL,
  check_id uuid, event_type text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  amount numeric(12,2), actor_label text, payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
-- The e-sign tables (Supabase-era shapes, trimmed to what SQL 124 uses); the shared fixture's
-- signature_requests stub gains its columns.
ALTER TABLE public.signature_requests
  ADD COLUMN document_name text, ADD COLUMN document_path text, ADD COLUMN document_type text, ADD COLUMN field_data jsonb,
  ADD COLUMN status text NOT NULL DEFAULT 'draft', ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN created_by uuid,
  ADD COLUMN sent_at timestamptz, ADD COLUMN final_pdf_path text, ADD COLUMN delivery_mode text, ADD COLUMN provider_status text,
  ADD COLUMN last_error text, ADD COLUMN last_attempted_at timestamptz;
CREATE TABLE public.signature_signers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signature_request_id uuid NOT NULL REFERENCES public.signature_requests(id) ON DELETE CASCADE,
  signer_name text NOT NULL, signer_email text NOT NULL,
  signer_type text NOT NULL DEFAULT 'policyholder'
    CONSTRAINT valid_signer_type CHECK (signer_type IN ('policyholder', 'contractor', 'public_adjuster', 'mortgage_company', 'other')),
  signing_order integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'pending',
  signed_at timestamptz, viewed_at timestamptz, access_token text UNIQUE, token_hash text, expires_at timestamptz,
  delivery_status text, delivery_error text, email_sent_at timestamptz, email_provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.signature_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signature_request_id uuid NOT NULL REFERENCES public.signature_requests(id) ON DELETE CASCADE,
  signer_index integer NOT NULL DEFAULT 0, field_type text NOT NULL, label text, page integer NOT NULL DEFAULT 1,
  x numeric NOT NULL DEFAULT 0, y numeric NOT NULL DEFAULT 0, width numeric NOT NULL DEFAULT 33, height numeric NOT NULL DEFAULT 6,
  required boolean NOT NULL DEFAULT true, placeholder text, checkbox_label text);
CREATE TABLE public.esign_event_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(),
  request_id uuid REFERENCES public.signature_requests(id) ON DELETE SET NULL, signer_id uuid, claim_id uuid,
  stage text NOT NULL, status text NOT NULL, message text, payload jsonb);
-- checksops_admin owns the tables it reads and writes, as in production.
ALTER TABLE public.check_messages OWNER TO checksops_admin;
ALTER TABLE public.check_files OWNER TO checksops_admin;
ALTER TABLE public.mortgage_handling_requests OWNER TO checksops_admin;
ALTER TABLE public.homeowner_ledger_events OWNER TO checksops_admin;
ALTER TABLE public.check_intake_items OWNER TO checksops_admin;
ALTER TABLE public.tenants OWNER TO checksops_admin;
ALTER TABLE public.tenant_users OWNER TO checksops_admin;
ALTER TABLE public.identity_accounts OWNER TO checksops_admin;
ALTER TABLE public.signature_requests OWNER TO checksops_admin;
ALTER TABLE public.signature_signers OWNER TO checksops_admin;
ALTER TABLE public.signature_fields OWNER TO checksops_admin;
ALTER TABLE public.esign_event_logs OWNER TO checksops_admin;
-- aws/write-path/sql/35_tranche3_write_grants.sql and SQL 67.
GRANT SELECT, INSERT, DELETE ON TABLE public.check_messages TO checksops, authenticated;
GRANT UPDATE (is_deleted, updated_at) ON TABLE public.check_messages TO checksops, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.check_files TO checksops, authenticated;
GRANT SELECT, INSERT ON TABLE public.homeowner_ledger_events TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.signature_requests, public.signature_signers, public.signature_fields, public.esign_event_logs
  TO checksops, authenticated;
ALTER TABLE public.check_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_handling_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.homeowner_ledger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_signers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_event_logs ENABLE ROW LEVEL SECURITY;
`;

const SEED = `
INSERT INTO public.tenants (id, name, slug, company_email) VALUES
  ('${TENANT_A}', 'Freedom', 'freedom', 'office@freedom.test'), ('${TENANT_B}', 'Other', 'other', NULL);
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
  ('${MEMBER}', 'requester@freedom.test', 'active'), ('${MEMBER_B}', 'b@other.test', 'active'),
  ('${AGENT}', 'agent@checksops.test', 'active'), ('${OTHER_AGENT}', 'agent2@checksops.test', 'active'),
  ('${OWNER}', 'checksopsadmin@gmail.com', 'active');
INSERT INTO public.profiles (id, email) SELECT application_user_id, email FROM public.identity_accounts;
INSERT INTO public.user_roles (user_id, role) VALUES ('${AGENT}', 'mortgage_agent'), ('${OTHER_AGENT}', 'mortgage_agent');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${TENANT_A}', '${MEMBER}', 'owner'), ('${TENANT_B}', '${MEMBER_B}', 'owner');
INSERT INTO public.claims (id, org_id) VALUES ('${CLAIM_1}', '${TENANT_A}');
INSERT INTO public.check_intake_items (id, tenant_id, claim_id, check_number) VALUES
  ('${CHECK_1}', '${TENANT_A}', '${CLAIM_1}', '100234'), ('${CHECK_B}', '${TENANT_B}', NULL, '9');
INSERT INTO public.mortgage_handling_requests
  (id, tenant_id, check_intake_item_id, claim_id, mortgage_company, status, assigned_employee_id, accepted_at, requested_by)
VALUES
  ('${REQ_1}', '${TENANT_A}', '${CHECK_1}', '${CLAIM_1}', 'Acme Mortgage', 'in_progress', '${AGENT}', now(), '${MEMBER}'),
  ('${REQ_B}', '${TENANT_B}', '${CHECK_B}', NULL, 'B Bank', 'in_progress', '${OTHER_AGENT}', now(), '${MEMBER_B}'),
  ('${REQ_NEW}', '${TENANT_A}', '${CHECK_1}', '${CLAIM_1}', 'Acme Mortgage', 'requested', '${AGENT}', NULL, '${MEMBER}');
-- The tenant's own files and thread on the check (and one on tenant B's check), oldest first.
INSERT INTO public.check_files (check_intake_item_id, file_name, file_path, file_type, category, source, uploaded_by, created_at) VALUES
  ('${CHECK_1}', 'contract.docx', '${TENANT_DOCX}?X-Amz-Signature=abc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
   'contract', 'manual', '${MEMBER}', now() - interval '3 hours'),
  ('${CHECK_1}', 'photo.png', '${PHOTO}', 'image/png', 'other', 'manual', '${MEMBER}', now() - interval '2 hours'),
  ('${CHECK_B}', 'b.pdf', '${B_PDF}', 'application/pdf', 'other', 'manual', '${MEMBER_B}', now() - interval '2 hours');
INSERT INTO public.check_messages (check_id, sender_id, body, is_deleted, created_at) VALUES
  ('${CHECK_1}', '${MEMBER}', 'Please call Acme', false, now() - interval '3 hours'),
  ('${CHECK_1}', '${MEMBER}', 'deleted note', true, now() - interval '150 minutes');
`;

const tokenHash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const token = () => randomBytes(32).toString('hex');
const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

test('PostgreSQL 16: SQL 124 lets the assigned agent read the check and send its document for signature, and no one else', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql124-desk-', 63200);
  const open = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const client = await open('ubuntu');
  const clients = [client];
  try {
    await applyBaseSchema(client);
    await client.query(SCHEMA);
    for (const [file, name] of [
      ['12_final_select_policies.sql', 'aws_select_check_messages'], ['24_complete_write_policies.sql', 'aws_write_check_messages'],
      ['12_final_select_policies.sql', 'aws_select_check_files'], ['24_complete_write_policies.sql', 'aws_write_check_files'],
      ['12_final_select_policies.sql', 'aws_select_mortgage_handling_requests'], ['24_complete_write_policies.sql', 'aws_write_mortgage_handling_requests'],
      ['12_final_select_policies.sql', 'aws_select_signature_requests'], ['24_complete_write_policies.sql', 'aws_write_signature_requests'],
      ['12_final_select_policies.sql', 'aws_select_signature_signers'], ['12_final_select_policies.sql', 'aws_select_signature_fields'],
      ['12_final_select_policies.sql', 'aws_select_esign_event_logs'], ['24_complete_write_policies.sql', 'aws_write_esign_event_logs'],
    ]) {
      await client.query(policyBlock(file, name));
    }
    await client.query(sliceFrom(SQL_50,
      'GRANT SELECT, INSERT, DELETE ON TABLE public.mortgage_handling_requests',
      ') ON TABLE public.mortgage_handling_requests TO checksops, authenticated;'));
    await client.query(fs.readFileSync(SQL_90, 'utf8'));
    await client.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO checksops_admin');
    await client.query(SEED);

    const owner = await open('checksops_admin');
    clients.push(owner);
    await owner.query(fs.readFileSync(SQL_100, 'utf8'));
    await owner.query(fs.readFileSync(SQL_99, 'utf8'));
    await owner.query(fs.readFileSync(SQL_122, 'utf8'));
    const sql124 = fs.readFileSync(SQL_124, 'utf8');

    // Refuses when the applying login does not own the tables it reads and writes; nothing is left behind.
    const outsider = await open('sql124_outsider');
    clients.push(outsider);
    await assert.rejects(outsider.query(sql124),
      (error) => error.code === '55000' && /sql124_definer_cannot_write/.test(error.message));
    const names = ['aws_mortgage_desk_readable_request', 'aws_mortgage_desk_messages', 'aws_mortgage_desk_check_files',
      'aws_mortgage_desk_signature_requests', 'aws_mortgage_desk_can_read_path', 'aws_mortgage_desk_create_signature_request',
      'aws_mortgage_desk_record_signature_delivery', 'aws_mortgage_desk_post_timeline'];
    assert.equal((await client.query('SELECT count(*)::int AS n FROM pg_proc WHERE proname = ANY($1::text[])', [names])).rows[0].n, 0);

    // Apply twice as the owning login: idempotent.
    await owner.query(sql124);
    await owner.query(sql124);

    const fns = (await client.query(
      `SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])
        ORDER BY p.proname`, [names],
    )).rows;
    assert.deepEqual(fns.map((f) => [f.proname, f.prosecdef, f.owner, f.checksops_exec, f.authenticated_exec]), [
      ['aws_mortgage_desk_can_read_path', true, 'checksops_admin', true, false],
      ['aws_mortgage_desk_check_files', true, 'checksops_admin', true, false],
      ['aws_mortgage_desk_create_signature_request', true, 'checksops_admin', true, false],
      ['aws_mortgage_desk_messages', true, 'checksops_admin', true, false],
      ['aws_mortgage_desk_post_timeline', true, 'checksops_admin', true, false],
      ['aws_mortgage_desk_readable_request', true, 'checksops_admin', false, false],
      ['aws_mortgage_desk_record_signature_delivery', true, 'checksops_admin', true, false],
      ['aws_mortgage_desk_signature_requests', true, 'checksops_admin', true, false],
    ]);
    for (const f of fns) assert.deepEqual(f.proconfig, ['search_path=public'], f.proname);

    /** One API request: a committed transaction as checksops (RLS on) for this user. */
    const as = async (user, fn) => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE checksops');
        await client.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        const out = await fn();
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };
    const rows = (user, sql, params) => as(user, async () => (await client.query(sql, params)).rows);
    const one = async (user, sql, params) => (await rows(user, sql, params))[0];
    const messages = (user, req) => rows(user, 'SELECT * FROM public.aws_mortgage_desk_messages($1::uuid)', [req]);
    const files = (user, req) => rows(user, 'SELECT * FROM public.aws_mortgage_desk_check_files($1::uuid)', [req]);
    const sigs = async (user, req) => (await one(user, 'SELECT public.aws_mortgage_desk_signature_requests($1::uuid) AS out', [req])).out;
    const canRead = async (user, candidates, rel) => (await one(user, 'SELECT public.aws_mortgage_desk_can_read_path($1::text[], $2::text) AS ok', [candidates, rel])).ok;
    const create = async (user, req, input) => (await one(user,
      'SELECT public.aws_mortgage_desk_create_signature_request($1::uuid, $2::text, $3::text, $4::text, $5::jsonb, $6::jsonb, $7::timestamptz) AS out',
      [req, input.name ?? 'Payoff authorization', input.path ?? DESK_PDF, input.type ?? null,
        input.fields === undefined ? null : JSON.stringify(input.fields), input.signers === undefined ? null : JSON.stringify(input.signers),
        input.expires ?? hoursAhead(48)])).out;
    const deliver = async (user, req, sigId, results) => (await one(user,
      'SELECT public.aws_mortgage_desk_record_signature_delivery($1::uuid, $2::uuid, $3::jsonb) AS out', [req, sigId, JSON.stringify(results)])).out;
    const timeline = async (user, req, kind, note) => (await one(user,
      'SELECT public.aws_mortgage_desk_post_timeline($1::uuid, $2::text, $3::text) AS id', [req, kind, note])).id;
    const refused = (promise, code, message) => assert.rejects(promise, (error) => error.code === code && message.test(error.message),
      `${code} ${message}`);

    // --- Reads. The agent's own Desk note and upload (SQL 122), then the reads.
    await one(AGENT, 'SELECT * FROM public.aws_mortgage_desk_post_message($1::uuid, $2::text)', [REQ_1, 'Called Acme, payoff letter requested']);
    await one(AGENT, 'SELECT * FROM public.aws_mortgage_desk_attach_file($1::uuid, $2::text, $3::text, $4::text, $5::bigint, $6::text, $7::text)',
      [REQ_1, 'payoff.pdf', DESK_PDF, 'application/pdf', 2048, 'mortgage_ops', 'Payoff letter']);
    const thread = await messages(AGENT, REQ_1);
    assert.deepEqual(thread.map((m) => [m.body, m.sender_id, m.from_desk]), [
      ['Please call Acme', MEMBER, false],
      ['Called Acme, payoff letter requested', AGENT, true],
    ]);
    const fileRows = await files(AGENT, REQ_1);
    assert.deepEqual(fileRows.map((f) => [f.file_name, f.source, f.signature_request_id]), [
      ['contract.docx', 'manual', null], ['photo.png', 'manual', null], ['payoff.pdf', 'mortgage_ops', null],
    ]);
    assert.deepEqual(Object.keys(fileRows[0]).sort(), ['category', 'created_at', 'description', 'file_name', 'file_path', 'file_size',
      'file_type', 'id', 'signature_request_id', 'source']);
    assert.deepEqual(await sigs(AGENT, REQ_1), []);
    // The platform owner reads any Desk request; tenant B's files are never on tenant A's request.
    assert.deepEqual((await files(OWNER, REQ_B)).map((f) => f.file_name), ['b.pdf']);
    assert.equal((await messages(OWNER, REQ_1)).length, 2);
    for (const user of [OTHER_AGENT, MEMBER, MEMBER_B]) {
      await refused(messages(user, REQ_1), '42501', /not_assigned_to_you/);
      await refused(files(user, REQ_1), '42501', /not_assigned_to_you/);
      await refused(sigs(user, REQ_1), '42501', /not_assigned_to_you/);
    }
    await refused(messages(AGENT, MISSING), '42501', /not_authorized/);
    await refused(files(AGENT, REQ_NEW), '42501', /request_not_in_status/);
    // The readable-request check itself is not callable by the API login.
    await refused(rows(AGENT, 'SELECT * FROM public.aws_mortgage_desk_readable_request($1::uuid)', [REQ_1]), '42501', /permission denied/);
    // Agents still read none of the check's rows directly.
    assert.equal((await one(AGENT, 'SELECT count(*)::int AS n FROM public.check_files WHERE check_intake_item_id = $1', [CHECK_1])).n, 0);

    // --- The storage-read check: that check's files (query string stripped), the Desk upload prefix, nothing else.
    assert.equal(await canRead(AGENT, [], DESK_PDF), true);
    assert.equal(await canRead(AGENT, [], TENANT_DOCX), true);
    assert.equal(await canRead(AGENT, ['nope', `checks/${CHECK_1}/mortgage-ops/new.pdf`], 'other'), true);
    assert.equal(await canRead(OWNER, [], B_PDF), true);
    for (const rel of [B_PDF, `checks/${CHECK_1}/mortgage-ops/a/b.pdf`, `checks/${CHECK_1}/mortgage-ops/..`, `checks/${CHECK_1}/mortgage-ops/`,
      `checks/${CHECK_1}/other.pdf`, '', null]) {
      assert.equal(await canRead(AGENT, [], rel), false, String(rel));
    }
    for (const user of [OTHER_AGENT, MEMBER, MEMBER_B]) assert.equal(await canRead(user, [], DESK_PDF), false, user);

    // --- Create: every malformed input is the function's own error.
    const signers = () => [
      { signer_name: 'Pat Homeowner', signer_email: 'pat@home.test', signer_type: 'policyholder', signing_order: 1, access_token: token() },
      { signer_name: 'Freedom Roofing', signer_email: 'office@freedom.test', signer_type: 'contractor', access_token: token() },
    ];
    const fields = () => [
      { id: randomUUID(), type: 'signature', signerIndex: 0, page: 1, x: 10, y: 20, width: 30, height: 5, label: 'Homeowner' },
      { type: 'signature', signerIndex: 1, page: 2 },
      { type: 'date', signerIndex: 0, required: false, placeholder: 'Date' },
    ];
    const ok = { signers: signers(), fields: fields(), type: 'payment_authorization' };
    const bad = async (over, code, message) => refused(create(AGENT, REQ_1, { ...ok, signers: signers(), fields: fields(), ...over }), code, message);
    for (const p of [B_PDF, PHOTO, `checks/${CHECK_1}/mortgage-ops/../1700000000000-payoff.pdf`, '', 'x'.repeat(513) + '.pdf']) {
      await bad({ path: p }, '42501', /document_not_on_check/);
    }
    await bad({ name: '  ' }, '22023', /invalid_document_name/);
    await bad({ name: 'a\u0007b' }, '22023', /invalid_document_name/);
    await bad({ type: 'w9' }, '22023', /invalid_document_type/);
    await bad({ signers: [] }, '22023', /invalid_signers/);
    await bad({ signers: [...signers(), ...signers(), signers()[0]] }, '22023', /invalid_signers/);
    await bad({ signers: { a: 1 } }, '22023', /invalid_signers/);
    const s = signers();
    await bad({ signers: [{ ...s[0], signer_email: 'not-an-email' }, s[1]] }, '22023', /invalid_signer: 1/);
    await bad({ signers: [{ ...s[0], signer_type: 'mortgage_company' }, s[1]] }, '22023', /invalid_signer: 1/);
    await bad({ signers: [{ ...s[0], signing_order: 2 }, s[1]] }, '22023', /invalid_signer: 1/);
    await bad({ signers: [s[0], { ...s[1], signing_order: '2' }] }, '22023', /invalid_signer: 2/);
    await bad({ signers: [{ ...s[0], access_token: 'ABC' }, s[1]] }, '22023', /invalid_signer: 1/);
    await bad({ signers: [s[0], { ...s[1], access_token: s[0].access_token }] }, '22023', /invalid_signer: 2/);
    await bad({ signers: [{ ...s[0], role: 'admin' }, s[1]] }, '22023', /invalid_signer: 1/);
    await bad({ fields: { type: 'signature' } }, '22023', /invalid_field_data/);
    await bad({ fields: [...fields(), { type: 'stamp' }] }, '22023', /invalid_field_data: 4/);
    await bad({ fields: [...fields(), { type: 'text', signerIndex: 2 }] }, '22023', /invalid_field_data: 4/);
    await bad({ fields: [...fields(), { type: 'text', page: 0 }] }, '22023', /invalid_field_data: 4/);
    await bad({ fields: [...fields(), { type: 'text', x: '10' }] }, '22023', /invalid_field_data: 4/);
    await bad({ fields: [fields()[0], fields()[2]] }, '22023', /missing_signature_field: 2/);
    await bad({ expires: hoursAhead(73) }, '22023', /invalid_expires_at/);
    await bad({ expires: hoursAhead(-1) }, '22023', /invalid_expires_at/);
    for (const user of [OTHER_AGENT, MEMBER, MEMBER_B]) {
      await refused(create(user, REQ_1, ok), '42501', /not_assigned_to_you/);
    }
    await refused(create(AGENT, REQ_NEW, ok), '42501', /request_not_in_status/);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM public.signature_requests')).rows[0].n, 0);

    // --- Create: one draft request with its signers, fields, the linked check file and the event log.
    const created = await create(AGENT, REQ_1, ok);
    const sigId = created.signature_request_id;
    assert.deepEqual(Object.keys(created).sort(), ['signature_request_id', 'signers']);
    assert.deepEqual(created.signers.map((x) => Object.keys(x).sort()), [['id', 'signer_email', 'signer_name'], ['id', 'signer_email', 'signer_name']]);
    assert.deepEqual(created.signers.map((x) => x.signer_name), ['Pat Homeowner', 'Freedom Roofing']);
    const request = (await client.query('SELECT * FROM public.signature_requests WHERE id = $1', [sigId])).rows[0];
    assert.deepEqual([request.claim_id, request.check_intake_item_id, request.document_name, request.document_path, request.document_type,
      request.status, request.created_by, request.sent_at],
    [CLAIM_1, CHECK_1, 'Payoff authorization', DESK_PDF, 'payment_authorization', 'draft', AGENT, null]);
    assert.deepEqual(request.field_data, ok.fields);
    const signerRows = (await client.query('SELECT * FROM public.signature_signers WHERE signature_request_id = $1 ORDER BY signing_order', [sigId])).rows;
    assert.deepEqual(signerRows.map((x) => [x.signing_order, x.signer_type, x.status, x.access_token, x.token_hash]),
      ok.signers.map((x, i) => [i + 1, x.signer_type, 'pending', x.access_token, tokenHash(x.access_token)]));
    assert.deepEqual(signerRows.map((x) => x.id), created.signers.map((x) => x.id));
    const fieldRows = (await client.query('SELECT * FROM public.signature_fields WHERE signature_request_id = $1 ORDER BY signer_index, page, field_type', [sigId])).rows;
    assert.deepEqual(fieldRows.map((f) => [f.signer_index, f.field_type, f.page, Number(f.width), Number(f.height), f.required, f.label, f.placeholder]), [
      [0, 'date', 1, 33, 6, false, null, 'Date'],
      [0, 'signature', 1, 30, 5, true, 'Homeowner', null],
      [1, 'signature', 2, 33, 6, true, null, null],
    ]);
    assert.ok(fieldRows.some((f) => f.id === ok.fields[0].id), 'a uuid field id is kept');
    assert.deepEqual((await files(AGENT, REQ_1)).map((f) => [f.file_name, f.signature_request_id]),
      [['contract.docx', null], ['photo.png', null], ['payoff.pdf', sigId]]);
    const created1 = (await client.query("SELECT * FROM public.esign_event_logs WHERE request_id = $1 AND stage = 'mortgage_desk_request_created'", [sigId])).rows;
    assert.equal(created1.length, 1);
    assert.deepEqual([created1[0].claim_id, created1[0].status, created1[0].payload.source, created1[0].payload.mortgage_request_id, created1[0].payload.application_user_id],
      [CLAIM_1, 'ok', 'mortgage_desk', REQ_1, AGENT]);
    // A repeat, a reused token and a reused field id are refused.
    await refused(create(AGENT, REQ_1, { ...ok, signers: signers(), fields: fields() }), '42501', /duplicate_signature_request/);
    await refused(create(AGENT, REQ_1, { ...ok, path: TENANT_DOCX, signers: [ok.signers[0], signers()[1]], fields: fields() }), '22023', /invalid_signer: 1/);
    await refused(create(AGENT, REQ_1, { ...ok, path: TENANT_DOCX, signers: signers(), fields: [ok.fields[0], fields()[1]] }), '22023', /invalid_field_data: 1/);

    // The Desk reads it with its signers, never a token; the tenant member reads it, another tenant does not.
    const listed = await sigs(AGENT, REQ_1);
    assert.equal(listed.length, 1);
    assert.deepEqual([listed[0].id, listed[0].status, listed[0].document_path, listed[0].created_by], [sigId, 'draft', DESK_PDF, AGENT]);
    assert.deepEqual(listed[0].signers.map((x) => [x.signer_name, x.signing_order, x.status]), [['Pat Homeowner', 1, 'pending'], ['Freedom Roofing', 2, 'pending']]);
    assert.doesNotMatch(JSON.stringify(listed), /access_token|token_hash|expires_at/);
    assert.deepEqual((await rows(MEMBER, 'SELECT id FROM public.signature_requests WHERE check_intake_item_id = $1', [CHECK_1])).map((r) => r.id), [sigId]);
    assert.equal((await rows(MEMBER_B, 'SELECT id FROM public.signature_requests', [])).length, 0);
    // Agents still cannot write the e-sign tables directly.
    await refused(rows(AGENT, 'INSERT INTO public.signature_requests (id, check_intake_item_id, claim_id, document_name) VALUES ($1, $2, $3, $4)',
      [randomUUID(), CHECK_1, CLAIM_1, 'direct']), '42501', /./);
    assert.equal((await rows(AGENT, 'SELECT id FROM public.signature_signers', [])).length, 0);

    // --- The delivery record.
    const [s1, s2] = created.signers.map((x) => x.id);
    await refused(deliver(OTHER_AGENT, REQ_1, sigId, []), '42501', /not_assigned_to_you/);
    await refused(deliver(AGENT, REQ_1, sigId, [{ signer_id: s1, success: true }]), '22023', /invalid_results/);
    await refused(deliver(AGENT, REQ_1, sigId, [{ signer_id: s1, success: true }, { signer_id: randomUUID(), success: true }]), '22023', /invalid_results/);
    await refused(deliver(AGENT, REQ_1, sigId, [{ signer_id: s1, success: true }, { signer_id: s1, success: true }]), '22023', /invalid_results/);
    await refused(deliver(AGENT, REQ_1, sigId, [{ signer_id: s1, success: 'yes' }, { signer_id: s2, success: true }]), '22023', /invalid_results/);
    // A request the tenant made on the same check, and one on another check.
    const tenantSig = randomUUID();
    await client.query(`INSERT INTO public.signature_requests (id, check_intake_item_id, claim_id, document_name, document_path, status, created_by)
      VALUES ($1, $2, $3, 'Tenant contract', $4, 'draft', $5)`, [tenantSig, CHECK_1, CLAIM_1, TENANT_DOCX, MEMBER]);
    await refused(deliver(AGENT, REQ_1, tenantSig, []), '42501', /not_a_desk_signature_request/);
    const otherSig = randomUUID();
    await client.query(`INSERT INTO public.signature_requests (id, check_intake_item_id, document_name, document_path, status)
      VALUES ($1, $2, 'B doc', $3, 'draft')`, [otherSig, CHECK_B, B_PDF]);
    await refused(deliver(AGENT, REQ_1, otherSig, []), '42501', /signature_request_not_on_check/);
    const partial = await deliver(AGENT, REQ_1, sigId, [
      { signer_id: s1, success: true, message_id: 'ses-1' }, { signer_id: s2, success: false, error: 'Mailbox unavailable' },
    ]);
    assert.deepEqual(partial, { signature_request_id: sigId, status: 'pending', provider_status: 'emails_partially_failed', sent: 1, failed: 1, total: 2 });
    const sent = (await client.query('SELECT * FROM public.signature_requests WHERE id = $1', [sigId])).rows[0];
    assert.deepEqual([sent.status, sent.delivery_mode, sent.last_error, sent.provider_status, Boolean(sent.sent_at), Boolean(sent.last_attempted_at)],
      ['pending', 'aws_ses_or_sink', 'Some emails failed', 'emails_partially_failed', true, true]);
    const delivered = (await client.query('SELECT id, delivery_status, delivery_error, email_provider_message_id, email_sent_at FROM public.signature_signers WHERE signature_request_id = $1 ORDER BY signing_order', [sigId])).rows;
    assert.deepEqual(delivered.map((x) => [x.delivery_status, x.delivery_error, x.email_provider_message_id, Boolean(x.email_sent_at)]),
      [['sent', null, 'ses-1', true], ['failed', 'Mailbox unavailable', null, false]]);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM public.esign_event_logs WHERE request_id = $1 AND stage = 'mortgage_desk_delivery_recorded'", [sigId])).rows[0].n, 1);
    await refused(deliver(AGENT, REQ_1, sigId, [{ signer_id: s1, success: true }, { signer_id: s2, success: true }]), '42501', /signature_request_not_draft/);
    // The same document again once the first is sent: a new draft (not a repeat).
    const second = await create(AGENT, REQ_1, { ...ok, signers: signers().slice(0, 1), fields: fields().slice(0, 1) });
    assert.notEqual(second.signature_request_id, sigId);

    // --- At most 10 requests through this Desk request in 24 hours.
    for (let i = 3; i <= 10; i += 1) {
      await create(AGENT, REQ_1, { path: TENANT_DOCX, name: `Doc ${i}`, signers: signers().slice(0, 1), fields: fields().slice(0, 1) })
        .then(async (out) => {
          // Sent at once, so the next one on the same document is not a repeat.
          await deliver(AGENT, REQ_1, out.signature_request_id, [{ signer_id: out.signers[0].id, success: true }]);
        });
    }
    await refused(create(AGENT, REQ_1, { path: TENANT_DOCX, signers: signers().slice(0, 1), fields: fields().slice(0, 1) }), '42501', /signature_request_limit/);
    assert.equal((await sigs(AGENT, REQ_1)).length, 11);

    // --- Homeowner timeline updates.
    await refused(timeline(AGENT, REQ_1, 'note', 'x'), '22023', /invalid_kind/);
    await refused(timeline(AGENT, REQ_1, 'mortgage_update', '   '), '22023', /invalid_note/);
    await refused(timeline(AGENT, REQ_1, 'mortgage_update', 'x'.repeat(2001)), '22023', /invalid_note/);
    await refused(timeline(OTHER_AGENT, REQ_1, 'mortgage_update', 'x'), '42501', /not_assigned_to_you/);
    await refused(timeline(MEMBER, REQ_1, 'mortgage_update', 'x'), '42501', /not_assigned_to_you/);
    const followup = await timeline(AGENT, REQ_1, ' mortgage_followup ', '  Spoke to Acme loss drafts  ');
    const update = await timeline(AGENT, REQ_1, 'mortgage_update', 'Check endorsed by servicer');
    const ledger = (await client.query('SELECT * FROM public.homeowner_ledger_events WHERE id = ANY($1::uuid[]) ORDER BY event_type', [[followup, update]])).rows;
    assert.deepEqual(ledger.map((e) => [e.tenant_id, e.claim_id, e.check_id, e.event_type, e.actor_label, e.created_by, e.amount]), [
      [TENANT_A, CLAIM_1, CHECK_1, 'mortgage_followup', 'Called Acme Mortgage', AGENT, null],
      [TENANT_A, CLAIM_1, CHECK_1, 'mortgage_update', 'Mortgage Ops update', AGENT, null],
    ]);
    assert.deepEqual(ledger[0].payload_json, { note: 'Spoke to Acme loss drafts', mortgage_company: 'Acme Mortgage', desk_request_id: REQ_1, source: 'mortgage_desk' });
    for (const e of ledger) assert.equal(e.payload_json.mortgage_request_id, undefined);

    // --- Completed (the existing RPC): reads, the storage check and the delivery record still work; create and timeline stop.
    const pendingDraft = await (async () => {
      await client.query("UPDATE public.esign_event_logs SET created_at = now() - interval '25 hours' WHERE stage = 'mortgage_desk_request_created'");
      return create(AGENT, REQ_1, { path: TENANT_DOCX, name: 'Before completion', signers: signers().slice(0, 1), fields: fields().slice(0, 1) });
    })();
    const done = await as(AGENT, () => executeSafeWriteRpc({
      client, mapping: { application_user_id: AGENT }, name: 'update_mortgage_handling_request_status',
      args: { _request_id: REQ_1, _status: 'completed', _notes: 'Endorsed and mailed back' },
    }));
    assert.equal(done.error, undefined, JSON.stringify(done));
    assert.ok((await messages(AGENT, REQ_1)).length > 2);
    assert.equal((await files(AGENT, REQ_1)).length, 3);
    assert.equal(await canRead(AGENT, [], DESK_PDF), true);
    assert.deepEqual(await deliver(AGENT, REQ_1, pendingDraft.signature_request_id, [{ signer_id: pendingDraft.signers[0].id, success: true, message_id: 'ses-9' }]),
      { signature_request_id: pendingDraft.signature_request_id, status: 'pending', provider_status: 'emails_sent', sent: 1, failed: 0, total: 1 });
    await refused(create(AGENT, REQ_1, { path: DESK_PDF, signers: signers().slice(0, 1), fields: fields().slice(0, 1) }), '42501', /request_not_in_status/);
    await refused(timeline(AGENT, REQ_1, 'mortgage_update', 'late'), '42501', /request_not_in_status/);
  } finally {
    for (const c of clients.reverse()) {
      try { await c.end(); } catch { /* ignore */ }
    }
    server.stop();
  }
});
