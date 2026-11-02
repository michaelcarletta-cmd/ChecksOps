/**
 * public.tenant_billing_accounts for the SQL 139 PostgreSQL tests, as staging showed it on 2026-11-01
 * (the read-only billing write diagnostic, #1515): RLS enabled, the API login's grants, the repository's
 * SELECT policy (aws/rls/sql/12_final_select_policies.sql), the live-only machine policies
 * aws_select_tenant_billing_accounts_job (SELECT TO checksops) and aws_write_tenant_billing_accounts_job
 * (ALL TO checksops), both aws_monthly_billing_job(), and an authenticated write policy that does not
 * depend on public.aws_can_write_tenant(uuid). Staging's drifted text is unknown (sha256-12 8c72ef93d1e5);
 * DRIFTED below is a stand-in with that property, never a claim about staging's text.
 *
 * public.aws_monthly_billing_job() is live-only too (no repository file creates it): the stand-in is true only
 * while request.monthly_billing_job = '1'. Run as the fixture's superuser before ownership passes to
 * checksops_admin (releaseFixture `extra`).
 */
import { policyBlock } from './stakeholder-policies-pg.mjs';

/** A stand-in drifted condition that hides every row from a tenant member (no aws_can_write_tenant). */
export const DRIFTED = "(public.is_platform_owner() OR (current_setting('request.sql139_test_drift', true) = '1'))";

export const BILLING_JOB_FN = `
CREATE FUNCTION public.aws_monthly_billing_job() RETURNS boolean LANGUAGE sql STABLE
  AS $f$ SELECT COALESCE(current_setting('request.monthly_billing_job', true) = '1', false) $f$;
REVOKE ALL ON FUNCTION public.aws_monthly_billing_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_monthly_billing_job() TO checksops, authenticated;`;

/**
 * `member`: a tenant member allowed to write under the fixture's aws_can_write_tenant() (aws/rls/sql/20 also
 * asks for user_roles admin/staff; SQL 90 dropped that in staging and production).
 * `write`: the authenticated write policy's condition (default DRIFTED); null leaves it out.
 */
export const billingSchema = ({ member, write = DRIFTED } = {}) => [
  BILLING_JOB_FN,
  member ? `INSERT INTO public.user_roles (user_id, role) VALUES ('${member}', 'staff') ON CONFLICT DO NOTHING;` : '',
  `
CREATE TABLE IF NOT EXISTS public.tenant_billing_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.tenant_billing_accounts ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE public.tenant_billing_accounts ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE public.tenant_billing_accounts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_billing_accounts TO checksops;`,
  policyBlock('12_final_select_policies.sql', 'aws_select_tenant_billing_accounts'),
  `
CREATE POLICY aws_select_tenant_billing_accounts_job ON public.tenant_billing_accounts
  FOR SELECT TO checksops USING (public.aws_monthly_billing_job());
CREATE POLICY aws_write_tenant_billing_accounts_job ON public.tenant_billing_accounts
  FOR ALL TO checksops USING (public.aws_monthly_billing_job()) WITH CHECK (public.aws_monthly_billing_job());`,
  `DROP POLICY IF EXISTS aws_write_tenant_billing_accounts ON public.tenant_billing_accounts;`,
  write == null ? '' : `
CREATE POLICY aws_write_tenant_billing_accounts ON public.tenant_billing_accounts
  FOR ALL TO authenticated USING (${write}) WITH CHECK (${write});`,
].join('\n');
