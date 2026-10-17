/**
 * SQL 99 (Mortgage Desk completion messages) against PostgreSQL 16: the real
 * AWS RLS helper files (aws/rls/sql, through the shared stakeholder fixture),
 * the real check_messages SELECT / write policies, the real SQL 90 file, then
 * the real aws/workflows/sql/99_mortgage_desk_completion_messages.sql applied
 * by a non-superuser login that owns check_messages and
 * mortgage_handling_requests (like checksops_admin).
 *
 * The completion goes through the real API bridge
 * (workflow-rpc.mjs executeSafeWriteRpc update_mortgage_handling_request_status)
 * as checksops with RLS on check_messages, so the work_notes format is the
 * API's own. The bodies are compared with the SPA builders
 * (src/lib/mortgageDeskReturn.ts); run with --experimental-strip-types.
 *
 * The first test gives mortgage_handling_requests no RLS so the API UPDATE
 * succeeds and the trigger fires: under the repo's policies and grants a
 * Mortgage Agent can neither read nor update another tenant's request (the
 * second test pins that down, before and after SQL 90); that needs its own
 * owner-approved policy and is not part of SQL 99.
 *
 * The check thread's own triggers are the repo's: the mirror into the
 * homeowner ledger (supabase migration 20260717193324) and, on the ledger,
 * the case link (assign_case_on_ledger_events, SQL 88's
 * tg_claim_id_assign_case). They are owned by another non-superuser login, and
 * the mirror reads profiles under RLS (as a separately owned table would in
 * production), so a row_security = off leaking from SQL 99's function would
 * fail the completion with 42501.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, applyBaseSchema, pgSkipReason, policyBlock, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { executeSafeWriteRpc } from '../functions/api/workflow-rpc.mjs';
import { executeCheckWorkflowWrite } from '../functions/api/write-check-workflow.mjs';
import {
  MORTGAGE_DESK_RETURN_MESSAGE,
  buildMortgageDeskCompletedMessage,
  buildReturnAckMessage,
  buildReturnMessage,
  deriveMortgageDeskReturnState,
  displayCheckMessageBody,
  parseReturnRequestId,
} from '../../src/lib/mortgageDeskReturn.ts';

const SQL_90 = path.join(AWS_ROOT, 'workflows/sql/90_users_only_tenant_roles.sql');
const SQL_99 = path.join(AWS_ROOT, 'workflows/sql/99_mortgage_desk_completion_messages.sql');
const SQL_88 = path.join(AWS_ROOT, 'workflows/sql/88_claim_id_assign_case_tenant_scope.sql');
const SQL_50 = path.join(AWS_ROOT, 'workflows/sql/50_tranche5_write_grants.sql');
const REPO_ROOT = path.join(AWS_ROOT, '..');
const MIRROR_MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/20260717193324_2a3e315b-a40a-474e-9eac-5e37824da513.sql');
const CASE_MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/20260826125804_316a5658-9b2c-4b7d-aaf3-9b81a5d5ccfd.sql');

/** The text from `start` through the end of the first `end` after it, exactly as the repo file has it. */
const sliceFrom = (file, start, end) => {
  const text = fs.readFileSync(file, 'utf8');
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${start} not found in ${file}`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `${end} not found after ${start} in ${file}`);
  return text.slice(from, to + end.length);
};
const mirrorFunctionSql = () => sliceFrom(MIRROR_MIGRATION,
  'CREATE OR REPLACE FUNCTION public.mirror_check_message_to_homeowner_ledger()', '\n$$;');
const mirrorTriggerSql = () => sliceFrom(MIRROR_MIGRATION,
  'DROP TRIGGER IF EXISTS trg_mirror_check_message_to_homeowner_ledger ON public.check_messages;',
  'EXECUTE FUNCTION public.mirror_check_message_to_homeowner_ledger();');
const caseFunctionSql = () => sliceFrom(SQL_88, 'CREATE OR REPLACE FUNCTION public.tg_claim_id_assign_case()', '\n$$;');
const caseTriggerSql = () => sliceFrom(CASE_MIGRATION, 'CREATE TRIGGER assign_case_on_ledger_events', ';');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const MEMBER = 'a1000000-0000-4000-8000-000000000001';
const PARTNER = 'a1000000-0000-4000-8000-000000000002';
const AGENT = 'a1000000-0000-4000-8000-000000000003';
const OTHER_AGENT = 'a1000000-0000-4000-8000-000000000004';
const OUTSIDER = 'a1000000-0000-4000-8000-000000000005';
const CHECK_1 = 'c1000000-0000-4000-8000-000000000001';
const CHECK_2 = 'c1000000-0000-4000-8000-000000000002';
const CHECK_3 = 'c1000000-0000-4000-8000-000000000003';
const CHECK_4 = 'c1000000-0000-4000-8000-000000000004';
const CHECK_5 = 'c1000000-0000-4000-8000-000000000005';
const CHECK_6 = 'c1000000-0000-4000-8000-000000000006';
const REQ_1 = 'd1000000-0000-4000-8000-000000000001';
const REQ_2 = 'd1000000-0000-4000-8000-000000000002';
const REQ_3 = 'd1000000-0000-4000-8000-000000000003';
const REQ_4 = 'd1000000-0000-4000-8000-000000000004';
const REQ_5 = 'd1000000-0000-4000-8000-000000000005';
const REQ_6 = 'd1000000-0000-4000-8000-000000000006';
const CHECK_7 = 'c1000000-0000-4000-8000-000000000007';
const REQ_7 = 'd1000000-0000-4000-8000-000000000007';
const CLAIM_7 = 'e1000000-0000-4000-8000-000000000007';
const CASE_7 = 'f1000000-0000-4000-8000-000000000007';
const EARLIER_NOTE = '2026-10-01 09:00 — Called the lender about the endorsement';

/** As the superuser: the owner login, the two tables (check_messages as on Supabase / AWS), grants and RLS. */
const SCHEMA = `
CREATE TABLE public.recipient_tax_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, recipient_key text NOT NULL, tin text);
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE sql99_outsider LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin, sql99_outsider;
GRANT USAGE ON SCHEMA auth TO checksops_admin, sql99_outsider;
CREATE TABLE public.check_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  check_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  body text NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 5000),
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid, claim_id uuid,
  mortgage_company text, mortgage_servicer text, loan_number text,
  status text NOT NULL DEFAULT 'requested', assigned_employee_id uuid,
  accepted_at timestamptz, completed_at timestamptz, cancelled_at timestamptz, work_notes text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.check_messages OWNER TO checksops_admin;
