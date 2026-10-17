/**
 * PostgreSQL 16 fixture for the release 2026-10-17 SQL (SQL 90 to SQL 97, with SQL 29 and
 * SQL 30 as predecessors), in one database, owned like production:
 *
 *   - the real AWS RLS helper files (aws/rls/sql 01, 02, 03, 10, 11, 15, 20) and the real
 *     SQL 77 / SQL 78 tables (helpers/stakeholder-policies-pg.mjs applyBaseSchema);
 *   - the tables SQL 90 to SQL 97 read or change, with their real policies copied out of
 *     aws/rls/sql 12 / 21 / 24 where one exists, the real SQL 80 function and SQL 35's
 *     manager helper and views;
 *   - the Mortgage Ops library tables SQL 29 / SQL 30 / SQL 94 need, with the Lovable
 *     policies and the 6-value doc_type CHECK;
 *   - the retired Freedom Claims bridge objects SQL 95 drops (stand-ins with the real names);
 *   - every object in schema public is then owned by a non-superuser checksops_admin LOGIN
 *     (production's admin login); checksops (the API login) is a member of authenticated.
 *
 * applyPredecessors(admin) runs the real SQL 29 and SQL 30 files as checksops_admin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AWS_ROOT, applyBaseSchema, pgSkipReason, policyBlock, startPg } from './stakeholder-policies-pg.mjs';

export { pgSkipReason };
export const REPO_ROOT = path.join(AWS_ROOT, '..');
export const SQL29_FILE = path.join(AWS_ROOT, 'rls/sql/29_mortgage_ops_library_parity.sql');
export const SQL30_FILE = path.join(AWS_ROOT, 'rls/sql/30_tenant_documents_mortgage_doc_type.sql');
const SQL80_FILE = path.join(AWS_ROOT, 'workflows/sql/80_checkalt_member_auto_deposit.sql');
const SQL35_FILE = path.join(AWS_ROOT, 'rls/sql/35_manager_partner_parity.sql');

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '33333333-3333-4333-8333-333333333333';
export const MEMBER_A = 'a1000000-0000-4000-8000-000000000001';
export const MEMBER_B = 'a1000000-0000-4000-8000-000000000009';
export const PLATFORM_OWNER = 'a1000000-0000-4000-8000-00000000000b';
export const CHECK_A = '55555555-5555-4555-8555-555555555555';
export const CLAIM_A = '66666666-6666-4666-8666-666666666666';

/** SQL 35 without tenants_public (its tenants columns are not in this fixture). */
const sql35ManagerViews = () => {
  const text = fs.readFileSync(SQL35_FILE, 'utf8');
  const fnEnd = text.indexOf('-- Active-tenant public columns only.');
  const viewsStart = text.indexOf('-- Non-secret CheckAlt settings');
  if (!(fnEnd > 0 && viewsStart > fnEnd)) throw new Error('SQL 35 layout changed');
  return text.slice(0, fnEnd) + text.slice(viewsStart);
};

