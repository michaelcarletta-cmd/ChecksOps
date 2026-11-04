/**
 * public.mortgage_companies for the SQL 142 PostgreSQL tests, as the read-only production lookups of 2026-11-04
 * showed it (SSM da2687b5 and f90ee490): RLS enabled, the API login's table grants (SELECT, INSERT, UPDATE,
 * DELETE), the repository's SELECT policy (aws/rls/sql/12_final_select_policies.sql) and its only write policy,
 * the platform-owner aws_write_mortgage_companies (aws/rls/sql/24_complete_write_policies.sql), both read from the
 * repository files. Two rows: one active, one inactive. Run as the fixture's superuser before ownership passes to
 * checksops_admin (releaseFixture `extra`).
 */
import { policyBlock } from './stakeholder-policies-pg.mjs';

export const ACTIVE_COMPANY = '14200000-0000-4000-8000-000000000001';
export const INACTIVE_COMPANY = '14200000-0000-4000-8000-000000000002';

export const mortgageCompaniesSchema = () => [
  `
CREATE TABLE IF NOT EXISTS public.mortgage_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  contact_name text,
  address_line_1 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.mortgage_companies ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mortgage_companies TO checksops;
INSERT INTO public.mortgage_companies (id, name, is_active) VALUES
  ('${ACTIVE_COMPANY}', 'Active Mortgage Co', true), ('${INACTIVE_COMPANY}', 'Inactive Mortgage Co', false);`,
  policyBlock('12_final_select_policies.sql', 'aws_select_mortgage_companies'),
  policyBlock('24_complete_write_policies.sql', 'aws_write_mortgage_companies'),
].join('\n');