ALTER TABLE public.mortgage_handling_requests OWNER TO checksops_admin;
-- aws/write-path/sql/35_tranche3_write_grants.sql and 50_tranche5_write_grants.sql.
GRANT SELECT, INSERT, DELETE ON TABLE public.check_messages TO checksops, authenticated;
GRANT UPDATE (is_deleted, updated_at) ON TABLE public.check_messages TO checksops, authenticated;
GRANT SELECT, UPDATE ON TABLE public.mortgage_handling_requests TO checksops;
GRANT SELECT ON TABLE public.check_messages, public.mortgage_handling_requests TO sql99_outsider;
ALTER TABLE public.check_messages ENABLE ROW LEVEL SECURITY;
`;

/**
 * The check thread's downstream tables, owned by a different non-superuser
 * login (ledger_owner) that also owns the mirror and case trigger functions.
 * profiles stays the superuser's, with RLS on and a SELECT policy for
 * ledger_owner: the mirror reads it under RLS.
 */
const LEDGER_SCHEMA = `
CREATE ROLE ledger_owner LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE, CREATE ON SCHEMA public TO ledger_owner;
GRANT USAGE ON SCHEMA auth TO ledger_owner;
ALTER TABLE public.check_intake_items ADD COLUMN check_number text;
ALTER TABLE public.profiles ADD COLUMN full_name text;
CREATE TABLE public.check_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  external_system text NOT NULL DEFAULT 'freedom_crm', external_claim_id uuid);
CREATE TABLE public.homeowner_ledger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, claim_id uuid NOT NULL,
  check_id uuid, event_type text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  amount numeric(12,2), actor_label text, payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), case_id uuid);
