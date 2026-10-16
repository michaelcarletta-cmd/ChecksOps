/**
 * PostgreSQL 16 fixture for the Document Library SQL (SQL 29, SQL 30, SQL 94):
 * a non-superuser checksops_admin owns the tables (like production), checksops is a
 * member of authenticated (aws/rls/sql/01_role_shim.sql), auth.uid() is the real GUC
 * reader (aws/identity/sql/02_auth_uid_guc.sql), tenant_documents carries Supabase's
 * 6-value doc_type CHECK (migration 20260709153833), and mortgage_request_library_documents
 * has RLS with the three Lovable policies and the auto-share trigger SQL 29 replaces.
 * The access helpers are small stand-ins with the AWS names (membership-based tenant
 * access); SQL 29's own functions come from the real file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgSkipReason, startPg } from './stakeholder-policies-pg.mjs';

const AWS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = path.join(AWS_ROOT, '..');
export const SQL29_FILE = path.join(REPO, 'aws/rls/sql/29_mortgage_ops_library_parity.sql');
export const SQL30_FILE = path.join(REPO, 'aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql');
export const SQL94_FILE = path.join(REPO, 'aws/workflows/sql/94_document_library_restore.sql');
export const SQL90_FILE = path.join(REPO, 'aws/workflows/sql/90_users_only_tenant_roles.sql');
const AUTH_UID_SQL = path.join(AWS_ROOT, 'identity/sql/02_auth_uid_guc.sql');

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';
export const MEMBER_A = 'a1000000-0000-4000-8000-000000000001';
export const MEMBER_B = 'a1000000-0000-4000-8000-000000000002';
export const AGENT = 'a1000000-0000-4000-8000-000000000004';
export const AGENT_OTHER = 'a1000000-0000-4000-8000-000000000005';
export const CLAIM_A = 'c1000000-0000-4000-8000-0000000000a1';
export const CLAIM_A2 = 'c1000000-0000-4000-8000-0000000000a2';
export const CLAIM_B = 'c1000000-0000-4000-8000-0000000000b1';
export const DOC_MORT = 'd1000000-0000-4000-8000-000000000001';
export const DOC_TMPL = 'd1000000-0000-4000-8000-000000000002';
export const DOC_B = 'd1000000-0000-4000-8000-000000000003';
export const REQ_OPEN = 'e1000000-0000-4000-8000-000000000001';
export const REQ_CLOSED = 'e1000000-0000-4000-8000-000000000002';

export { pgSkipReason };

const SCHEMA = `
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text);
CREATE TABLE public.tenant_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL DEFAULT 'member');
CREATE TABLE public.claims (id uuid PRIMARY KEY, org_id uuid, claim_number text);
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, claim_id uuid);
CREATE TABLE public.tenant_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  file_path text NOT NULL,
  file_name text NOT NULL,
  mime_type text,
  file_size bigint,
  uploaded_by uuid,
  notes text,
  auto_share_mortgage_ops boolean NOT NULL DEFAULT false,
  shared_with_homeowners boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenant_documents ADD CONSTRAINT tenant_documents_doc_type_check
  CHECK (doc_type IN ('w9','license','insurance','saas_agreement','terms_of_service','privacy_policy'));
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid, status text NOT NULL DEFAULT 'requested', assigned_employee_id uuid);
CREATE TABLE public.mortgage_request_library_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.mortgage_handling_requests(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  tenant_document_id uuid REFERENCES public.tenant_documents(id) ON DELETE SET NULL,
  doc_type text NOT NULL, file_name text NOT NULL, file_path text NOT NULL, mime_type text, file_size bigint,
  bucket text NOT NULL DEFAULT 'tenant-documents',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, file_path));
CREATE TABLE public.homeowner_ledger_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, claim_id uuid, token text NOT NULL,
  homeowner_email text, homeowner_name text, revoked_at timestamptz, expires_at timestamptz, last_viewed_at timestamptz);
CREATE TABLE public.homeowner_ledger_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, claim_id uuid NOT NULL);

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE FUNCTION public.aws_is_authenticated() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid() IS NOT NULL $$;
CREATE FUNCTION public.aws_is_cross_tenant_reader() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.aws_can_access_tenant(_tenant_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenant_users WHERE user_id = auth.uid() AND tenant_id = _tenant_id) $$;
CREATE FUNCTION public.aws_can_write_tenant(_tenant_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM public.tenant_users WHERE user_id = auth.uid() AND tenant_id = _tenant_id) $$;

-- Lovable 2026-08-30 auto-share (SQL 29 reaffirms the same body).
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

GRANT USAGE ON SCHEMA public TO checksops, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO checksops, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mortgage_request_library_documents TO checksops, authenticated;
GRANT INSERT, UPDATE ON public.tenant_documents TO checksops;
`;

/** Starts a server and builds the schema; returns { server, admin, connectAs, ownerExec, close }. */
export async function libraryFixture(pg, prefix, port) {
  const server = startPg(prefix, port);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  await admin.query(`
    CREATE ROLE checksops NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    GRANT authenticated TO checksops;
    CREATE ROLE checksops_admin LOGIN NOSUPERUSER;
    GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin;`);
  await admin.query(fs.readFileSync(AUTH_UID_SQL, 'utf8'));
  await admin.query('GRANT USAGE ON SCHEMA auth TO checksops_admin, checksops, authenticated');
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(SCHEMA);
  } finally {
    await owner.end();
  }
  await admin.query(`
    INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B');
    INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT_A}', '${MEMBER_A}', 'viewer'), ('${TENANT_B}', '${MEMBER_B}', 'owner');
    INSERT INTO public.user_roles (user_id, role) VALUES ('${AGENT}', 'mortgage_agent'), ('${AGENT_OTHER}', 'mortgage_agent');
    INSERT INTO public.claims (id, org_id) VALUES ('${CLAIM_A}', '${TENANT_A}'), ('${CLAIM_A2}', NULL), ('${CLAIM_B}', '${TENANT_B}');
    INSERT INTO public.check_intake_items (id, tenant_id, claim_id) VALUES ('f1000000-0000-4000-8000-000000000001', '${TENANT_A}', '${CLAIM_A2}');`);
  return {
    server,
    admin,
    connectAs,
    async close() {
      await admin.end().catch(() => {});
      server.stop();
    },
  };
}

/** Runs `sql` as checksops with auth.uid() = userId (SET LOCAL ROLE inside a transaction), then rolls back. */
export async function asApi(admin, userId, fn) {
  await admin.query('BEGIN');
  try {
    await admin.query('SET LOCAL ROLE checksops');
    await admin.query("SELECT set_config('request.app_user_id', $1, true)", [userId || '']);
    return await fn();
  } finally {
    await admin.query('ROLLBACK');
  }
}

/** Seeds library rows that are valid under SQL 30's CHECK (mortgage) and SQL 94's (template). */
export async function seedMortgageLibrary(admin) {
  await admin.query(`
    INSERT INTO public.tenant_documents (id, tenant_id, doc_type, file_path, file_name, auto_share_mortgage_ops)
    VALUES ('${DOC_MORT}', '${TENANT_A}', 'library:mortgage:w-9', '${TENANT_A}/library/mortgage/w9.pdf', 'W-9', true);
    INSERT INTO public.mortgage_handling_requests (id, tenant_id, status, assigned_employee_id) VALUES
      ('${REQ_OPEN}', '${TENANT_A}', 'requested', NULL),
      ('${REQ_CLOSED}', '${TENANT_A}', 'completed', '${AGENT}');`);
}

export { fs };