const TABLES = `
CREATE TABLE public.recipient_tax_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, recipient_key text NOT NULL, tin text);
CREATE TABLE public.checkalt_tenant_accounts (
  tenant_id uuid PRIMARY KEY, auto_approve_enabled boolean NOT NULL DEFAULT false,
  auto_approve_max_cents integer, updated_at timestamptz DEFAULT now());
CREATE TABLE public.tenant_email_settings (tenant_id uuid PRIMARY KEY, from_name text);
CREATE TABLE public.checkalt_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), singleton boolean NOT NULL DEFAULT true, base_url text, merchant text,
  fi_key text, business_unit text, depositor_account_id text, default_enabled boolean, auto_approve_enabled boolean,
  auto_approve_max_cents integer, notes text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  updated_by uuid);
CREATE TABLE public.deposit_provider_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text, display_name text, is_active boolean, is_stubbed boolean,
  capabilities jsonb, config jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
ALTER TABLE public.identity_accounts ADD COLUMN cognito_sub text UNIQUE, ADD COLUMN linked_at timestamptz,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.profiles ADD COLUMN full_name text;
CREATE TABLE public.pii_reveal_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, field_name text);
CREATE TABLE public.user_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, is_active boolean DEFAULT true);
CREATE TABLE public.contractor_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, tier text DEFAULT 'basic');
CREATE TYPE public.deposit_provider AS ENUM ('checkalt', 'manual_branch');
ALTER TABLE public.deposit_items ADD COLUMN amount numeric, ADD COLUMN status text, ADD COLUMN batch_id uuid;
CREATE TABLE public.deposit_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider public.deposit_provider, total_items integer NOT NULL DEFAULT 0,
  total_amount numeric NOT NULL DEFAULT 0, created_by uuid, updated_at timestamptz DEFAULT now());
CREATE TABLE public.homeowner_check_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contractor_user_id uuid, converted_check_id uuid);
CREATE TABLE public.referral_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), referrer_tenant_id uuid, referred_tenant_id uuid);
CREATE TABLE public.tenant_partnerships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inviter_tenant_id uuid, invitee_tenant_id uuid, status text);
-- Mortgage Ops library (SQL 29 / SQL 30 / SQL 94).
CREATE TABLE public.tenant_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  doc_type text NOT NULL, file_path text NOT NULL, file_name text NOT NULL, mime_type text, file_size bigint,
  uploaded_by uuid, notes text, auto_share_mortgage_ops boolean NOT NULL DEFAULT false,
  shared_with_homeowners boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenant_documents ADD CONSTRAINT tenant_documents_doc_type_check
  CHECK (doc_type IN ('w9','license','insurance','saas_agreement','terms_of_service','privacy_policy'));
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid, status text NOT NULL DEFAULT 'requested', assigned_employee_id uuid);
CREATE TABLE public.mortgage_request_library_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.mortgage_handling_requests(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL, tenant_document_id uuid REFERENCES public.tenant_documents(id) ON DELETE SET NULL,
  doc_type text NOT NULL, file_name text NOT NULL, file_path text NOT NULL, mime_type text, file_size bigint,
  bucket text NOT NULL DEFAULT 'tenant-documents', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, file_path));
CREATE TABLE public.homeowner_ledger_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, claim_id uuid, token text NOT NULL,
  homeowner_email text, homeowner_name text, revoked_at timestamptz, expires_at timestamptz, last_viewed_at timestamptz);
CREATE TABLE public.homeowner_ledger_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, claim_id uuid NOT NULL);
CREATE FUNCTION public.share_library_docs_to_mortgage_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.mortgage_request_library_documents
    (request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path, mime_type, file_size)
  SELECT NEW.id, NEW.tenant_id, td.id, td.doc_type, td.file_name, td.file_path, td.mime_type, td.file_size
  FROM public.tenant_documents td
  WHERE td.tenant_id = NEW.tenant_id AND td.auto_share_mortgage_ops = true AND td.doc_type LIKE 'library:mortgage:%'
  ON CONFLICT (request_id, file_path) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER share_library_docs_on_mortgage_request AFTER INSERT ON public.mortgage_handling_requests
  FOR EACH ROW EXECUTE FUNCTION public.share_library_docs_to_mortgage_request();
ALTER TABLE public.mortgage_request_library_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read shared library docs" ON public.mortgage_request_library_documents FOR SELECT TO authenticated USING (true);
CREATE POLICY "manage shared library docs" ON public.mortgage_request_library_documents FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "delete shared library docs" ON public.mortgage_request_library_documents FOR DELETE TO authenticated USING (true);
ALTER TABLE public.tenant_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY aws_select_tenant_documents ON public.tenant_documents FOR SELECT TO authenticated USING (public.aws_can_access_tenant(tenant_id));
-- Payments (SQL 91).
CREATE TABLE public.payment_provider_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, environment text NOT NULL, provider_account_id text, onboarding_status text);
CREATE TABLE public.payment_provider_methods (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, environment text, last_four text);
CREATE TABLE public.payment_method_verifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, status text);
CREATE TABLE public.payment_event_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, event_type text);
CREATE TABLE public.payment_idempotency_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, idempotency_key text, status text);
-- Signature request links (SQL 92).
CREATE TABLE public.check_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid NOT NULL, file_path text, signature_request_id uuid);
-- Platform fees (SQL 96).
CREATE TABLE public.platform_fee_schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, fee_cents integer);
-- Step-up log (SQL 97).
CREATE TABLE public.financial_stepup_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, tenant_id uuid,
  action_key text NOT NULL, factor_type text, succeeded boolean, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now());
-- Retired Freedom Claims bridge (SQL 95 drops these).
CREATE FUNCTION public.notify_freedom_status_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER trg_notify_freedom_status_change AFTER UPDATE ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.notify_freedom_status_change();
CREATE FUNCTION public.list_checks_by_freedom_claim(_claim text, _tenant uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT id FROM public.check_intake_items WHERE tenant_id = _tenant $$;
CREATE FUNCTION public.aws_ingest_shared_check(_payload jsonb) RETURNS uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION public.vault_create_bridge_secret(_secret text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public.vault_update_bridge_secret(_secret text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
`;

const RLS_TABLES = Object.freeze([
  'tenant_users', 'tenants', 'recipient_tax_profiles', 'user_roles', 'tenant_email_settings', 'checkalt_tenant_accounts',
  'profiles', 'pii_reveal_logs', 'user_sessions', 'contractor_profiles', 'deposit_batches', 'homeowner_check_uploads',
  'referral_events', 'tenant_partnerships', 'payment_provider_accounts', 'payment_provider_methods',
  'payment_method_verifications', 'payment_event_log', 'payment_idempotency_keys', 'check_files', 'platform_fee_schedules',
]);

