/**
 * PostgreSQL 16 fixture for the SQL 88 (tg_claim_id_assign_case tenant scope) tests:
 * the tables the case trigger functions read and write, with the six
 * tg_claim_id_assign_case tables in their Supabase shape (the three homeowner ledger
 * tables carry tenant_id NOT NULL; mortgage_releases, claim_check_mortgage_draws and
 * signature_requests have no tenant column; claim_id references claims), the real
 * identity helpers and the real Supabase migrations 20260826125804 / 20260826125833
 * (byte for byte, through ./check-case-sql-pg.mjs). Everything is owned by a
 * non-superuser login, like checksops_admin in production.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLAIM_A,
  CLAIM_B,
  CLAIM_ORGLESS,
  CLAIM_ORGLESS_B,
  TENANT_A,
  TENANT_B,
  caseGrants,
  caseMigration,
} from './check-case-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AUTH_UID = () => fs.readFileSync(path.join(ROOT, 'aws/identity/sql/02_auth_uid_guc.sql'), 'utf8');
export const SQL87_FILE = path.join(ROOT, 'aws/workflows/sql/87_resolve_check_case_tenant_scope.sql');
export const sql87Text = () => fs.readFileSync(SQL87_FILE, 'utf8');

/** The six tables tg_claim_id_assign_case runs on, and whether each has a tenant_id column. */
export const CLAIM_ID_TABLES = Object.freeze([
  Object.freeze({ table: 'homeowner_ledger_events', tenant: true }),
  Object.freeze({ table: 'homeowner_ledger_tokens', tenant: true }),
  Object.freeze({ table: 'homeowner_ledger_check_uploads', tenant: true }),
  Object.freeze({ table: 'mortgage_releases', tenant: false }),
  Object.freeze({ table: 'claim_check_mortgage_draws', tenant: false }),
  Object.freeze({ table: 'signature_requests', tenant: false }),
]);

const claimIdTable = ({ table, tenant }) => `CREATE TABLE public.${table} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),${tenant ? '\n  tenant_id uuid NOT NULL,' : ''}
  claim_id uuid REFERENCES public.claims(id) ON DELETE CASCADE,
  note text,
  case_id uuid REFERENCES public.check_cases(id) ON DELETE SET NULL);`;

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
${CLAIM_ID_TABLES.map(claimIdTable).join('\n')}
`;

/** Run as the owner: the tables, the identity helpers, the two Supabase migrations, grants and seed rows. */
export function claimIdSchemaSql({ withGrantsMigration = true, withSql87 = false } = {}) {
  return `
${TABLES}
${AUTH_UID()}
${caseMigration()};
${withGrantsMigration ? caseGrants() : ''};
${withSql87 ? sql87Text() : ''};
GRANT SELECT, INSERT, UPDATE ON public.check_intake_items, public.loss_draft_tracking, public.check_cases TO checksops;
GRANT SELECT, INSERT, UPDATE ON ${CLAIM_ID_TABLES.map(({ table }) => `public.${table}`).join(', ')} TO checksops;
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

// Fixed ids for the seeded cross-tenant links (never printed by any inspect).
export const CASE_A = '00000000-0000-4000-8000-0000000ca5a1';
export const CASE_B = '00000000-0000-4000-8000-0000000ca5b1';
export const CASE_A_ON_B = '00000000-0000-4000-8000-0000000ca5ab';
export const CASE_ORGLESS_B = '00000000-0000-4000-8000-0000000ca50b';

/**
 * Run as the owner on a clean slate: rows with known cross-tenant links, inserted with
 * the case triggers disabled so the links stay as written. Returns the expected count of
 * each cross_tenant_links category (and the total).
 */
