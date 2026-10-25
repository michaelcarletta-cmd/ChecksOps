/**
 * public.stakeholder_accounts for the SQL 114 PostgreSQL 16 tests (run as the superuser before
 * the release fixture hands schema public to checksops_admin; releaseFixture({ extra:
 * [STAKEHOLDER_SETTINGS_SCHEMA] })): the fixture's minimal table (helpers/stakeholder-policies-pg.mjs:
 * id, tenant_id, name, is_active) widened with the columns Settings > Stakeholder Accounts writes
 * (the Lovable-era is_primary, account_type and updated_at, and homeowner_name / homeowner_email
 * of supabase migration 20260712161508), row-level security on with the real
 * aws_select_stakeholder_accounts (aws/rls/sql/12_final_select_policies.sql) and
 * aws_write_stakeholder_accounts (aws/rls/sql/24_complete_write_policies.sql) policies, and the
 * grants the restored database left: table-level SELECT for checksops and authenticated (the
 * fixture's), no UPDATE and no column grant.
 *
 * MEMBER_B (tenant_users owner of TENANT_B) also holds user_roles staff, so
 * aws_can_write_tenant(TENANT_B) is true for them; MEMBER_A (a viewer of TENANT_A, no role) can
 * write no tenant. One stakeholder row per tenant.
 */
import { policyBlock } from './stakeholder-policies-pg.mjs';
import { MEMBER_B, TENANT_A, TENANT_B } from './release-sql-pg.mjs';

export const STAKEHOLDERS = 'public.stakeholder_accounts';
export const STAKEHOLDER_A = 'b1000000-0000-4000-8000-0000000000a1';
export const STAKEHOLDER_B = 'b1000000-0000-4000-8000-0000000000b1';
/** The columns SQL 114 grants UPDATE on, in file order. */
export const SETTINGS_COLUMNS = Object.freeze(['is_active', 'is_primary', 'account_type', 'homeowner_name', 'homeowner_email', 'updated_at']);

export const STAKEHOLDER_SETTINGS_SCHEMA = `
ALTER TABLE ${STAKEHOLDERS}
  ADD COLUMN IF NOT EXISTS nickname text NOT NULL DEFAULT 'Account',
  ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'operating',
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS homeowner_email text,
  ADD COLUMN IF NOT EXISTS homeowner_name text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE ${STAKEHOLDERS} ENABLE ROW LEVEL SECURITY;
${policyBlock('12_final_select_policies.sql', 'aws_select_stakeholder_accounts')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_stakeholder_accounts')}
REVOKE ALL ON TABLE ${STAKEHOLDERS} FROM PUBLIC, checksops, authenticated;
GRANT SELECT ON TABLE ${STAKEHOLDERS} TO checksops, authenticated;
INSERT INTO public.user_roles (user_id, role) VALUES ('${MEMBER_B}', 'staff');
INSERT INTO ${STAKEHOLDERS} (id, tenant_id, name, account_type, is_primary, homeowner_name, homeowner_email) VALUES
  ('${STAKEHOLDER_A}', '${TENANT_A}', 'A homeowner', 'homeowner', true, 'Home Owner A', 'owner-a@example.invalid'),
  ('${STAKEHOLDER_B}', '${TENANT_B}', 'B homeowner', 'homeowner', true, 'Home Owner B', 'owner-b@example.invalid');`;