ALTER TABLE public.check_intake_items OWNER TO ledger_owner;
ALTER TABLE public.claims OWNER TO ledger_owner;
ALTER TABLE public.check_cases OWNER TO ledger_owner;
ALTER TABLE public.homeowner_ledger_events OWNER TO ledger_owner;
ALTER TABLE public.homeowner_ledger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_cases ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.profiles TO ledger_owner;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY sql99_test_ledger_owner_reads_profiles ON public.profiles FOR SELECT TO ledger_owner USING (true);
`;

const SEED = `
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B');
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
  ('${MEMBER}', 'm@example.com', 'active'), ('${PARTNER}', 'p@example.com', 'active'),
  ('${AGENT}', 'agent@example.com', 'active'), ('${OTHER_AGENT}', 'agent2@example.com', 'active'),
  ('${OUTSIDER}', 'o@example.com', 'active');
INSERT INTO public.profiles (id, email) SELECT application_user_id, email FROM public.identity_accounts;
INSERT INTO public.user_roles (user_id, role) VALUES ('${AGENT}', 'mortgage_agent'), ('${OTHER_AGENT}', 'mortgage_agent');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${TENANT_A}', '${MEMBER}', 'viewer'), ('${TENANT_B}', '${PARTNER}', 'owner');
INSERT INTO public.check_intake_items (id, tenant_id) VALUES
  ('${CHECK_1}', '${TENANT_A}'), ('${CHECK_2}', '${TENANT_A}'), ('${CHECK_3}', '${TENANT_A}'),
  ('${CHECK_4}', '${TENANT_A}'), ('${CHECK_5}', '${TENANT_A}'), ('${CHECK_6}', '${TENANT_A}');
UPDATE public.profiles SET full_name = 'Alex Agent' WHERE id = '${AGENT}';
INSERT INTO public.claims (id, org_id) VALUES ('${CLAIM_7}', '${TENANT_A}');
INSERT INTO public.check_intake_items (id, tenant_id, claim_id, check_number) VALUES ('${CHECK_7}', '${TENANT_A}', '${CLAIM_7}', '1007');
INSERT INTO public.check_cases (id, tenant_id, external_system, external_claim_id) VALUES ('${CASE_7}', '${TENANT_A}', 'freedom_crm', '${CLAIM_7}');
INSERT INTO public.mortgage_handling_requests
  (id, tenant_id, check_intake_item_id, mortgage_company, mortgage_servicer, status, assigned_employee_id, accepted_at, work_notes)
VALUES
  ('${REQ_1}', '${TENANT_A}', '${CHECK_1}', 'Rocket Mortgage', 'Servicer One', 'in_progress', '${AGENT}', now(), '${EARLIER_NOTE}'),
  ('${REQ_2}', '${TENANT_A}', '${CHECK_2}', NULL, 'Mr. Cooper', 'in_progress', '${AGENT}', now(), NULL),
  ('${REQ_3}', '${TENANT_A}', '${CHECK_3}', '', '', 'in_progress', '${AGENT}', now(), NULL),
  ('${REQ_4}', '${TENANT_A}', '${CHECK_4}', 'Cancel Bank', NULL, 'in_progress', '${AGENT}', now(), NULL),
  ('${REQ_5}', '${TENANT_A}', '${CHECK_5}', 'Queue Bank', NULL, 'requested', NULL, NULL, NULL),
  ('${REQ_6}', '${TENANT_A}', '${CHECK_6}', 'Other Bank', NULL, 'in_progress', '${AGENT}', now(), NULL),
  ('${REQ_7}', '${TENANT_A}', '${CHECK_7}', 'Ledger Bank', NULL, 'in_progress', '${AGENT}', now(), NULL);
