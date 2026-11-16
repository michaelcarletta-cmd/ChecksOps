/**
 * SQL 168 (aws/workflows/sql/168_mortgage_desk_same_agent_new_check.sql) on PostgreSQL 16: a new check on a claim the
 * Mortgage Desk already handles goes to the same agent with no action by the tenant (owner 2026-11-16: "We need to make
 * sure once a mortgage agent handles a check, if another check comes in they handle each one for that check file").
 *
 * Fixture (everything owned by the non-superuser checksops_admin login, as in production; the API writes as checksops
 * under row level security): the Mortgage Desk request table with the Supabase columns (20260715110727, 20260715194054,
 * 20260715200935, 20260716193831) and SQL 148's one-open-request index, SQL 84's mortgage_ops_request_audit, SQL 47's
 * roster table, has_role, the loss draft and check columns; the four live billing bodies the 2026-11-12 production
 * inspect read (aws/tests/fixtures/sql160-live-billing-functions-2026-11-12.sql) replaced by main's SQL 160, with SQL
 * 160's test triggers and its tg_accrue / tg_earn stand-ins (the live ones have no repository CREATE); SQL 47's
 * tr_reject_inactive_mortgage_agent_accept; the Supabase trg_auto_create_loss_draft body (20260826135843); a BEFORE
 * UPDATE stand-in for SQL 41's auto-link (it sets claim_id from a detected claim); main's SQL 167 with SQL 41's
 * ocr_claim_number_key; an AFTER INSERT library-share trigger on the requests owned by another role (as
 * trg_share_library_docs_to_mortgage_request), which fails under row_security = off.
 *
 * Proves: the file refuses without its prerequisites and from a login that cannot reach the relations; it installs two
 * DEFINER functions (search_path public, pg_temp; row_security on; EXECUTE for the owner only) and two triggers; a re-run
 * leaves the same functions and triggers; the routing creates one in_progress request, assigned to the agent, accepted
 * now, with the claim, endorsement order 1, the source's details, one check_messages row on the new check sent by the
 * agent ("ChecksOps Mortgage Desk added this check to <name>'s file automatically (same claim).", the agent's profile
 * name or "the agent already handling this claim") and one audit row, and no message when nothing is routed or the
 * routing fails, on a loss draft insert by the API
 * login, on trg_auto_create_loss_draft, on a claim link (Review save, the auto-link set in a BEFORE trigger, SQL 167's
 * relink run with row_security = off); it picks the most recent in-progress request whose agent is active, else the
 * most recent completed one, never a 2nd mortgagee's, a cancelled or queued request, an inactive agent or one without
 * the mortgage_agent role, another tenant's request or another claim's; it never acts on a deposited, voided or
 * returned check, a check with no claim or no loss draft, a check that already has a requested, in-progress or
 * completed request; it never changes an existing request; a failure inside the routing rolls back only the routing and
 * the tenant's write goes through; billing through SQL 160 unchanged: nothing for an additional check on a claim already
 * charged, mortgage_ops_initial 1000 when the claim has no charge yet; agent pay as SQL 160 decides.
 *
 * Run: node --test aws/tests/sql168-mortgage-desk-same-agent-new-check-pg.test.mjs (needs PostgreSQL 16; as root the PG
 * helpers run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { sliceFrom } from './helpers/sql145-collection-leg-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL168 = path.join(ROOT, 'aws/workflows/sql/168_mortgage_desk_same_agent_new_check.sql');
const SQL160 = path.join(ROOT, 'aws/workflows/sql/160_no_additional_check_mortgage_charge_or_manual_deposit_fee.sql');
const SQL167 = path.join(ROOT, 'aws/workflows/sql/167_claim_ledger_relink_check.sql');
const LIVE_BILLING = path.join(ROOT, 'aws/tests/fixtures/sql160-live-billing-functions-2026-11-12.sql');
const SQL47 = 'aws/tests/fixtures/mortgage-agent-compensation/47_mortgage_agent_compensation.sql';
const OWNER = 'checksops_admin';
const ROUTE = 'public.aws_mortgage_desk_route_same_agent(uuid, text)';
const ROUTE_TRIGGER = 'public.aws_mortgage_desk_route_same_agent_trigger()';

const id = (n) => `16800000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = id(1);
const T2 = id(2);
const ACTOR = id(3);
// Agents: A1 and A2 active (A2 with an 'active' roster row), A3 inactive in the roster, A4 without the mortgage_agent role.
const A1 = id(11);
const A2 = id(12);
const A3 = id(13);
const A4 = id(14);
const K = id(21); // the claim of the main path (R1 in progress by A1)
const K2 = id(22); // preference: in progress first
const K3 = id(23); // fallback to completed
const K4 = id(24); // no active agent: nothing
const K5 = id(25); // billing: the source accepted before the billing launch
const KX = id(26); // SQL 167 relink: the wrong claim
const KC = id(27); // completed source: no agent pay for the new check
const KD = id(28); // source still in progress: the new check's completion earns the initial amount
const check = (n) => id(100 + n);
const req = (n) => id(300 + n);

const ROLES = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE lib_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE other_admin LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin, other_admin;
GRANT USAGE ON SCHEMA public TO checksops, lib_owner;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
`;

// What SQL 168 reads and writes, in the production shapes (as checksops_admin, so it owns everything).
const SCHEMA = `
SET ROLE checksops_admin;
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL, UNIQUE (user_id, role));
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role) $$;
CREATE TYPE public.check_stage AS ENUM ('intake', 'review', 'loss_draft', 'endorsing', 'deposited', 'voided', 'returned');
CREATE TYPE public.deposit_provider AS ENUM ('checkalt', 'manual_branch');
CREATE TABLE public.tenants (id uuid PRIMARY KEY, per_check_billing_enabled boolean, per_check_rate_cents integer,
  mortgage_ops_initial_rate_cents integer, mortgage_ops_additional_rate_cents integer);
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, claim_id uuid, status text,
  check_stage public.check_stage, check_source text, deposited_at timestamptz, amount numeric, reviewed_by uuid,
  detected_claim_id uuid, updated_at timestamptz DEFAULT now());
CREATE TABLE public.loss_draft_tracking (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid,
  check_intake_item_id uuid REFERENCES public.check_intake_items(id) ON DELETE CASCADE, mortgage_servicer text,
  total_escrowed numeric, holdback_amount numeric, escrow_status text, created_by uuid);
CREATE UNIQUE INDEX idx_loss_draft_check_id ON public.loss_draft_tracking (check_intake_item_id);
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  check_intake_item_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  claim_id uuid, mortgage_company text, mortgage_servicer text, loan_number text, note text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','in_progress','completed','cancelled')),
  assigned_employee_id uuid, requested_by uuid, accepted_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  work_notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  policy_number text, claim_number text, insurance_company text, loss_type text, date_of_loss date, homeowner_name text,
  homeowner_email text, homeowner_phone text, property_address text, homeowner_ssn_last_four text,
  endorsement_order integer, predecessor_request_id uuid REFERENCES public.mortgage_handling_requests(id) ON DELETE SET NULL,
  total_mortgagees integer);
CREATE UNIQUE INDEX mortgage_handling_requests_one_open_per_check ON public.mortgage_handling_requests
  USING btree (check_intake_item_id, COALESCE(endorsement_order, 1)) WHERE (status = ANY (ARRAY['requested'::text, 'in_progress'::text]));
CREATE TABLE public.mortgage_ops_request_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mortgage_request_id uuid NOT NULL, actor_id uuid, action text NOT NULL,
  previous_agent_id uuid, reason text NOT NULL, from_status text, to_status text, accepted_at_preserved timestamptz,
  tenant_billing_event_id uuid, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.mortgage_agent_accounts (application_user_id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')));
-- The check thread (sql98To100Schema's shape) and the profiles SQL 158 reads the agent's name from.
CREATE TABLE public.check_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  check_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  body text NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 5000),
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, full_name text);
-- SQL 160's billing tables (its PostgreSQL test's shapes).
CREATE TABLE public.deposit_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid, provider public.deposit_provider);
CREATE TABLE public.check_billing_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, check_intake_item_id uuid,
  claim_id uuid, mortgage_request_id uuid, event_type text, unit_price_cents integer, currency text, status text,
  billed_at timestamptz, billing_period text, source_kind text, source_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, check_intake_item_id, event_type));
CREATE TABLE public.mortgage_ops_billing_launch (singleton boolean PRIMARY KEY, launched_at timestamptz);
CREATE TABLE public.mortgage_agent_compensation_rates (singleton boolean PRIMARY KEY, initial_cents integer, additional_cents integer);
CREATE TABLE public.mortgage_agent_compensation_exclusions (mortgage_request_id uuid);
CREATE TABLE public.mortgage_agent_compensation_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_entry_id uuid,
  agent_user_id uuid, mortgage_request_id uuid UNIQUE, check_intake_item_id uuid, claim_id uuid, tenant_id uuid, classification text,
  amount_cents integer, tenant_billing_event_id uuid, tenant_billing_event_type text, tenant_billing_amount_cents integer,
  accepted_at timestamptz, completed_at timestamptz, earned_at timestamptz, pay_period text, status text);
CREATE TABLE public.mortgage_agent_compensation_audit (entry_id uuid, actor_id uuid, action text, from_status text, to_status text, payload jsonb);
CREATE FUNCTION public.aws_check_billing_charges_when_per_check_off() RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION public.aws_check_billing_default_price_cents() RETURNS integer LANGUAGE sql AS 'SELECT 300';
-- SQL 160's test stand-ins for the live-only trigger functions.
CREATE FUNCTION public.tg_accrue_mortgage_ops_billing() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF NEW.accepted_at IS NULL THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('in_progress', 'completed') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.accepted_at IS NOT NULL AND OLD.status IN ('in_progress', 'completed') THEN RETURN NEW; END IF;
  PERFORM public.accrue_mortgage_ops_billing(NEW.id);
  RETURN NEW;
END $fn$;
CREATE FUNCTION public.tg_earn_mortgage_agent_compensation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET row_security TO 'off' AS $fn$
BEGIN
  IF NEW.status = 'completed' AND NEW.completed_at IS NOT NULL THEN
    BEGIN PERFORM public.earn_mortgage_agent_compensation(NEW.id); EXCEPTION WHEN unique_violation THEN NULL; END;
  END IF;
  RETURN NEW;
END $fn$;
-- SQL 167's relations and SQL 41's key function.
CREATE TABLE public.claims (id uuid PRIMARY KEY, org_id uuid, claim_number text UNIQUE, policyholder_name text);
CREATE TABLE public.signature_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, claim_id uuid);
CREATE TABLE public.check_audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid NOT NULL, event_type text NOT NULL,
  event_description text, event_data jsonb DEFAULT '{}'::jsonb, actor_id uuid, created_at timestamptz DEFAULT clock_timestamp(), tenant_id uuid);
CREATE TABLE public.claim_settlements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid NOT NULL, total_settlement numeric);
${sliceFrom('aws/write-path/sql/41_ocr_detected_claim_number.sql', 'CREATE OR REPLACE FUNCTION public.ocr_claim_number_key(p_value text)', '$$;')}
-- trg_auto_create_loss_draft as the Supabase migration defines it (live: aws/db-copy/analysis/triggers_classified.json).
CREATE TABLE public.check_payees (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid, payee_name text, payee_type text);
CREATE FUNCTION public.init_loss_draft_documents(_loss_draft_id uuid) RETURNS void LANGUAGE sql AS 'SELECT NULL';
${sliceFrom('supabase/migrations/20260826135843_496685d3-c1de-447a-bd7f-f8facb530817.sql', 'CREATE OR REPLACE FUNCTION public.trg_auto_create_loss_draft()', '$$;')}
-- SQL 47's inactive-agent accept guard.
${sliceFrom(SQL47, 'CREATE OR REPLACE FUNCTION public.aws_is_active_mortgage_agent(_user_id uuid DEFAULT auth.uid())', '$$;')}
${sliceFrom(SQL47, 'CREATE OR REPLACE FUNCTION public.tg_reject_inactive_mortgage_agent_accept()', '$$;')}
RESET ROLE;
`;

const TRIGGERS = `
SET ROLE checksops_admin;
CREATE TRIGGER tr_accrue_mortgage_ops_billing AFTER INSERT OR UPDATE ON public.mortgage_handling_requests FOR EACH ROW EXECUTE FUNCTION public.tg_accrue_mortgage_ops_billing();
CREATE TRIGGER tr_earn_mortgage_agent_compensation AFTER UPDATE OF status, completed_at ON public.mortgage_handling_requests FOR EACH ROW EXECUTE FUNCTION public.tg_earn_mortgage_agent_compensation();
CREATE TRIGGER tr_reject_inactive_mortgage_agent_accept BEFORE UPDATE OF status, assigned_employee_id ON public.mortgage_handling_requests FOR EACH ROW EXECUTE FUNCTION public.tg_reject_inactive_mortgage_agent_accept();
CREATE TRIGGER trg_auto_create_loss_draft AFTER UPDATE ON public.check_intake_items FOR EACH ROW EXECUTE FUNCTION public.trg_auto_create_loss_draft();
-- SQL 41's auto-link sets claim_id in a BEFORE trigger (stand-in: from detected_claim_id).
CREATE FUNCTION public.tg_auto_link_check_to_claim() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.claim_id IS NULL AND NEW.detected_claim_id IS NOT NULL THEN NEW.claim_id := NEW.detected_claim_id; END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_auto_link_check_to_claim_upd BEFORE UPDATE ON public.check_intake_items FOR EACH ROW EXECUTE FUNCTION public.tg_auto_link_check_to_claim();
-- A library-share trigger owned by another role, reading a table under RLS (as trg_share_library_docs_to_mortgage_request).
CREATE TABLE public.tenant_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, file_path text NOT NULL);
CREATE TABLE public.mortgage_request_library_documents (request_id uuid NOT NULL, file_path text NOT NULL);
ALTER TABLE public.tenant_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY lib_read ON public.tenant_documents FOR SELECT TO lib_owner USING (true);
GRANT SELECT ON public.tenant_documents TO lib_owner;
GRANT INSERT ON public.mortgage_request_library_documents TO lib_owner;
RESET ROLE;
CREATE FUNCTION public.share_library_docs_to_mortgage_request() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  INSERT INTO public.mortgage_request_library_documents (request_id, file_path)
  SELECT NEW.id, td.file_path FROM public.tenant_documents td WHERE td.tenant_id = NEW.tenant_id;
  RETURN NEW;
END $fn$;
ALTER FUNCTION public.share_library_docs_to_mortgage_request() OWNER TO lib_owner;
SET ROLE checksops_admin;
CREATE TRIGGER trg_share_library_docs_to_mortgage_request AFTER INSERT ON public.mortgage_handling_requests FOR EACH ROW EXECUTE FUNCTION public.share_library_docs_to_mortgage_request();
-- Row level security as on AWS; the API login (checksops) reads and writes checks and loss drafts through policies and
-- has nothing on the requests, the audit or the roster: only the DEFINER writes them.
ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loss_draft_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_handling_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_ops_request_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_agent_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_checks ON public.check_intake_items FOR ALL TO checksops USING (true) WITH CHECK (true);
CREATE POLICY api_loss_drafts ON public.loss_draft_tracking FOR ALL TO checksops USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public.check_intake_items, public.loss_draft_tracking TO checksops;
RESET ROLE;
`;

const SEED = `
INSERT INTO public.tenants (id) VALUES ('${T}'), ('${T2}');
INSERT INTO public.mortgage_ops_billing_launch VALUES (true, '2026-01-01T00:00:00Z');
INSERT INTO public.mortgage_agent_compensation_rates VALUES (true, 1000, 500);
INSERT INTO public.user_roles (user_id, role) VALUES ('${A1}', 'mortgage_agent'), ('${A2}', 'mortgage_agent'), ('${A3}', 'mortgage_agent'), ('${A4}', 'staff');
INSERT INTO public.mortgage_agent_accounts VALUES ('${A2}', 'active'), ('${A3}', 'inactive');
-- A1 has a name on file; A2 has a profile with a blank name (the message then names no one).
INSERT INTO public.profiles (id, full_name) VALUES ('${A1}', ' Alex Agent '), ('${A2}', '  ');
INSERT INTO public.tenant_documents (tenant_id, file_path) VALUES ('${T}', 'library/mortgage/w9.pdf');
INSERT INTO public.claims (id, org_id, claim_number, policyholder_name) VALUES ('${K}', '${T}', 'CLM-K', 'Kay'), ('${KX}', '${T}', 'CLM-X', 'Ex');
`;

/** The details the tenant typed on the earlier request; the routing copies them. */
const DETAILS = Object.freeze({
  mortgage_company: 'First Lender', mortgage_servicer: 'First Servicing', loan_number: 'LN-100', policy_number: 'POL-7',
  claim_number: 'CLM-K', insurance_company: 'Acme Mutual', loss_type: 'wind', date_of_loss: '2026-09-01',
  homeowner_name: 'Hana Owner', homeowner_email: 'hana@example.test', homeowner_phone: '555-0100',
  property_address: '1 Main St', homeowner_ssn_last_four: '1234',
});
const DETAIL_COLUMNS = Object.keys(DETAILS);