const POLICIES = Object.freeze([
  ['12_final_select_policies.sql', 'aws_select_tenant_users'],
  ['12_final_select_policies.sql', 'aws_select_tenants'],
  ['12_final_select_policies.sql', 'aws_select_user_roles'],
  ['24_complete_write_policies.sql', 'aws_write_tenant_users'],
  ['21_proposed_write_policies.sql', 'aws_write_tenants'],
  ['21_proposed_write_policies.sql', 'aws_write_user_roles'],
  ['24_complete_write_policies.sql', 'aws_write_recipient_tax_profiles'],
  ['12_final_select_policies.sql', 'aws_select_recipient_tax_profiles'],
  ['21_proposed_write_policies.sql', 'aws_write_tenant_email_settings'],
  ['24_complete_write_policies.sql', 'aws_write_checkalt_tenant_accounts'],
  ['24_complete_write_policies.sql', 'aws_write_profiles'],
  ['12_final_select_policies.sql', 'aws_select_profiles'],
  ['24_complete_write_policies.sql', 'aws_write_pii_reveal_logs'],
  ['24_complete_write_policies.sql', 'aws_write_user_sessions'],
  ['24_complete_write_policies.sql', 'aws_write_contractor_profiles'],
  ['24_complete_write_policies.sql', 'aws_write_deposit_batches'],
  ['24_complete_write_policies.sql', 'aws_write_homeowner_check_uploads'],
  ['24_complete_write_policies.sql', 'aws_write_referral_events'],
  ['24_complete_write_policies.sql', 'aws_write_tenant_partnerships'],
  ['24_complete_write_policies.sql', 'aws_write_check_files'],
  ['24_complete_write_policies.sql', 'aws_write_platform_fee_schedules'],
]);

const SEED = `
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B');
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
  ('${MEMBER_A}', 'member-a@example.invalid', 'active'), ('${MEMBER_B}', 'member-b@example.invalid', 'active'),
  ('${PLATFORM_OWNER}', 'checksopsadmin@gmail.com', 'active');
INSERT INTO public.profiles (id, email) SELECT application_user_id, email FROM public.identity_accounts;
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT_A}', '${MEMBER_A}', 'viewer'), ('${TENANT_B}', '${MEMBER_B}', 'owner');
INSERT INTO public.check_intake_items (id, tenant_id, claim_id) VALUES ('${CHECK_A}', '${TENANT_A}', '${CLAIM_A}');
INSERT INTO public.claims (id, org_id) VALUES ('${CLAIM_A}', '${TENANT_A}');
INSERT INTO public.checkalt_tenant_accounts (tenant_id) VALUES ('${TENANT_A}');
INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name)
  VALUES ('${TENANT_A}', 'w9', '${TENANT_A}/library/w9.pdf', 'Private W-9.pdf');
INSERT INTO public.financial_stepup_log (user_id, tenant_id, action_key, metadata)
  VALUES ('${MEMBER_A}', '${TENANT_A}', 'deposit.submit', '{"source": "app_financial_totp"}');
`;

const OWNERSHIP = `
DO $own$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS o, c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') LOOP
    EXECUTE format('ALTER %s %s OWNER TO checksops_admin', CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, r.o);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO checksops_admin', r.f);
  END LOOP;
  FOR r IN SELECT t.oid::regtype AS t FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd') LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO checksops_admin', r.t);
  END LOOP;
END
$own$;
`;

/** Starts a server and builds the schema; returns { server, admin, connectAs, applyPredecessors, close }. */
export async function releaseFixture(pg, prefix, port) {
  const server = startPg(prefix, port);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  try {
    await applyBaseSchema(admin);
    await admin.query(TABLES);
    for (const table of RLS_TABLES) {
      await admin.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO checksops`);
    }
    for (const [file, name] of POLICIES) await admin.query(policyBlock(file, name));
    await admin.query(fs.readFileSync(SQL80_FILE, 'utf8'));
    await admin.query(sql35ManagerViews());
    await admin.query(`
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO checksops, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.mortgage_request_library_documents TO checksops, authenticated;
      GRANT INSERT, UPDATE ON public.tenant_documents TO checksops;
      GRANT SELECT, INSERT ON TABLE public.financial_stepup_log TO authenticated;
      CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin;
      GRANT USAGE ON SCHEMA auth TO checksops_admin, authenticated;`);
    await admin.query(SEED);
    await admin.query(OWNERSHIP);
  } catch (error) {
    await admin.end().catch(() => {});
    server.stop();
    throw error;
  }
  return {
    server,
    admin,
    connectAs,
    /** The real SQL 29 and SQL 30 files, run as checksops_admin. */
    async applyPredecessors({ sql29 = true, sql30 = true } = {}) {
      const owner = await connectAs('checksops_admin');
      try {
        if (sql29) await owner.query(fs.readFileSync(SQL29_FILE, 'utf8'));
        if (sql30) await owner.query(fs.readFileSync(SQL30_FILE, 'utf8'));
      } finally {
        await owner.end();
      }
    },
    async close() {
      await admin.end().catch(() => {});
      server.stop();
    },
  };
}
