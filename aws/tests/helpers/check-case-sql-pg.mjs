/**
 * PostgreSQL 16 fixture for the SQL 87 (resolve_check_case tenant scope) tests: the
 * tables the case helper and its triggers read and write, the real identity helpers
 * (aws/identity/sql/02_auth_uid_guc.sql) and the real Supabase migrations that
 * define public.resolve_check_case, its trigger functions and triggers
 * (20260826125804) and repeat its grants (20260826125833), byte for byte. Everything
 * is owned by a non-superuser login (like checksops_admin, which owns the
 * production functions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(TESTS, '../..');
export const CASE_MIGRATION_FILE = path.join(ROOT, 'supabase/migrations/20260826125804_316a5658-9b2c-4b7d-aaf3-9b81a5d5ccfd.sql');
export const CASE_GRANTS_FILE = path.join(ROOT, 'supabase/migrations/20260826125833_87e8da50-4042-4498-871e-6d8abdd7eba2.sql');
export const CASE_MIGRATION_SHA256 = '9ffd46f797e0e17a778ea034863868c05b97f1c0aac82b38e5c5f732f7d540f8';
export const CASE_GRANTS_SHA256 = 'da709c8b5404c27aa84d3b29f91c5528f66018416bc6758fd1e979ccd2b5ed43';
export const caseMigration = () => fs.readFileSync(CASE_MIGRATION_FILE, 'utf8');
export const caseGrants = () => fs.readFileSync(CASE_GRANTS_FILE, 'utf8');
const AUTH_UID = () => fs.readFileSync(path.join(ROOT, 'aws/identity/sql/02_auth_uid_guc.sql'), 'utf8');

export const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
export const TENANT_B = '00000000-0000-4000-8000-0000000000b1';
export const CLAIM_A = '00000000-0000-4000-8000-00000000c0a1';
export const CLAIM_B = '00000000-0000-4000-8000-00000000c0b1';
export const CLAIM_ORGLESS = '00000000-0000-4000-8000-00000000c0c1';
export const CLAIM_ORGLESS_B = '00000000-0000-4000-8000-00000000c0d1';
export const FREEDOM_ONLY = '00000000-0000-4000-8000-00000000f0f1';

// The tables (columns as in the Supabase migrations the helper and triggers touch).
const TABLES = `
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text);
CREATE TABLE public.tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL);
CREATE TABLE public.claims (
  id uuid PRIMARY KEY, org_id uuid, claim_number text, policyholder_name text, policyholder_email text,
  policyholder_phone text, policyholder_address text, insurance_company text, policy_number text,
  mortgage_company_id uuid, loan_number text, loss_date date);
CREATE TABLE public.check_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  external_system text NOT NULL DEFAULT 'freedom_crm',
  external_claim_id uuid, external_reference text, claim_number text, insured_name text,
  insured_email text, insured_phone text, property_address text, carrier_name text, policy_number text,
  mortgage_company_id uuid, loan_number text, loss_date date,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX check_cases_external_claim_uidx
  ON public.check_cases (external_system, external_claim_id) WHERE external_claim_id IS NOT NULL;
ALTER TABLE public.check_cases ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, claim_id uuid, freedom_claim_id uuid,
  freedom_claim_number text, detected_claim_number text, payee_line text, property_address text,
  carrier_name text, amount numeric, case_id uuid REFERENCES public.check_cases(id) ON DELETE SET NULL);
CREATE TABLE public.loss_draft_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, claim_id uuid, mortgage_servicer text,
  case_id uuid REFERENCES public.check_cases(id) ON DELETE SET NULL);
CREATE TABLE public.homeowner_ledger_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, case_id uuid);
CREATE TABLE public.homeowner_ledger_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, case_id uuid);
CREATE TABLE public.homeowner_ledger_check_uploads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, case_id uuid);
CREATE TABLE public.mortgage_releases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, case_id uuid);
CREATE TABLE public.claim_check_mortgage_draws (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, case_id uuid);
CREATE TABLE public.signature_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, case_id uuid);
`;

/** Seeded claim values (PII) that must never appear in any inspect output, nor in another tenant's case. */
export const SEEDED_PII = Object.freeze(['Bea Foreign', 'bea.foreign@example.com', 'LOAN-FOREIGN-9', '9 Foreign Way', 'Alma Own', 'Orla Orgless', 'Ophelia Bee']);
/** Tenant B's claim data, which must never land in a tenant A case. */
export const TENANT_B_PII = Object.freeze(['Bea Foreign', 'bea.foreign@example.com', '555-0199', '9 Foreign Way', 'Foreign Carrier', 'POL-B', 'LOAN-FOREIGN-9', 'Ophelia Bee', 'ophelia@example.com']);
export function assertNoSeededPii(assert, value, label = 'output') {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const pii of SEEDED_PII) assert.equal(text.includes(pii), false, `${label} contains ${pii}`);
}

/**
 * Run as the superuser: the API roles (anon and service_role as on a restored
 * Supabase database), the extension and the owner login, which then creates (and
 * owns) everything else.
 */
export function caseRolesSql(owner) {
  return `
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE ${owner} LOGIN NOSUPERUSER NOBYPASSRLS;
DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO ${owner}', current_database()); END $$;
CREATE SCHEMA IF NOT EXISTS auth;
ALTER SCHEMA auth OWNER TO ${owner};
GRANT USAGE, CREATE ON SCHEMA public TO ${owner};
GRANT USAGE ON SCHEMA public TO checksops, authenticated, anon, service_role;
`;
}

/** Run as the owner: the tables, the identity helpers, the two Supabase migrations and seed rows. */
export function caseSchemaSql({ withGrantsMigration = true } = {}) {
  return `
${TABLES}
${AUTH_UID()}
${caseMigration()};
${withGrantsMigration ? caseGrants() : ''};
GRANT SELECT, INSERT, UPDATE ON public.check_intake_items, public.loss_draft_tracking, public.check_cases TO checksops;
GRANT SELECT ON public.claims, public.tenant_users TO checksops;
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'Tenant A'), ('${TENANT_B}', 'Tenant B');
INSERT INTO public.claims (id, org_id, claim_number, policyholder_name, policyholder_email, policyholder_phone,
  policyholder_address, insurance_company, policy_number, mortgage_company_id, loan_number, loss_date) VALUES
  ('${CLAIM_A}', '${TENANT_A}', 'CLM-A-1', 'Alma Own', 'alma.own@example.com', '555-0101', '1 Own St', 'Own Carrier', 'POL-A', NULL, 'LOAN-OWN-1', '2026-01-02'),
  ('${CLAIM_B}', '${TENANT_B}', 'CLM-B-1', 'Bea Foreign', 'bea.foreign@example.com', '555-0199', '9 Foreign Way', 'Foreign Carrier', 'POL-B', NULL, 'LOAN-FOREIGN-9', '2026-02-03'),
  ('${CLAIM_ORGLESS}', NULL, 'CLM-O-1', 'Orla Orgless', 'orla@example.com', '555-0111', '5 Orgless Rd', 'Orgless Carrier', 'POL-O', NULL, 'LOAN-O-1', '2026-03-04'),
  ('${CLAIM_ORGLESS_B}', NULL, 'CLM-OB-1', 'Ophelia Bee', 'ophelia@example.com', '555-0122', '7 Bee Ln', 'Bee Carrier', 'POL-OB', NULL, 'LOAN-OB-1', '2026-04-05');
`;
}