test('SQL 168: a new check with a loss draft on a claim the Desk handles is routed to the same active agent, from every fire point, and nothing else is touched (PostgreSQL 16)', { timeout: 300000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('sql168-', 62680);
  const connect = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const admin = await connect('ubuntu');
  const clients = [admin];
  try {
    await admin.query(ROLES);
    const fileText = fs.readFileSync(SQL168, 'utf8');
    const owner = await connect(OWNER);
    clients.push(owner);

    // Without its prerequisites the file refuses and installs nothing.
    await assert.rejects(owner.query(fileText), (error) => {
      assert.equal(error.code, '55000');
      assert.match(error.message, /^sql168_prerequisite_missing: .*missing public\.check_intake_items, public\.check_messages, public\.has_role\(uuid, public\.app_role\), public\.loss_draft_tracking, public\.mortgage_agent_accounts, public\.mortgage_handling_requests, public\.mortgage_ops_request_audit, public\.profiles$/);
      return true;
    });
    await admin.query(SCHEMA);
    await owner.query(fs.readFileSync(LIVE_BILLING, 'utf8'));
    await owner.query(fs.readFileSync(SQL160, 'utf8'));
    await admin.query(TRIGGERS);
    await owner.query(fs.readFileSync(SQL167, 'utf8'));
    await admin.query(SEED);
    // A column it copies missing: refused, by name.
    await owner.query('ALTER TABLE public.mortgage_handling_requests RENAME COLUMN homeowner_ssn_last_four TO ssn_moved');
    await assert.rejects(owner.query(fileText), /sql168_prerequisite_missing: .*missing column public\.mortgage_handling_requests\.homeowner_ssn_last_four$/);
    await owner.query('ALTER TABLE public.mortgage_handling_requests RENAME COLUMN ssn_moved TO homeowner_ssn_last_four');
    await owner.query('ALTER TABLE public.check_messages RENAME COLUMN sender_id TO sender_moved');
    await assert.rejects(owner.query(fileText), /sql168_prerequisite_missing: .*missing column public\.check_messages\.sender_id$/);
    await owner.query('ALTER TABLE public.check_messages RENAME COLUMN sender_moved TO sender_id');

    // A login that does not own the relations cannot install the DEFINER, nor can the owner while one is FORCE RLS.
    const other = await connect('other_admin');
    clients.push(other);
    await assert.rejects(other.query(fileText), /sql168_definer_cannot_reach: the login running SQL 168 must own check_intake_items, check_messages, loss_draft_tracking, mortgage_agent_accounts, mortgage_handling_requests, mortgage_ops_request_audit, profiles/);
    await owner.query('ALTER TABLE public.mortgage_ops_request_audit FORCE ROW LEVEL SECURITY');
    await assert.rejects(owner.query(fileText), /sql168_definer_cannot_reach: .*must own mortgage_ops_request_audit \(without FORCE/);
    await owner.query('ALTER TABLE public.mortgage_ops_request_audit NO FORCE ROW LEVEL SECURITY');
    assert.equal((await admin.query('SELECT to_regprocedure($1) IS NULL AS absent', [ROUTE])).rows[0].absent, true);

    // The source on claim K before SQL 168: C1 with its loss draft, the tenant's request R1 accepted by A1 (charged 1000).
    await owner.query(`INSERT INTO public.check_intake_items (id, tenant_id, claim_id, status, check_stage, check_source) VALUES ('${check(1)}', '${T}', '${K}', 'review', 'review', 'insurance')`);
    await owner.query(`INSERT INTO public.loss_draft_tracking (check_intake_item_id, claim_id, mortgage_servicer) VALUES ('${check(1)}', '${K}', 'First Servicing')`);
    await owner.query(`INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id, claim_id, status, requested_by, note, ${DETAIL_COLUMNS.join(', ')})
      VALUES ('${req(1)}', '${T}', '${check(1)}', '${K}', 'requested', '${ACTOR}', 'tenant note', ${DETAIL_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(DETAILS));
    await owner.query(`UPDATE public.mortgage_handling_requests SET assigned_employee_id = '${A1}', status = 'in_progress', accepted_at = COALESCE(accepted_at, now()), updated_at = now() WHERE id = '${req(1)}'`);

    await owner.query(fileText);
    const fns = async () => (await admin.query(`
      SELECT p.oid::regprocedure::text AS identity, p.oid, r.rolname AS owner, p.prosecdef, p.provolatile, p.proconfig, p.prosrc,
             pg_get_function_result(p.oid) AS result,
             ARRAY(SELECT coalesce(g.rolname, 'PUBLIC') || ' ' || a.privilege_type
                     FROM aclexplode(p.proacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee ORDER BY 1) AS acl
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname LIKE 'aws_mortgage_desk_route_same_agent%' ORDER BY 1`)).rows;
    const triggers = async () => (await admin.query(`SET search_path = pg_catalog;
      SELECT t.tgrelid::regclass::text AS tbl, t.tgname, t.tgenabled, pg_catalog.pg_get_triggerdef(t.oid) AS def
        FROM pg_catalog.pg_trigger t WHERE t.tgname LIKE 'aws_%route_same_agent' ORDER BY 2; RESET search_path;`))[1].rows;
    const first = await fns();
    assert.deepEqual(first.map((f) => [f.identity, f.owner, f.prosecdef, f.provolatile, f.proconfig, f.result, f.acl]), [
      ['aws_mortgage_desk_route_same_agent(uuid,text)', OWNER, true, 'v', ['search_path=public, pg_temp', 'row_security=on'], 'uuid', ['checksops_admin EXECUTE']],
      ['aws_mortgage_desk_route_same_agent_trigger()', OWNER, true, 'v', ['search_path=public, pg_temp', 'row_security=on'], 'trigger', ['checksops_admin EXECUTE']],
    ]);
    const firstTriggers = await triggers();
    assert.deepEqual(firstTriggers, [
      { tbl: 'public.check_intake_items', tgname: 'aws_check_claim_route_same_agent', tgenabled: 'O',
        def: 'CREATE TRIGGER aws_check_claim_route_same_agent AFTER UPDATE ON public.check_intake_items FOR EACH ROW WHEN (((new.claim_id IS NOT NULL) AND (old.claim_id IS DISTINCT FROM new.claim_id))) EXECUTE FUNCTION public.aws_mortgage_desk_route_same_agent_trigger()' },
      { tbl: 'public.loss_draft_tracking', tgname: 'aws_loss_draft_route_same_agent', tgenabled: 'O',
        def: 'CREATE TRIGGER aws_loss_draft_route_same_agent AFTER INSERT ON public.loss_draft_tracking FOR EACH ROW EXECUTE FUNCTION public.aws_mortgage_desk_route_same_agent_trigger()' },
    ]);
    // Idempotent: a second run leaves the same functions (same oids) and the same triggers.
    await owner.query(fileText);
    assert.deepEqual(await fns(), first);
    assert.deepEqual(await triggers(), firstTriggers);
    // Nobody but the owner can call either function.
    for (const role of ['checksops', 'authenticated', 'anon', 'service_role']) {
      await assert.rejects(admin.query(`SET ROLE ${role}; SELECT public.aws_mortgage_desk_route_same_agent(NULL, NULL);`), /permission denied for function aws_mortgage_desk_route_same_agent/, role);
      await admin.query('RESET ROLE');
    }
    // Installing it changed no row (the source's request and its charge as they were).
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.mortgage_handling_requests')).rows[0].n, 1);

    const api = await connect('checksops');
    clients.push(api);
    const requestsOf = async (checkId) => (await admin.query(`SELECT *, date_of_loss::text AS date_of_loss_text FROM public.mortgage_handling_requests WHERE check_intake_item_id = $1 ORDER BY created_at`, [checkId])).rows;
    const auditOf = async (requestId) => (await admin.query(`SELECT actor_id, action, reason, from_status, to_status, payload FROM public.mortgage_ops_request_audit WHERE mortgage_request_id = $1`, [requestId])).rows;
    const messagesOf = async (checkId) => (await admin.query(`SELECT id, check_id, sender_id, body, is_deleted FROM public.check_messages WHERE check_id = $1 ORDER BY created_at`, [checkId])).rows;
    const NAMED = (name) => `ChecksOps Mortgage Desk added this check to ${name}'s file automatically (same claim).`;
    const UNNAMED = "ChecksOps Mortgage Desk added this check to the agent already handling this claim's file automatically (same claim).";
    /** Nothing routed: no request and no message on the check. */
    const assertNotRouted = async (n, label = `check ${n}`) => {
      assert.deepEqual(await requestsOf(check(n)), [], label);
      assert.deepEqual(await messagesOf(check(n)), [], label);
    };
    const eventsOf = async (checkId) => (await admin.query(`SELECT event_type, unit_price_cents FROM public.check_billing_events WHERE check_intake_item_id = $1 ORDER BY event_type`, [checkId])).rows;
    const snapshotRequests = async () => (await admin.query(`SELECT jsonb_object_agg(id, jsonb_build_object('xmin', xmin::text, 'row', to_jsonb(r))) AS m FROM public.mortgage_handling_requests r`)).rows[0].m;
    const addCheck = async (n, { tenant = T, claim = K, stage = 'review', deposited = null, status = 'review' } = {}) => owner.query(
      `INSERT INTO public.check_intake_items (id, tenant_id, claim_id, status, check_stage, check_source, deposited_at, amount) VALUES ($1, $2, $3, $4, $5, 'insurance', $6, 2500)`,
      [check(n), tenant, claim, status, stage, deposited]);
    const addLossDraft = async (n, client = api) => client.query(
      `INSERT INTO public.loss_draft_tracking (check_intake_item_id, mortgage_servicer) VALUES ($1, 'Servicer')`, [check(n)]);
    /** A request the routing created: in progress, the agent, accepted now, the claim, order 1, the source's details, one audit row. */
    const assertRouted = async (n, { agent, claim, source, firedBy, details = DETAILS, body = agent === A1 ? NAMED('Alex Agent') : UNNAMED }) => {
      const rows = await requestsOf(check(n));
      assert.equal(rows.length, 1, `check ${n}: ${JSON.stringify(rows)}`);
      const [r] = rows;
      assert.equal(r.status, 'in_progress');
      assert.equal(r.assigned_employee_id, agent);
      assert.ok(r.accepted_at instanceof Date);
      assert.equal(r.tenant_id, T);
      assert.equal(r.claim_id, claim);
      assert.equal(r.endorsement_order, 1);
      for (const k of ['total_mortgagees', 'predecessor_request_id', 'requested_by', 'note', 'work_notes', 'completed_at', 'cancelled_at']) assert.equal(r[k], null, k);
      const copied = Object.fromEntries(DETAIL_COLUMNS.map((k) => [k, k === 'date_of_loss' ? r.date_of_loss_text : r[k]]));
      assert.deepEqual(copied, details);
      // The source: the given request, or (LATEST) the most recently accepted in-progress 1st-mortgagee request of the
      // agent on another check of the claim, as it was before this routing (an earlier routed request counts).
      const expected = source === LATEST
        ? { ...(await admin.query(`SELECT r.id, r.check_intake_item_id AS check, r.status FROM public.mortgage_handling_requests r
              JOIN public.check_intake_items c ON c.id = r.check_intake_item_id
             WHERE c.claim_id = $1 AND r.check_intake_item_id <> $2 AND r.status = 'in_progress' AND COALESCE(r.endorsement_order, 1) = 1
               AND r.assigned_employee_id = $3 AND r.accepted_at < $4 ORDER BY r.accepted_at DESC LIMIT 1`, [claim, check(n), agent, r.accepted_at])).rows[0] }
        : source;
      // One message on the new check's thread, sent by the agent, visible (not deleted), naming the agent when it can.
      const messages = await messagesOf(check(n));
      assert.equal(messages.length, 1, `check ${n} messages: ${JSON.stringify(messages)}`);
      assert.deepEqual({ ...messages[0], id: undefined }, { id: undefined, check_id: check(n), sender_id: agent, body, is_deleted: false });
      assert.match(messages[0].body, /^ChecksOps Mortgage Desk added this check to .+'s file automatically \(same claim\)\.$/);
      assert.deepEqual(await auditOf(r.id), [{
        actor_id: null, action: 'auto_route_same_agent', reason: 'Routed to the agent who handled an earlier check on this claim',
        from_status: 'requested', to_status: 'in_progress',
        payload: { agent_id: agent, source_request_id: expected.id, source_check_id: expected.check, source_request_status: expected.status, claim_id: claim, message_id: messages[0].id, fired_by: firedBy, source: 'sql168' },
      }]);
      return r;
    };
    const SOURCE_R1 = { id: req(1), check: check(1), status: 'in_progress' };
    const LATEST = Symbol('latest');

    // 1) The main path: the API inserts the new check's loss draft; the request is created and accepted for A1.
    const beforeMain = await snapshotRequests();
    await addCheck(2);
    await addLossDraft(2);
    const r2 = await assertRouted(2, { agent: A1, claim: K, source: SOURCE_R1, firedBy: 'loss_draft_tracking' });
    // The INSERT fired the library share (as a tenant's send does), the accept fired the billing trigger: no charge, as
    // the claim already has R1's mortgage_ops_initial (SQL 160).
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.mortgage_request_library_documents WHERE request_id = $1', [r2.id])).rows[0].n, 1);
    assert.deepEqual(await eventsOf(check(1)), [{ event_type: 'mortgage_ops_initial', unit_price_cents: 1000 }]);
    assert.deepEqual(await eventsOf(check(2)), []);
    // The existing request is untouched.
    const afterMain = await snapshotRequests();
    assert.deepEqual(afterMain[req(1)], beforeMain[req(1)]);
    // Again (a direct call, as the owner): the check now has an open request; nothing.
    assert.equal((await owner.query(`SELECT public.aws_mortgage_desk_route_same_agent($1, 'test') AS r`, [check(2)])).rows[0].r, null);
    assert.equal((await messagesOf(check(2))).length, 1);
    assert.deepEqual(await snapshotRequests(), afterMain);

    // 2) Never: locked checks, no loss draft, no claim, a request already requested / in progress / completed.
    await addCheck(3, { deposited: '2026-11-01T00:00:00Z' });
    await addCheck(4, { stage: 'voided' });
    await addCheck(5, { stage: 'returned' });
    await addCheck(6, { stage: 'deposited' });
    for (const n of [3, 4, 5, 6]) await addLossDraft(n);
    await addCheck(7);
    await owner.query(`INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id, claim_id, status) VALUES ('${req(7)}', '${T}', '${check(7)}', '${K}', 'requested')`);
    await addCheck(8);
    await owner.query(`INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id, claim_id, status, assigned_employee_id, accepted_at, completed_at)
      VALUES ('${req(8)}', '${T}', '${check(8)}', '${K}', 'completed', '${A2}', now(), now())`);
    // A 2nd-mortgagee request open on the check counts as open too.
    await addCheck(9);
    await owner.query(`INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id, claim_id, status, endorsement_order, total_mortgagees) VALUES ('${req(9)}', '${T}', '${check(9)}', '${K}', 'requested', 2, 2)`);
    const beforeNever = await snapshotRequests();
    for (const n of [7, 8, 9]) await addLossDraft(n);
    for (const n of [3, 4, 5, 6]) await assertNotRouted(n, `locked check ${n}`);
    assert.deepEqual(await snapshotRequests(), beforeNever, 'existing requests untouched, none added');
    for (const n of [7, 8, 9]) assert.deepEqual(await messagesOf(check(n)), [], `check ${n} has a request: no message`);
    // A cancelled request does not count: the check is routed.
    await addCheck(10);
    await owner.query(`INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id, claim_id, status, cancelled_at) VALUES ('${req(10)}', '${T}', '${check(10)}', '${K}', 'cancelled', now())`);
    await addLossDraft(10);
    assert.deepEqual((await requestsOf(check(10))).map((r) => [r.status, r.assigned_employee_id]), [['cancelled', null], ['in_progress', A1]]);
    // A check with a claim but no loss draft: nothing (its claim is set; the loss draft is the other half).
    await addCheck(11, { claim: null });
    await api.query(`UPDATE public.check_intake_items SET claim_id = '${K}' WHERE id = $1`, [check(11)]);
    await assertNotRouted(11);

    // 3) The claim link fire points, on checks that already have their loss draft.
    // a. The Review save: claim_id set from NULL by the API.
    await addCheck(12, { claim: null });
    await addLossDraft(12);
    await assertNotRouted(12, 'no claim yet');
    await api.query(`UPDATE public.check_intake_items SET claim_id = '${K}' WHERE id = $1`, [check(12)]);
    await assertRouted(12, { agent: A1, claim: K, source: LATEST, firedBy: 'check_intake_items' });
    // b. SQL 41's auto-link: claim_id is not in the UPDATE; the BEFORE trigger sets it, the WHEN sees it.
    await addCheck(13, { claim: null });
    await addLossDraft(13);
    await api.query(`UPDATE public.check_intake_items SET detected_claim_id = '${K}' WHERE id = $1`, [check(13)]);
    await assertRouted(13, { agent: A1, claim: K, source: LATEST, firedBy: 'check_intake_items' });
    // c. SQL 167's relink (DEFINER with row_security = off) from the wrong claim to K. Under row_security = off the library
    // share (owned by another role, reading a table under RLS) would fail; SQL 168 sets it back on.
    await assert.rejects(owner.query(`BEGIN; SET LOCAL row_security = off; INSERT INTO public.mortgage_handling_requests (tenant_id, check_intake_item_id, claim_id) VALUES ('${T}', '${check(11)}', '${KX}');`),
      /query would be affected by row-level security policy for table "tenant_documents"/);
    await owner.query('ROLLBACK');
    await addCheck(14, { claim: KX });
    await addLossDraft(14);
    await assertNotRouted(14, 'no handled check on the wrong claim');
    const relinked = (await api.query(`SELECT public.claim_ledger_relink_check($1, $2, 'CLM-K', 'relink', $3) AS r`, [check(14), T, ACTOR])).rows[0].r;
    assert.equal(relinked.code, 'relinked');
    await assertRouted(14, { agent: A1, claim: K, source: LATEST, firedBy: 'check_intake_items' });
    // d. An update that leaves claim_id as it is does not fire (WHEN); a change to a claim with no handled check does nothing.
    await addCheck(15, { claim: KX });
    await addLossDraft(15);
    await api.query(`UPDATE public.check_intake_items SET status = 'review_saved' WHERE id = $1`, [check(15)]);
    await assertNotRouted(15);
    // e. trg_auto_create_loss_draft: the check becomes loss_draft_required; the loss draft it inserts fires the routing.
    await addCheck(16);
    await assertNotRouted(16);
    await api.query(`UPDATE public.check_intake_items SET status = 'loss_draft_required' WHERE id = $1`, [check(16)]);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.loss_draft_tracking WHERE check_intake_item_id = $1', [check(16)])).rows[0].n, 1);
    await assertRouted(16, { agent: A1, claim: K, source: LATEST, firedBy: 'loss_draft_tracking' });

    // 4) Which agent. Claim K2: completed by A2 (latest completion), in progress by A3 (inactive, latest accept), in
    // progress by A1 (earlier accept), a 2nd mortgagee in progress by A2 (latest of all), A1 queued elsewhere: A1.
    const source = async (n, claim, status, agent, at, extra = {}) => {
      await addCheck(n, { claim });
      const cols = { endorsement_order: null, total_mortgagees: null, ...extra };
      await owner.query(`INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id, claim_id, status, assigned_employee_id, accepted_at, completed_at, created_at, endorsement_order, total_mortgagees, loan_number)
        VALUES ($1, '${T}', $2, $3, $4, $5, $6::timestamptz, CASE WHEN $4 = 'completed' THEN $6::timestamptz + interval '1 day' END, COALESCE($6::timestamptz, now()) - interval '1 hour', $7, $8, $9)`,
      [req(n), check(n), claim, status, agent, at, cols.endorsement_order, cols.total_mortgagees, `LN-${n}`]);
    };
    await source(20, K2, 'completed', A2, '2026-11-10T00:00:00Z');
    await source(21, K2, 'in_progress', A3, '2026-11-09T00:00:00Z');
    await source(22, K2, 'in_progress', A1, '2026-11-01T00:00:00Z');
    await source(23, K2, 'in_progress', A2, '2026-11-12T00:00:00Z', { endorsement_order: 2, total_mortgagees: 2 });
    await source(24, K2, 'requested', null, null);
    await addCheck(25, { claim: K2 });
    await addLossDraft(25);
    const k2 = (await requestsOf(check(25)))[0];
    assert.deepEqual([k2.assigned_employee_id, k2.loan_number], [A1, 'LN-22']);
    assert.equal((await auditOf(k2.id))[0].payload.source_request_id, req(22));
    assert.deepEqual((await messagesOf(check(25))).map((m) => [m.sender_id, m.body]), [[A1, NAMED('Alex Agent')]]);
    // Claim K3: no in-progress request; completed by A2 (earlier) and by A4 (later, but not a mortgage agent), a cancelled
    // one by A1: the most recent completed whose agent is active, A2.
    await source(30, K3, 'completed', A2, '2026-10-01T00:00:00Z');
    await source(31, K3, 'completed', A4, '2026-10-05T00:00:00Z');
    await source(32, K3, 'cancelled', A1, '2026-10-06T00:00:00Z');
    await addCheck(33, { claim: K3 });
    await addLossDraft(33);
    assert.deepEqual((await requestsOf(check(33))).map((r) => [r.status, r.assigned_employee_id, r.loan_number]), [['in_progress', A2, 'LN-30']]);
    // A2's profile has no name: the message names no one.
    assert.deepEqual((await messagesOf(check(33))).map((m) => [m.sender_id, m.body]), [[A2, UNNAMED]]);
    // Claim K4: only an inactive agent's and a queued request: nothing, the tenant sends as today.
    await source(40, K4, 'completed', A3, '2026-10-01T00:00:00Z');
    await source(41, K4, 'requested', null, null);
    await addCheck(42, { claim: K4 });
    await addLossDraft(42);
    await assertNotRouted(42);
    // Another tenant's check on claim K (a legacy claim both link): never routed from tenant T's request.
    await addCheck(43, { tenant: T2, claim: K });
    await addLossDraft(43);
    await assertNotRouted(43);
    // The source's agent deactivated after the routing: later checks fall back (here: none left on K but A2's completed
    // request on C8, so A2).
    await owner.query(`INSERT INTO public.mortgage_agent_accounts VALUES ('${A1}', 'inactive')`);
    await addCheck(44);
    await addLossDraft(44);
    assert.deepEqual((await requestsOf(check(44))).map((r) => [r.status, r.assigned_employee_id]), [['in_progress', A2]]);
    await owner.query(`DELETE FROM public.mortgage_agent_accounts WHERE application_user_id = '${A1}'`);

    // 5) A failure inside the routing rolls back only the routing: the tenant's loss draft is saved, no request, no charge.
    await owner.query(`CREATE FUNCTION public.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'audit down'; END $f$;
      CREATE TRIGGER fail_audit BEFORE INSERT ON public.mortgage_ops_request_audit FOR EACH ROW EXECUTE FUNCTION public.fail_audit();`);
    await addCheck(50);
    await addLossDraft(50);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.loss_draft_tracking WHERE check_intake_item_id = $1', [check(50)])).rows[0].n, 1);
    await assertNotRouted(50);
    assert.deepEqual(await eventsOf(check(50)), []);
    await owner.query('DROP TRIGGER fail_audit ON public.mortgage_ops_request_audit; DROP FUNCTION public.fail_audit();');
    // A failed message rolls back the request and its accept too (the same subtransaction).
    await owner.query(`CREATE FUNCTION public.fail_message() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'thread down'; END $f$;
      CREATE TRIGGER fail_message BEFORE INSERT ON public.check_messages FOR EACH ROW EXECUTE FUNCTION public.fail_message();`);
    await addCheck(51);
    await addLossDraft(51);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.loss_draft_tracking WHERE check_intake_item_id = $1', [check(51)])).rows[0].n, 1);
    await assertNotRouted(51);
    assert.deepEqual(await eventsOf(check(51)), []);
    await owner.query('DROP TRIGGER fail_message ON public.check_messages; DROP FUNCTION public.fail_message();');

    // 6) Billing through SQL 160, unchanged. The claim's first charge is R1's; the routed checks record none. A claim
    // whose handled check was accepted before the Mortgage Ops billing launch has no charge: the routed check records
    // mortgage_ops_initial at the tenant's initial rate.
    for (const n of [2, 10, 12, 13, 14, 16, 25, 33, 44]) assert.deepEqual(await eventsOf(check(n)), [], `check ${n}`);
    await source(60, K5, 'in_progress', A1, '2025-12-01T00:00:00Z');
    assert.deepEqual(await eventsOf(check(60)), []);
    await addCheck(61, { claim: K5 });
    await addLossDraft(61);
    assert.equal((await requestsOf(check(61)))[0].assigned_employee_id, A1);
    assert.deepEqual(await eventsOf(check(61)), [{ event_type: 'mortgage_ops_initial', unit_price_cents: 1000 }]);
    // Agent pay (SQL 160, at completion): a routed request completed after the claim's source completed earns nothing; one
    // completed while the source is still in progress earns the initial amount (no other completed request yet).
    const complete = (requestId) => owner.query(`UPDATE public.mortgage_handling_requests SET status = 'completed', completed_at = now() WHERE id = $1`, [requestId]);
    const payOf = async (requestId) => (await admin.query('SELECT classification, amount_cents FROM public.mortgage_agent_compensation_entries WHERE mortgage_request_id = $1', [requestId])).rows;
    await source(70, KC, 'in_progress', A2, '2026-11-02T00:00:00Z');
    await complete(req(70));
    await addCheck(71, { claim: KC });
    await addLossDraft(71);
    const r71 = (await requestsOf(check(71)))[0];
    assert.equal(r71.assigned_employee_id, A2);
    await complete(r71.id);
    assert.deepEqual(await payOf(r71.id), []);
    await source(80, KD, 'in_progress', A2, '2026-11-03T00:00:00Z');
    await addCheck(81, { claim: KD });
    await addLossDraft(81);
    const r81 = (await requestsOf(check(81)))[0];
    assert.equal(r81.assigned_employee_id, A2);
    assert.deepEqual(await eventsOf(check(80)), [{ event_type: 'mortgage_ops_initial', unit_price_cents: 1000 }]);
    assert.deepEqual(await eventsOf(check(81)), []);
    await complete(r81.id);
    assert.deepEqual(await payOf(r81.id), [{ classification: 'initial', amount_cents: 1000 }]);
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    server.stop();
  }
});