export function seedCrossTenantLinksSql() {
  return `
ALTER TABLE public.check_intake_items DISABLE TRIGGER USER;
ALTER TABLE public.loss_draft_tracking DISABLE TRIGGER USER;
${CLAIM_ID_TABLES.map(({ table }) => `ALTER TABLE public.${table} DISABLE TRIGGER USER;`).join('\n')}
-- Cases: A's own (claim A), B's own (claim B), an A case for B's claim (the old helper
-- could create it), and a B case for an org-less claim only A's checks reference.
INSERT INTO public.check_cases (id, tenant_id, external_system, external_claim_id, claim_number) VALUES
  ('${CASE_A}', '${TENANT_A}', 'freedom_crm', '${CLAIM_A}', 'CLM-A-1'),
  ('${CASE_B}', '${TENANT_B}', 'freedom_crm', '${CLAIM_B}', 'CLM-B-1'),
  ('${CASE_A_ON_B}', '${TENANT_A}', 'checksops', NULL, 'A-LOCAL'),
  ('${CASE_ORGLESS_B}', '${TENANT_B}', 'freedom_crm', '${CLAIM_ORGLESS}', 'CLM-O-1');
-- check_intake_items: clean ones, one linked to B's case (case_other_tenant), one with B's
-- claim (claim_other_tenant), one with an org-less claim of its own (clean).
INSERT INTO public.check_intake_items (id, tenant_id, claim_id, case_id) VALUES
  ('00000000-0000-4000-8000-000000000c01', '${TENANT_A}', '${CLAIM_A}', '${CASE_A}'),
  ('00000000-0000-4000-8000-000000000c02', '${TENANT_A}', NULL, '${CASE_B}'),
  ('00000000-0000-4000-8000-000000000c03', '${TENANT_A}', '${CLAIM_B}', '${CASE_A_ON_B}'),
  ('00000000-0000-4000-8000-000000000c04', '${TENANT_A}', '${CLAIM_ORGLESS}', NULL),
  ('00000000-0000-4000-8000-000000000c05', '${TENANT_B}', '${CLAIM_B}', '${CASE_B}');
-- loss_draft_tracking: one clean, one on A's check linked to B's case, one on A's check with B's claim.
INSERT INTO public.loss_draft_tracking (check_intake_item_id, claim_id, case_id) VALUES
  ('00000000-0000-4000-8000-000000000c01', '${CLAIM_A}', '${CASE_A}'),
  ('00000000-0000-4000-8000-000000000c01', NULL, '${CASE_B}'),
  ('00000000-0000-4000-8000-000000000c04', '${CLAIM_B}', NULL);
-- Trigger tables: per tenant table one clean row, one A row linked to B's case; per
-- tenant-less table one clean row, one row linked to the B case of an org-less claim
-- only A's checks reference (the claim does not belong to B).
${CLAIM_ID_TABLES.map(({ table, tenant }) => (tenant
    ? `INSERT INTO public.${table} (tenant_id, claim_id, case_id) VALUES ('${TENANT_A}', '${CLAIM_A}', '${CASE_A}'), ('${TENANT_A}', '${CLAIM_B}', '${CASE_B}');`
    : `INSERT INTO public.${table} (claim_id, case_id) VALUES ('${CLAIM_B}', '${CASE_B}'), ('${CLAIM_ORGLESS}', '${CASE_ORGLESS_B}');`)).join('\n')}
ALTER TABLE public.check_intake_items ENABLE TRIGGER USER;
ALTER TABLE public.loss_draft_tracking ENABLE TRIGGER USER;
${CLAIM_ID_TABLES.map(({ table }) => `ALTER TABLE public.${table} ENABLE TRIGGER USER;`).join('\n')}
`;
}

/** What seedCrossTenantLinksSql() leaves, as cross_tenant_links.categories. */
export const SEEDED_CROSS_TENANT_COUNTS = Object.freeze({
  check_intake_items_case: 1,
  check_intake_items_claim: 1,
  loss_draft_tracking_case: 1,
  loss_draft_tracking_claim: 1,
  // CASE_ORGLESS_B: B's freedom_crm case for an org-less claim only A's checks reference.
  check_cases_claim: 1,
  homeowner_ledger_events_case: 1,
  homeowner_ledger_tokens_case: 1,
  homeowner_ledger_check_uploads_case: 1,
  mortgage_releases_case: 1,
  claim_check_mortgage_draws_case: 1,
  signature_requests_case: 1,
});
export const SEEDED_CROSS_TENANT_TOTAL = 11;

/** Deletes every row the scenarios and the seed write (claims and tenants stay). */
export const CLEAR_ROWS_SQL = `
DELETE FROM public.loss_draft_tracking;
${CLAIM_ID_TABLES.map(({ table }) => `DELETE FROM public.${table};`).join('\n')}
DELETE FROM public.check_intake_items;
DELETE FROM public.check_cases;
`;