`;

test('PostgreSQL 16: SQL 99 posts the Mortgage Desk completion note and one return marker as the assigned agent', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql99-desk-', 59900);
  const connect = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const client = await connect('ubuntu');
  const clients = [client];
  try {
    await applyBaseSchema(client);
    await client.query(SCHEMA);
    await client.query(LEDGER_SCHEMA);
    const ledgerOwner = await connect('ledger_owner');
    clients.push(ledgerOwner);
    await ledgerOwner.query(mirrorFunctionSql());
    await ledgerOwner.query(caseFunctionSql());
    await ledgerOwner.query(caseTriggerSql());
    await client.query(mirrorTriggerSql());
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_check_messages'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_check_messages'));
    await client.query(fs.readFileSync(SQL_90, 'utf8'));
    await client.query(SEED);

    const sql99 = fs.readFileSync(SQL_99, 'utf8');
    const policySnapshot = async () => (await client.query(
      `SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename IN ('check_messages', 'check_intake_items', 'mortgage_handling_requests')
        ORDER BY tablename, policyname`,
    )).rows;
    const aclSnapshot = async () => (await client.query(
      `SELECT c.relname, c.relacl::text AS acl, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        WHERE c.oid IN ('public.check_messages'::regclass, 'public.check_intake_items'::regclass,
                        'public.mortgage_handling_requests'::regclass)
        ORDER BY c.relname`,
    )).rows;
    const policiesBefore = await policySnapshot();
    const aclBefore = await aclSnapshot();

    // Refuses without SQL 90, and changes nothing.
    await client.query('BEGIN');
    await client.query('DROP FUNCTION public.aws_is_tenant_member(uuid) CASCADE');
    await assert.rejects(client.query(sql99), (error) => error.code === '55000' && /sql99_prerequisite_missing/.test(error.message));
    await client.query('ROLLBACK');

    // Refuses when the applying login does not own check_messages.
    const outsider = await connect('sql99_outsider');
    clients.push(outsider);
    await assert.rejects(outsider.query(sql99),
      (error) => error.code === '55000' && /sql99_definer_cannot_write_check_messages/.test(error.message));

    // Refuses under FORCE ROW LEVEL SECURITY (row_security = off would fail every completion).
    const owner = await connect('checksops_admin');
    clients.push(owner);
    await owner.query('BEGIN');
    await owner.query('ALTER TABLE public.check_messages FORCE ROW LEVEL SECURITY');
    await assert.rejects(owner.query(sql99),
      (error) => error.code === '55000' && /sql99_definer_cannot_write_check_messages/.test(error.message));
    await owner.query('ROLLBACK');

    // Apply twice as the owning login: idempotent.
    await owner.query(sql99);
    await owner.query(sql99);

    // No policy and no table grant changed; nothing new to execute for checksops / authenticated.
    assert.deepEqual(await policySnapshot(), policiesBefore);
    assert.deepEqual(await aclSnapshot(), aclBefore);
    const fns = (await client.query(
      `SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('aws_mortgage_desk_completion_messages', 'aws_mortgage_desk_appended_note')
        ORDER BY p.proname`,
    )).rows;
    assert.deepEqual(fns.map((f) => [f.proname, f.prosecdef, f.owner, f.checksops_exec, f.authenticated_exec]), [
      ['aws_mortgage_desk_appended_note', false, 'checksops_admin', false, false],
      ['aws_mortgage_desk_completion_messages', true, 'checksops_admin', false, false],
    ]);
    // No row_security setting: it would carry into the mirror and case triggers.
    assert.deepEqual(fns[1].proconfig, ['search_path=public']);
    const trig = (await client.query(
      `SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS def FROM pg_trigger
        WHERE tgrelid = 'public.mortgage_handling_requests'::regclass AND NOT tgisinternal`,
    )).rows;
    assert.equal(trig.length, 1);
    assert.equal(trig[0].tgname, 'tr_mortgage_desk_completion_messages');
    assert.match(trig[0].def, /AFTER UPDATE ON public\.mortgage_handling_requests FOR EACH ROW WHEN/);

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
    const setStatus = (user, requestId, status, notes = null) => as(user, () => executeSafeWriteRpc({
      client,
      mapping: { application_user_id: user },
      name: 'update_mortgage_handling_request_status',
      args: { _request_id: requestId, _status: status, _notes: notes },
    }));
    const messages = async (checkId) => (await client.query(
      'SELECT id, check_id, sender_id, body, is_deleted, created_at FROM public.check_messages WHERE check_id = $1 ORDER BY created_at, id',
      [checkId],
    )).rows;
    const markers = (rows, requestId) => rows.filter((m) => m.body.startsWith(`MORTGAGE_DESK_RETURN:${requestId}`));
    const completedRow = async (requestId) => (await client.query(
      'SELECT id, check_intake_item_id, status, completed_at FROM public.mortgage_handling_requests WHERE id = $1', [requestId],
    )).rows[0];

    // --- Completion by the assigned agent: one completed note with only this completion's note, one marker.
    const done1 = await setStatus(AGENT, REQ_1, 'completed', 'Endorsed and mailed back');
    assert.equal(done1.error, undefined, JSON.stringify(done1));
    assert.equal(done1.data.status, 'completed');
    assert.match(done1.data.work_notes, /^2026-10-01 09:00 — Called the lender about the endorsement\n\n\d{4}-\d{2}-\d{2} \d{2}:\d{2} — Endorsed and mailed back$/);
    let rows1 = await messages(CHECK_1);
    assert.equal(rows1.length, 2);
    assert.equal(rows1[0].body, buildMortgageDeskCompletedMessage('Rocket Mortgage', 'Endorsed and mailed back'));
    assert.equal(rows1[0].body, '✅ ChecksOps Mortgage Desk completed work with Rocket Mortgage. Notes: Endorsed and mailed back');
    assert.doesNotMatch(rows1[0].body, /Called the lender/);
    assert.equal(rows1[1].body, buildReturnMessage(REQ_1));
    assert.equal(parseReturnRequestId(rows1[1].body), REQ_1);
    assert.equal(displayCheckMessageBody(rows1[1].body), MORTGAGE_DESK_RETURN_MESSAGE);
    for (const m of rows1) {
      assert.equal(m.sender_id, AGENT);
      assert.equal(m.is_deleted, false);
    }
    assert.ok(rows1[0].created_at <= rows1[1].created_at);

    // The tenant's banner state from the trigger's rows: action required until the member acks.
    const req1 = await completedRow(REQ_1);
    let state = deriveMortgageDeskReturnState([req1], rows1);
    assert.equal(state.actionRequired, true);
    assert.deepEqual(state.unackedRequestIds, [REQ_1]);

    // --- Re-opening (append note, in_progress) posts nothing; completing again posts a note without
    // "Notes:" when none was added, and never a second marker; completed -> completed posts nothing.
    const reopened = await setStatus(AGENT, REQ_1, 'in_progress', 'Lender asked for one more page');
    assert.equal(reopened.error, undefined);
    assert.equal((await messages(CHECK_1)).length, 2);
    const done1b = await setStatus(AGENT, REQ_1, 'completed', null);
    assert.equal(done1b.error, undefined);
    rows1 = await messages(CHECK_1);
    assert.equal(rows1.length, 3);
    assert.equal(rows1[2].body, '✅ ChecksOps Mortgage Desk completed work with Rocket Mortgage.');
    assert.equal(markers(rows1, REQ_1).length, 1);
    const done1c = await setStatus(AGENT, REQ_1, 'completed', 'Duplicate click');
    assert.equal(done1c.error, undefined);
    rows1 = await messages(CHECK_1);
    assert.equal(rows1.length, 3);
    assert.equal(markers(rows1, REQ_1).length, 1);

    // --- The tenant member's ack still works through the real API path and clears the banner.
    const ack = await as(MEMBER, () => executeCheckWorkflowWrite({
      client,
      mapping: { application_user_id: MEMBER },
      table: 'check_messages',
      op: 'insert',
      values: { check_id: CHECK_1, body: buildReturnAckMessage(REQ_1) },
      filters: [],
    }));
    assert.equal(ack.error, undefined, JSON.stringify(ack));
    assert.equal(ack.rows[0].sender_id, MEMBER);
    rows1 = await messages(CHECK_1);
    state = deriveMortgageDeskReturnState([req1], rows1);
    assert.equal(state.actionRequired, false);
    assert.deepEqual(state.unackedRequestIds, []);

    // --- Company fallbacks and no note: mortgage_servicer when mortgage_company is empty, then the default.
    assert.equal((await setStatus(AGENT, REQ_2, 'completed', null)).error, undefined);
    const rows2 = await messages(CHECK_2);
    // MortgageOpsQueue passes row.mortgage_company || row.mortgage_servicer.
    assert.deepEqual(rows2.map((m) => m.body), [
      buildMortgageDeskCompletedMessage(null || 'Mr. Cooper', null),
      buildReturnMessage(REQ_2),
    ]);
    assert.equal(rows2[0].body, '✅ ChecksOps Mortgage Desk completed work with Mr. Cooper.');
    assert.doesNotMatch(rows2[0].body, /Notes:/);
    assert.equal((await setStatus(AGENT, REQ_3, 'completed', '  Packet returned  ')).error, undefined);
    const rows3 = await messages(CHECK_3);
    const emptyCompany = '';
    const emptyServicer = '';
    assert.equal(rows3[0].body, buildMortgageDeskCompletedMessage(emptyCompany || emptyServicer, 'Packet returned'));
    assert.equal(rows3[0].body, '✅ ChecksOps Mortgage Desk completed work with the mortgage company. Notes: Packet returned');
    assert.equal(markers(rows3, REQ_3).length, 1);

    // --- in_progress and cancelled post nothing.
    assert.equal((await setStatus(AGENT, REQ_4, 'in_progress', 'Working it')).error, undefined);
    assert.equal((await setStatus(AGENT, REQ_4, 'cancelled', 'Tenant withdrew')).error, undefined);
    assert.deepEqual(await messages(CHECK_4), []);

    // --- No assigned agent: completing a queued request posts nothing (whoever writes it).
    await as(MEMBER, () => client.query(`UPDATE public.mortgage_handling_requests SET status = 'completed' WHERE id = $1`, [REQ_5]));
    assert.equal((await completedRow(REQ_5)).status, 'completed');
    assert.deepEqual(await messages(CHECK_5), []);

    // --- Only the assigned agent's own completion posts: another agent is refused by the API, and a
    // tenant member setting status on an assigned request does not post as the agent.
    assert.equal((await setStatus(OTHER_AGENT, REQ_6, 'completed', 'Not mine')).error, 'not_assigned_to_you');
    await as(MEMBER, () => client.query(`UPDATE public.mortgage_handling_requests SET status = 'completed' WHERE id = $1`, [REQ_6]));
    assert.equal((await completedRow(REQ_6)).status, 'completed');
    assert.deepEqual(await messages(CHECK_6), []);

    // --- No policy was broadened: agents still cannot write check_messages directly.
    for (const [user, checkId] of [[AGENT, CHECK_1], [AGENT, CHECK_2], [OTHER_AGENT, CHECK_1], [PARTNER, CHECK_1], [OUTSIDER, CHECK_1]]) {
      await assert.rejects(
        as(user, () => client.query(
          'INSERT INTO public.check_messages (check_id, sender_id, body) VALUES ($1, $2, $3)',
          [checkId, user, buildReturnMessage(REQ_1)],
        )),
        (error) => error.code === '42501' && /row-level security/.test(error.message),
        `${user} on ${checkId}`,
      );
      const viaApi = await as(user, () => executeCheckWorkflowWrite({
        client,
        mapping: { application_user_id: user },
        table: 'check_messages',
        op: 'insert',
        values: { check_id: checkId, body: 'direct' },
        filters: [],
      }));
      assert.equal(viaApi.error, 'rls_denied', `${user} via API`);
    }
    // ... and cannot update or delete the rows the trigger wrote as them.
    const agentRow = rows1[0].id;
    assert.equal(await as(AGENT, async () => (await client.query(
      'UPDATE public.check_messages SET is_deleted = true WHERE id = $1', [agentRow])).rowCount), 0);
    assert.equal(await as(AGENT, async () => (await client.query(
      'DELETE FROM public.check_messages WHERE id = $1', [agentRow])).rowCount), 0);
    assert.equal((await messages(CHECK_1)).find((m) => m.id === agentRow).is_deleted, false);

    // Tenant members are unaffected: a member still writes its own thread.
    const note = await as(MEMBER, () => executeCheckWorkflowWrite({
      client,
      mapping: { application_user_id: MEMBER },
      table: 'check_messages',
      op: 'insert',
      values: { check_id: CHECK_2, body: 'Thanks, received' },
      filters: [],
    }));
    assert.equal(note.error, undefined);

    // --- A check linked to a claim: the real mirror trigger (owned by ledger_owner, reading
    // profiles under RLS) and the ledger's case trigger run inside the completion, which commits.
    const done7 = await setStatus(AGENT, REQ_7, 'completed', 'Mailed');
    assert.equal(done7.error, undefined, JSON.stringify(done7));
    const rows7 = await messages(CHECK_7);
    assert.deepEqual(rows7.map((m) => m.body), [
      buildMortgageDeskCompletedMessage('Ledger Bank', 'Mailed'),
      buildReturnMessage(REQ_7),
    ]);
    const ledger7 = (await client.query(
      `SELECT tenant_id, claim_id, check_id, case_id, event_type, actor_label, created_by,
              payload_json->>'note' AS note, payload_json->>'check_message_id' AS message_id,
              payload_json->>'check_number' AS check_number
         FROM public.homeowner_ledger_events WHERE check_id = $1 ORDER BY occurred_at, created_at`,
      [CHECK_7],
    )).rows;
    assert.deepEqual(ledger7.map((e) => [e.tenant_id, e.claim_id, e.case_id, e.event_type, e.actor_label, e.created_by, e.check_number]), [
      [TENANT_A, CLAIM_7, CASE_7, 'ops_note', 'Alex Agent', AGENT, '1007'],
      [TENANT_A, CLAIM_7, CASE_7, 'ops_note', 'Alex Agent', AGENT, '1007'],
    ]);
    assert.deepEqual(ledger7.map((e) => e.note).sort(), rows7.map((m) => m.body).sort());
    assert.deepEqual(ledger7.map((e) => e.message_id).sort(), rows7.map((m) => m.id).sort());
    // Checks without a claim are not mirrored (the mirror's own rule).
    assert.equal((await client.query('SELECT count(*)::int AS n FROM public.homeowner_ledger_events WHERE check_id <> $1', [CHECK_7])).rows[0].n, 0);

    // Note extraction edge cases (the API's format only).
    const note2 = async (oldNotes, newNotes) => (await owner.query(
      'SELECT public.aws_mortgage_desk_appended_note($1, $2) AS note', [oldNotes, newNotes])).rows[0].note;
    assert.equal(await note2(null, '2026-10-17 10:00 — First'), 'First');
    assert.equal(await note2('', '\n\n2026-10-17 10:00 — First'), 'First');
    assert.equal(await note2('2026-10-01 09:00 — Old', '2026-10-01 09:00 — Old\n\n2026-10-17 10:00 — New\nline two'), 'New\nline two');
    assert.equal(await note2('2026-10-01 09:00 — Old', '2026-10-01 09:00 — Old'), null);
    assert.equal(await note2('2026-10-01 09:00 — Old', 'rewritten entirely'), null);
    assert.equal(await note2(null, 'free text without the API timestamp'), null);
    assert.equal(await note2('a', null), null);
  } finally {
    for (const c of clients.reverse()) {
      try { await c.end(); } catch { /* ignore */ }
    }
    server.stop();
  }
});

/**
 * Review finding (not changed by SQL 99): with the repo's own
 * mortgage_handling_requests policies (aws_select_ from 12_final_select_policies,
 * aws_write_ from 24_complete_write_policies) and grants (50_tranche5_write_grants),
 * a Mortgage Agent who is not a member of the request's tenant can neither
 * read the queue nor accept or update a request through the API bridge, both
 * before and after SQL 90. Two layers refuse: checksops has no UPDATE on
 * assigned_employee_id / accepted_at / completed_at (42501 permission denied),
 * and without that, RLS matches no row. Fixing it needs an owner-approved
 * agent policy; this test changes with it.
 */
test('PostgreSQL 16: repo policies and grants give a non-member Mortgage Agent no handling-request read or update, before and after SQL 90', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql99-mhr-', 59950);
  const client = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await client.connect();
  try {
    await applyBaseSchema(client);
    await client.query(`
