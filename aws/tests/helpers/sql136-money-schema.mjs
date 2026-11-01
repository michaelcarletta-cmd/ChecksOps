/**
 * The 24 money tables of finding 14 (aws/tests/money-write-flag.test.mjs MONEY_TABLES) for the SQL 136
 * PostgreSQL tests, as the repository leaves them: each with tenant_id, RLS enabled, the API login's
 * SELECT / INSERT / UPDATE / DELETE grants, a permissive SELECT policy, and SQL 24's real
 * `aws_write_<table> FOR ALL TO authenticated USING / WITH CHECK (aws_can_write_tenant(tenant_id))`
 * policy (aws/rls/sql/24_complete_write_policies.sql). Tables the release fixture already creates
 * (helpers/release-sql-pg.mjs) keep their columns; tenant_id is added only where missing. SQL 91's two
 * GUC helpers (aws/workflows/sql/91_moov_onboarding.sql) are created from that file's own text.
 * Run as the fixture's superuser before ownership passes to checksops_admin (releaseFixture `extra`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { policyBlock } from './stakeholder-policies-pg.mjs';

/** The SQL 24 FOR ALL money tables of finding 14; equal to aws/tests/money-write-flag.test.mjs MONEY_TABLES (checked by the SQL 136 tests). */
export const MONEY_TABLES = Object.freeze([
  'ach_authorizations', 'actum_transactions', 'check_billing_events', 'claim_check_payments',
  'disbursement_splits', 'external_payment_recipients', 'micro_deposit_verifications',
  'moov_invoice_customers', 'moov_invoices', 'payment_method_verifications',
  'payment_provider_methods', 'payment_sweep_configs', 'payment_transfer_groups',
  'payment_transfers', 'payment_wallet_sub_ledgers', 'payment_wallets', 'payroll_runs',
  'stakeholder_limit_requests', 'tenant_bank_accounts', 'tenant_billing_accounts',
  'tenant_credit_balances', 'tenant_credit_transactions', 'tenant_maintenance_payments',
  'tenant_wallet_funding_settings',
]);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SQL91 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/91_moov_onboarding.sql'), 'utf8');

/** One CREATE OR REPLACE FUNCTION ... $$; block out of SQL 91, verbatim. */
function sql91Function(name) {
  const start = SQL91.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`);
  if (start < 0) throw new Error(`${name} not in SQL 91`);
  const end = SQL91.indexOf('$$;', SQL91.indexOf('AS $$', start) + 5);
  return SQL91.slice(start, end + 3);
}

export const SQL91_GUC_HELPERS = [
  sql91Function('aws_moov_onboarding_active'),
  sql91Function('aws_moov_webhook_apply_active'),
  'REVOKE ALL ON FUNCTION public.aws_moov_onboarding_active() FROM PUBLIC;',
  'REVOKE ALL ON FUNCTION public.aws_moov_webhook_apply_active() FROM PUBLIC;',
  'GRANT EXECUTE ON FUNCTION public.aws_moov_onboarding_active() TO checksops, authenticated;',
  'GRANT EXECUTE ON FUNCTION public.aws_moov_webhook_apply_active() TO checksops, authenticated;',
].join('\n');

/**
 * `member`: a tenant member who may write that tenant's rows under the fixture's aws_can_write_tenant()
 * (aws/rls/sql/20, which also asks for user_roles admin/staff; SQL 90 dropped that, so in staging and
 * production any member writes: the finding). The role row reproduces SQL 90's outcome for this member.
 */
export const moneySchema = ({ member } = {}) => [
  SQL91_GUC_HELPERS,
  member ? `INSERT INTO public.user_roles (user_id, role) VALUES ('${member}', 'staff');` : '',
  ...MONEY_TABLES.map((t) => `
CREATE TABLE IF NOT EXISTS public.${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.${t} ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE public.${t} ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${t} TO checksops;
DROP POLICY IF EXISTS sql136_test_select_${t} ON public.${t};
CREATE POLICY sql136_test_select_${t} ON public.${t} FOR SELECT TO authenticated USING (true);
${policyBlock('24_complete_write_policies.sql', `aws_write_${t}`)}`),
].join('\n');
