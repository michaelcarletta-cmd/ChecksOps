/**
 * PostgreSQL 16 fixture for the SQL 84 / 85 / 86 guarded tooling tests: the
 * Mortgage Ops tables the files read (as in mortgage-return-adjust-sql.test.mjs),
 * the real identity helpers (aws/identity/sql/02_auth_uid_guc.sql), the real
 * platform-owner predicate (aws/rls/sql/10_owner_helpers_from_identity.sql) and the
 * Cursor SQL 47 compensation ledger, all owned by a non-superuser login (like
 * checksops_admin). Optionally the Cursor SQL 48 / SQL 49 bodies staging may carry.
 *
 * The Cursor files are byte copies from history (branch
 * cursor/mortgage-agent-lambda-prod-ad99, commit b73e976be):
 *   aws/tests/fixtures/mortgage-agent-compensation/47_mortgage_agent_compensation.sql             sha256 bdbdccbc…
 *   aws/tests/fixtures/mortgage-agent-compensation/cursor-sql48-return-mortgage-request-to-queue.sql  sha256 be6c7125…
 *   aws/tests/fixtures/mortgage-agent-compensation/cursor-sql49-adjust-mortgage-agent-compensation.sql sha256 3bda6740…
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = path.join(TESTS, '..');
const FIXTURES = path.join(TESTS, 'fixtures/mortgage-agent-compensation');
export const SQL47_FILE = path.join(FIXTURES, '47_mortgage_agent_compensation.sql');
export const CURSOR_SQL48_FILE = path.join(FIXTURES, 'cursor-sql48-return-mortgage-request-to-queue.sql');
export const CURSOR_SQL49_FILE = path.join(FIXTURES, 'cursor-sql49-adjust-mortgage-agent-compensation.sql');
export const SQL47_SHA256 = 'bdbdccbc44ca70ae86c7212f16fb1a2d2786071b61acb6b62c98e7863b2cc99c';
export const CURSOR_SQL48_SHA256 = 'be6c712587ded69ee209524be08edcdc640a438bd0196d0be978cbe9ae48ef9f';
export const CURSOR_SQL49_SHA256 = '3bda6740d08b159ee21e3861443d9b9ae74f2e2efc01ae147467da00bcf3a550';
export const sql47 = () => fs.readFileSync(SQL47_FILE, 'utf8');
export const cursorSql48 = () => fs.readFileSync(CURSOR_SQL48_FILE, 'utf8');
export const cursorSql49 = () => fs.readFileSync(CURSOR_SQL49_FILE, 'utf8');
const AUTH_UID = () => fs.readFileSync(path.join(AWS, 'identity/sql/02_auth_uid_guc.sql'), 'utf8');
const OWNER_HELPERS = () => fs.readFileSync(path.join(AWS, 'rls/sql/10_owner_helpers_from_identity.sql'), 'utf8');

// The tables SQL 47 and the three files read (columns as in mortgage-return-adjust-sql.test.mjs).
const TABLES = `
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');
CREATE TABLE public.identity_accounts (application_user_id uuid PRIMARY KEY, email text, status text);
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL,
  UNIQUE (user_id, role));
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text, slug text);
CREATE TABLE public.tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL);
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY, tenant_id uuid, check_intake_item_id uuid, claim_id uuid,
  mortgage_company text, loan_number text, homeowner_name text, claim_number text,
  status text NOT NULL DEFAULT 'requested', assigned_employee_id uuid,
  accepted_at timestamptz, completed_at timestamptz, cancelled_at timestamptz, work_notes text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.check_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, check_intake_item_id uuid, claim_id uuid,
  mortgage_request_id uuid, event_type text NOT NULL, unit_price_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'recorded', created_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role);
$$;
ALTER TABLE public.check_billing_events ENABLE ROW LEVEL SECURITY;
`;

/** Staging's existing per-check unique index (the exact predicate SQL 84 accepts). */
export const STAGING_PER_CHECK_INDEX_SQL = `
CREATE UNIQUE INDEX check_billing_events_mortgage_ops_check_uidx ON public.check_billing_events (check_intake_item_id)
  WHERE event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check') AND check_intake_item_id IS NOT NULL;
`;

/** Seeded row values that must never appear in any inspect output. */
export const SEEDED_PII = Object.freeze(['Pat Private', 'LOAN-PRIVATE-1', 'private-lender@example.com', 'Private Reason Text']);
export function assertNoSeededPii(assert, value, label = 'output') {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const pii of SEEDED_PII) assert.equal(text.includes(pii), false, `${label} contains ${pii}`);
}

export const BILLING_CHECK_1 = '00000000-0000-4000-8000-000000000011';
export const BILLING_CHECK_2 = '00000000-0000-4000-8000-000000000012';

/**
 * Run as the superuser: roles, schema privileges and the extension. `owner` is a
 * non-superuser, non-BYPASSRLS login that then creates (and owns) everything else.
 */
export function mortgageRolesSql(owner) {
  return `
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE checksops NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE ${owner} LOGIN NOSUPERUSER NOBYPASSRLS;
DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO ${owner}', current_database()); END $$;
CREATE SCHEMA IF NOT EXISTS auth;
ALTER SCHEMA auth OWNER TO ${owner};
GRANT USAGE, CREATE ON SCHEMA public TO ${owner};
`;
}

/** Run as the owner: the tables, the identity helpers, SQL 47 and a few rows (with PII the inspect must not echo). */
export function mortgageSchemaSql() {
  return `
${TABLES}
${AUTH_UID()}
${OWNER_HELPERS()}
${sql47()}
INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id, mortgage_company, loan_number, homeowner_name, status)
VALUES ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-0000000000d1', '${BILLING_CHECK_1}',
  'private-lender@example.com', 'LOAN-PRIVATE-1', 'Pat Private', 'requested');
INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, event_type, unit_price_cents, status) VALUES
  ('00000000-0000-4000-8000-0000000000d1', '${BILLING_CHECK_1}', 'mortgage_ops_initial', 1000, 'recorded'),
  ('00000000-0000-4000-8000-0000000000d1', '${BILLING_CHECK_2}', 'mortgage_ops_initial', 1000, 'voided');
INSERT INTO public.mortgage_agent_compensation_audit (action, payload) VALUES ('note', '{"reason": "Private Reason Text"}');
`;
}

/** A duplicate non-voided per-check Mortgage Ops event (SQL 84 refuses to create the fallback index over it). */
export const DUPLICATE_BILLING_SQL = `
INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, event_type, unit_price_cents, status)
VALUES ('00000000-0000-4000-8000-0000000000d1', '${BILLING_CHECK_1}', 'mortgage_ops_additional_check', 500, 'recorded');
`;