CREATE TABLE public.recipient_tax_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, recipient_key text NOT NULL, tin text);
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid, claim_id uuid,
  mortgage_company text, mortgage_servicer text, loan_number text, note text, work_notes text,
  property_address text, claim_number text, insurance_company text,
  homeowner_name text, homeowner_email text, homeowner_phone text,
  status text NOT NULL DEFAULT 'requested', assigned_employee_id uuid,
  accepted_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.mortgage_handling_requests ENABLE ROW LEVEL SECURITY;
`);
    await client.query(sliceFrom(SQL_50,
      'GRANT SELECT, INSERT, DELETE ON TABLE public.mortgage_handling_requests',
      ') ON TABLE public.mortgage_handling_requests TO checksops, authenticated;'));
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_mortgage_handling_requests'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_mortgage_handling_requests'));
    await client.query(`
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A');
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
  ('${MEMBER}', 'm@example.com', 'active'), ('${AGENT}', 'agent@example.com', 'active');
INSERT INTO public.user_roles (user_id, role) VALUES ('${AGENT}', 'mortgage_agent');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT_A}', '${MEMBER}', 'owner');
INSERT INTO public.check_intake_items (id, tenant_id) VALUES ('${CHECK_1}', '${TENANT_A}'), ('${CHECK_2}', '${TENANT_A}');
INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id, status, assigned_employee_id) VALUES
  ('${REQ_1}', '${TENANT_A}', '${CHECK_1}', 'requested', NULL),
  ('${REQ_2}', '${TENANT_A}', '${CHECK_2}', 'in_progress', '${AGENT}');
