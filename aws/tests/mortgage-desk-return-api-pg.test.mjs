/**
 * The Mortgage Desk API (workflow-rpc.mjs, mortgage-desk-return.mjs) over SQL 122 against
 * PostgreSQL 16 (the SQL file alone: sql122-mortgage-desk-return-pg.test.mjs): the real AWS RLS helper files (through the shared stakeholder
 * fixture), the real check_messages / check_files / mortgage_handling_requests
 * policies (12, 24, SQL 50, SQL 90, SQL 100), SQL 99, then
 * aws/workflows/sql/122_mortgage_desk_return_to_tenant.sql applied by a
 * non-superuser login that owns the Desk and check tables (like
 * checksops_admin).
 *
 * The Desk is driven as the API drives it: checksops, RLS on,
 * request.app_user_id set, through workflow-rpc.mjs / mortgage-desk-return.mjs.
 *
 *   - the assigned agent posts a message, attaches a document, sets the
 *     shipping details and a label, adds a mid-work note (posted on the check
 *     thread) and completes (SQL 99's messages plus SQL 122's homeowner
 *     timeline row); the tenant member reads every one of them on its check;
 *   - another agent, the tenant's own member and a member of another tenant
 *     are refused, by the API gate and by the functions themselves;
 *   - the "work returned" email is claimed once, for the requester.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, applyBaseSchema, pgSkipReason, policyBlock, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { executeSafeWriteRpc } from '../functions/api/workflow-rpc.mjs';
import { runMortgageDeskReturnEmail } from '../functions/api/mortgage-desk-return.mjs';
import { buildMortgageDeskCompletedMessage, buildReturnMessage } from '../../src/lib/mortgageDeskReturn.ts';
import { buildMortgageDeskNoteMessage } from '../../src/lib/mortgageDeskWrites.ts';

const SQL_50 = path.join(AWS_ROOT, 'workflows/sql/50_tranche5_write_grants.sql');
const SQL_90 = path.join(AWS_ROOT, 'workflows/sql/90_users_only_tenant_roles.sql');
const SQL_99 = path.join(AWS_ROOT, 'workflows/sql/99_mortgage_desk_completion_messages.sql');
const SQL_100 = path.join(AWS_ROOT, 'workflows/sql/100_mortgage_desk_live_access.sql');
const SQL_122 = path.join(AWS_ROOT, 'workflows/sql/122_mortgage_desk_return_to_tenant.sql');

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
const CHECK_1 = 'c1000000-0000-4000-8000-000000000001';
const CHECK_B = 'c1000000-0000-4000-8000-000000000002';
const CLAIM_1 = 'e1000000-0000-4000-8000-000000000001';
const REQ_1 = 'd1000000-0000-4000-8000-000000000001';
const REQ_B = 'd1000000-0000-4000-8000-000000000002';

const SCHEMA = `
CREATE TABLE public.recipient_tax_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, recipient_key text NOT NULL, tin text);
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE sql122_outsider LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin, sql122_outsider;
GRANT USAGE ON SCHEMA auth TO checksops_admin, sql122_outsider;
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
-- checksops_admin owns the tables it writes and reads, as in production.
ALTER TABLE public.check_messages OWNER TO checksops_admin;
ALTER TABLE public.check_files OWNER TO checksops_admin;
ALTER TABLE public.mortgage_handling_requests OWNER TO checksops_admin;
ALTER TABLE public.homeowner_ledger_events OWNER TO checksops_admin;
ALTER TABLE public.check_intake_items OWNER TO checksops_admin;
ALTER TABLE public.tenants OWNER TO checksops_admin;
ALTER TABLE public.tenant_users OWNER TO checksops_admin;
ALTER TABLE public.identity_accounts OWNER TO checksops_admin;
-- aws/write-path/sql/35_tranche3_write_grants.sql and SQL 67.
GRANT SELECT, INSERT, DELETE ON TABLE public.check_messages TO checksops, authenticated;
GRANT UPDATE (is_deleted, updated_at) ON TABLE public.check_messages TO checksops, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.check_files TO checksops, authenticated;
GRANT SELECT, INSERT ON TABLE public.homeowner_ledger_events TO checksops;
ALTER TABLE public.check_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_handling_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.homeowner_ledger_events ENABLE ROW LEVEL SECURITY;
`;

const SEED = `
INSERT INTO public.tenants (id, name, slug, company_email) VALUES
  ('${TENANT_A}', 'Freedom', 'freedom', 'office@freedom.test'), ('${TENANT_B}', 'Other', 'other', NULL);
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
  ('${MEMBER}', 'Requester@Freedom.test', 'active'), ('${MEMBER_B}', 'b@other.test', 'active'),
  ('${AGENT}', 'agent@checksops.test', 'active'), ('${OTHER_AGENT}', 'agent2@checksops.test', 'active');
INSERT INTO public.profiles (id, email) SELECT application_user_id, email FROM public.identity_accounts;
INSERT INTO public.user_roles (user_id, role) VALUES ('${AGENT}', 'mortgage_agent'), ('${OTHER_AGENT}', 'mortgage_agent');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${TENANT_A}', '${MEMBER}', 'viewer'), ('${TENANT_B}', '${MEMBER_B}', 'owner');
INSERT INTO public.claims (id, org_id) VALUES ('${CLAIM_1}', '${TENANT_A}');
INSERT INTO public.check_intake_items (id, tenant_id, claim_id, check_number) VALUES
  ('${CHECK_1}', '${TENANT_A}', '${CLAIM_1}', '100234'), ('${CHECK_B}', '${TENANT_B}', NULL, '9');
INSERT INTO public.mortgage_handling_requests
  (id, tenant_id, check_intake_item_id, claim_id, mortgage_company, status, assigned_employee_id, accepted_at, requested_by)
VALUES
  ('${REQ_1}', '${TENANT_A}', '${CHECK_1}', '${CLAIM_1}', 'Acme Mortgage', 'in_progress', '${AGENT}', now(), '${MEMBER}'),
  ('${REQ_B}', '${TENANT_B}', '${CHECK_B}', NULL, 'B Bank', 'in_progress', '${OTHER_AGENT}', now(), '${MEMBER_B}');
`;

test('PostgreSQL 16: SQL 122 lets the assigned agent return notes, documents and shipping to the tenant, and no one else', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql122-desk-', 63100);
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
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_check_messages'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_check_messages'));
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_check_files'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_check_files'));
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_mortgage_handling_requests'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_mortgage_handling_requests'));
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
    const sql122 = fs.readFileSync(SQL_122, 'utf8');

    // Refuses when the applying login does not own the tables it writes.
    const outsider = await open('sql122_outsider');
    clients.push(outsider);
    await assert.rejects(outsider.query(sql122),
      (error) => error.code === '55000' && /sql122_definer_cannot_write/.test(error.message));

    // Apply twice as the owning login: idempotent.
    await owner.query(sql122);
    await owner.query(sql122);

    const fns = (await client.query(
      `SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'aws\\_mortgage\\_desk\\_%'
          AND p.proname NOT IN ('aws_mortgage_desk_completion_messages', 'aws_mortgage_desk_appended_note')
        ORDER BY p.proname`,
    )).rows;
    assert.deepEqual(fns.map((f) => [f.proname, f.prosecdef, f.owner, f.checksops_exec, f.authenticated_exec]), [
      ['aws_mortgage_desk_attach_file', true, 'checksops_admin', true, false],
      ['aws_mortgage_desk_completion_timeline', true, 'checksops_admin', true, false],
      ['aws_mortgage_desk_post_message', true, 'checksops_admin', true, false],
      ['aws_mortgage_desk_return_email_claim', true, 'checksops_admin', true, false],
      ['aws_mortgage_desk_update_shipping', true, 'checksops_admin', true, false],
      ['aws_mortgage_desk_working_request', true, 'checksops_admin', false, false],
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
    const rpc = (user, name, args) => as(user, () => executeSafeWriteRpc({
      client, mapping: { application_user_id: user }, name, args,
    }));
    const messages = async (checkId) => (await client.query(
      'SELECT sender_id, body FROM public.check_messages WHERE check_id = $1 ORDER BY created_at, id', [checkId],
    )).rows;

    // --- The assigned agent, through the API.
    const posted = await rpc(AGENT, 'mortgage_desk_post_message', { _request_id: REQ_1, _body: 'Called Acme, payoff letter requested' });
    assert.equal(posted.error, undefined, JSON.stringify(posted));
    assert.equal(posted.data.check_id, CHECK_1);
    assert.equal(posted.data.sender_id, AGENT);

    const docPath = `checks/${CHECK_1}/mortgage-ops/1700000000000-payoff.pdf`;
    const attached = await rpc(AGENT, 'mortgage_desk_attach_file', {
      _request_id: REQ_1, _file_name: 'payoff.pdf', _file_path: docPath, _file_type: 'application/pdf',
      _file_size: 2048, _category: 'mortgage_ops', _description: 'Payoff letter',
    });
    assert.equal(attached.error, undefined, JSON.stringify(attached));
    assert.equal(attached.data.source, 'mortgage_ops');
    assert.equal(attached.data.uploaded_by, AGENT);
    // A retry returns the same row.
    const again = await rpc(AGENT, 'mortgage_desk_attach_file', { _request_id: REQ_1, _file_name: 'payoff.pdf', _file_path: docPath });
    assert.equal(again.data.id, attached.data.id);

    const labelPath = `checks/${CHECK_1}/mortgage-ops/label-1700000000001-label.pdf`;
    await rpc(AGENT, 'mortgage_desk_attach_file', {
      _request_id: REQ_1, _file_name: 'label.pdf', _file_path: labelPath, _category: 'mortgage_ops_shipping_label',
    });
    const shipped = await rpc(AGENT, 'mortgage_desk_update_shipping', {
      _request_id: REQ_1,
      _fields: {
        mail_to_name: 'Acme Loss Drafts', mail_to_address: 'PO Box 1', shipping_label_carrier: 'UPS',
        shipping_label_tracking: '1Z999', shipping_label_path: labelPath, shipping_label_name: 'label.pdf',
        check_sent_date: '2026-10-27T15:00:00Z',
      },
    });
    assert.equal(shipped.error, undefined, JSON.stringify(shipped));
    const req1 = (await client.query('SELECT * FROM public.mortgage_handling_requests WHERE id = $1', [REQ_1])).rows[0];
    assert.equal(req1.mail_to_name, 'Acme Loss Drafts');
    assert.equal(req1.shipping_label_path, labelPath);
    assert.equal(req1.shipping_label_uploaded_by, AGENT);
    assert.equal(req1.check_sent_date.toISOString(), '2026-10-27T15:00:00.000Z');

    const noted = await rpc(AGENT, 'update_mortgage_handling_request_status', {
      _request_id: REQ_1, _status: 'in_progress', _notes: 'Acme wants the W-9 too',
    });
    assert.equal(noted.error, undefined, JSON.stringify(noted));
    assert.equal(noted.data.tenant_message_posted, true);

    // --- Refused: another agent, the tenant's own member, another tenant's member.
    for (const user of [OTHER_AGENT, MEMBER, MEMBER_B]) {
      const refused = await rpc(user, 'mortgage_desk_post_message', { _request_id: REQ_1, _body: 'spoof' });
      assert.ok(['not_assigned_to_you', 'not_authorized'].includes(refused.error), `${user}: ${JSON.stringify(refused)}`);
      const shipping = await rpc(user, 'mortgage_desk_update_shipping', { _request_id: REQ_1, _fields: { mail_to_name: 'x' } });
      assert.ok(shipping.error, user);
      // And by the function itself, past the API gate.
      await assert.rejects(as(user, () => client.query(
        'SELECT * FROM public.aws_mortgage_desk_post_message($1::uuid, $2::text)', [REQ_1, 'spoof'],
      )), (error) => error.code === '42501', user);
    }
    // The agent of tenant B's request cannot write onto tenant A's check through its own request.
    await assert.rejects(as(OTHER_AGENT, () => client.query(
      'SELECT * FROM public.aws_mortgage_desk_attach_file($1::uuid, $2, $3, NULL, NULL, NULL, NULL)',
      [REQ_B, 'x.pdf', `checks/${CHECK_1}/mortgage-ops/x.pdf`],
    )), (error) => error.code === '22023' && /invalid_file_path/.test(error.message));
    // Agents still have no direct write on the tenant's check.
    await assert.rejects(as(AGENT, () => client.query(
      'INSERT INTO public.check_messages (check_id, sender_id, body) VALUES ($1, $2, $3)', [CHECK_1, AGENT, 'direct'],
    )), (error) => error.code === '42501');
    await assert.rejects(as(AGENT, () => client.query(
      'INSERT INTO public.check_files (check_intake_item_id, file_name, file_path) VALUES ($1, $2, $3)', [CHECK_1, 'd', 'd'],
    )), (error) => error.code === '42501');
    assert.equal((await messages(CHECK_B)).length, 0);

    // --- Completion: SQL 99's two messages and the homeowner timeline row.
    const done = await rpc(AGENT, 'update_mortgage_handling_request_status', {
      _request_id: REQ_1, _status: 'completed', _notes: 'Endorsed and mailed back',
    });
    assert.equal(done.error, undefined, JSON.stringify(done));
    assert.equal(done.data.homeowner_timeline_posted, true);
    const ledger = (await client.query(
      'SELECT tenant_id, claim_id, check_id, event_type, actor_label, payload_json, created_by FROM public.homeowner_ledger_events',
    )).rows;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].tenant_id, TENANT_A);
    assert.equal(ledger[0].claim_id, CLAIM_1);
    assert.equal(ledger[0].event_type, 'mortgage_update');
    assert.equal(ledger[0].payload_json.mortgage_request_id, REQ_1);
    assert.equal(ledger[0].created_by, AGENT);
    // Once per request.
    await as(AGENT, () => client.query('SELECT public.aws_mortgage_desk_completion_timeline($1::uuid)', [REQ_1]));
    assert.equal((await client.query('SELECT count(*)::int AS n FROM public.homeowner_ledger_events')).rows[0].n, 1);
    // Desk writes stop once the request is completed.
    const late = await rpc(AGENT, 'mortgage_desk_post_message', { _request_id: REQ_1, _body: 'late' });
    assert.equal(late.error, 'request_not_in_progress');

    // --- The tenant member reads every Desk note and document on its check.
    const tenantView = await as(MEMBER, async () => ({
      messages: (await client.query('SELECT body FROM public.check_messages WHERE check_id = $1 ORDER BY created_at, id', [CHECK_1])).rows,
      files: (await client.query("SELECT file_name, source FROM public.check_files WHERE check_intake_item_id = $1 ORDER BY created_at", [CHECK_1])).rows,
    }));
    assert.deepEqual(tenantView.messages.map((m) => m.body), [
      'Called Acme, payoff letter requested',
      buildMortgageDeskNoteMessage('Acme wants the W-9 too'),
      buildMortgageDeskCompletedMessage('Acme Mortgage', 'Endorsed and mailed back'),
      buildReturnMessage(REQ_1),
    ]);
    assert.deepEqual(tenantView.files, [
      { file_name: 'payoff.pdf', source: 'mortgage_ops' },
      { file_name: 'label.pdf', source: 'mortgage_ops' },
    ]);
    const otherTenantView = await as(MEMBER_B, async () => (
      await client.query('SELECT count(*)::int AS n FROM public.check_files WHERE check_intake_item_id = $1', [CHECK_1])
    ).rows[0].n);
    assert.equal(otherTenantView, 0);

    // --- The "work returned" email: once, to the requester, with the Desk's note and documents.
    const sends = [];
    const send = async (message) => {
      sends.push(message);
      return { mode: 'sink', results: message.to.map((to) => ({ to, status: 'sunk', delivery: 'sink' })) };
    };
    const refusedEmail = await as(OTHER_AGENT, () => runMortgageDeskReturnEmail({
      client, mapping: { application_user_id: OTHER_AGENT }, requestId: REQ_1, send, env: {},
    }));
    assert.equal(refusedEmail.ok, false);
    const emailed = await as(AGENT, () => runMortgageDeskReturnEmail({
      client, mapping: { application_user_id: AGENT }, requestId: REQ_1, send, env: {},
    }));
    assert.equal(emailed.ok, true, JSON.stringify(emailed));
    assert.equal(emailed.recipientSource, 'requester');
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].to, ['requester@freedom.test']);
    assert.ok(sends[0].text.includes('Endorsed and mailed back'));
    assert.ok(sends[0].text.includes('payoff.pdf'));
    assert.match(sends[0].subject, /check #100234/);
    const second = await as(AGENT, () => runMortgageDeskReturnEmail({
      client, mapping: { application_user_id: AGENT }, requestId: REQ_1, send, env: {},
    }));
    assert.equal(second.status, 'already_sent');
    assert.equal(sends.length, 1);
  } finally {
    for (const c of clients.reverse()) {
      try { await c.end(); } catch { /* ignore */ }
    }
    server.stop();
  }
});