`);

    /** One API request as checksops for this user; `grantAgentColumns` adds the missing column grant first. Rolled back. */
    const as = async (user, fn, { grantAgentColumns = false } = {}) => {
      await client.query('BEGIN');
      try {
        if (grantAgentColumns) {
          await client.query('GRANT UPDATE (assigned_employee_id, accepted_at, completed_at) ON TABLE public.mortgage_handling_requests TO checksops');
        }
        await client.query('SET LOCAL ROLE checksops');
        await client.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        return await fn();
      } finally {
        await client.query('ROLLBACK');
      }
    };
    const rpc = (user, name, args, options) => as(user, () => executeSafeWriteRpc({
      client, mapping: { application_user_id: user }, name, args,
    }), options);
    const queue = (user) => as(user, async () => (await client.query(
      `SELECT id FROM public.mortgage_handling_requests WHERE status IN ('requested', 'in_progress', 'completed') ORDER BY id`,
    )).rows.map((r) => r.id));
    const permissionDenied = (error) => error.code === '42501' && /permission denied/.test(error.message);

    const agentCannot = async (label) => {
      // The queue read (MortgageOpsQueue fetchQueues): the agent sees nothing; the member sees its tenant's rows.
      assert.deepEqual(await queue(AGENT), [], label);
      assert.deepEqual(await queue(MEMBER), [REQ_1, REQ_2], label);
      // Accept and status update as the real API bridge runs them.
      await assert.rejects(rpc(AGENT, 'accept_mortgage_handling_request', { _request_id: REQ_1 }), permissionDenied, label);
      await assert.rejects(rpc(AGENT, 'update_mortgage_handling_request_status',
        { _request_id: REQ_2, _status: 'completed', _notes: 'done' }), permissionDenied, label);
      // With the column grant, RLS still matches no row.
      assert.equal((await rpc(AGENT, 'accept_mortgage_handling_request', { _request_id: REQ_1 },
        { grantAgentColumns: true })).error, 'already_taken', label);
      assert.equal((await rpc(AGENT, 'update_mortgage_handling_request_status',
        { _request_id: REQ_2, _status: 'completed', _notes: 'done' }, { grantAgentColumns: true })).error,
      'not_assigned_to_you', label);
    };

    await agentCannot('before SQL 90');
    await client.query(fs.readFileSync(SQL_90, 'utf8'));
    await agentCannot('after SQL 90');
    // Nothing was written.
    assert.deepEqual((await client.query(
      'SELECT id, status, assigned_employee_id FROM public.mortgage_handling_requests ORDER BY id')).rows, [
      { id: REQ_1, status: 'requested', assigned_employee_id: null },
      { id: REQ_2, status: 'in_progress', assigned_employee_id: AGENT },
    ]);
  } finally {
    await client.end();
    server.stop();
  }
});
