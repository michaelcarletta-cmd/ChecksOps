/**
 * public.tenant_wallet_funding_settings for the SQL 140 PostgreSQL 16 tests (run as the superuser before
 * the release fixture hands schema public to checksops_admin; releaseFixture({ extra: [walletFundingSchema(mode)] })):
 * the table as supabase/migrations/20260828201816_*.sql creates it (every column, its defaults and checks, the
 * tenant and funding-bank references to the fixture's tenants and payment_provider_methods), RLS on, the
 * repository's aws_select_tenant_wallet_funding_settings (aws/rls/sql/12_final_select_policies.sql) and
 * aws_write_tenant_wallet_funding_settings (aws/rls/sql/24_complete_write_policies.sql; aws_can_write_tenant),
 * and the grants the restored AWS databases leave:
 *
 *   - 'none': table SELECT for checksops and authenticated, no column grant (what
 *     aws/db-copy/sql/02_grant_readonly_application_role.sql gives: the expected pre-state in both environments);
 *   - 'table': table SELECT, INSERT and UPDATE for checksops (a restore that kept table-level writes, as
 *     production's check_intake_items had at the SQL 89 inspect) and SELECT for authenticated.
 *
 * The fixture's payment_provider_methods gains the provider and connection_status columns the save reads and
 * the repository's aws_select_payment_provider_methods (the fixture enables its RLS without a SELECT policy).
 * SQL 136's money-write gate is not in this fixture (aws/tests/sql136-money-write-restrictive-pg.test.mjs covers
 * it); the save sets request.money_write all the same. MEMBER_B (tenant_users owner of TENANT_B) also holds
 * user_roles staff, so aws_can_write_tenant(TENANT_B) is true for them; MEMBER_A (a viewer of TENANT_A, no role)
 * cannot write TENANT_B.
 */
import { policyBlock } from './stakeholder-policies-pg.mjs';
import { MEMBER_B } from './release-sql-pg.mjs';

export const TABLE = 'public.tenant_wallet_funding_settings';
/** The columns SQL 140 grants INSERT on, in file order (tenant_id, then the request columns the save can name). */
export const INSERT_COLUMNS = Object.freeze([
  'tenant_id', 'auto_funding_enabled', 'funding_bank_account_id', 'funding_payment_method_id', 'funding_strategy',
  'target_wallet_balance_cents', 'maximum_single_pull_cents', 'maximum_daily_pull_cents', 'require_payment_approval',
  'authorization_accepted_at', 'authorization_accepted_by', 'authorization_version',
]);
/** The columns SQL 140 grants UPDATE on, in file order (the request columns and updated_at). */
export const UPDATE_COLUMNS = Object.freeze([...INSERT_COLUMNS.slice(1), 'updated_at']);
/** The thirteen pinned columns in spec order. */
export const COLUMNS = Object.freeze([...INSERT_COLUMNS, 'updated_at']);
/** The pinned lines of a column (sorted, as the engine reads them). */
export const pinned = (column) => [
  ...(INSERT_COLUMNS.includes(column) ? ['checksops INSERT'] : []),
  ...(UPDATE_COLUMNS.includes(column) ? ['checksops UPDATE'] : []),
];

export function walletFundingSchema(mode = 'none') {
  if (!['none', 'table'].includes(mode)) throw new Error(`unknown mode ${mode}`);
  const grants = {
    none: `GRANT SELECT ON TABLE ${TABLE} TO checksops, authenticated;`,
    table: `GRANT SELECT, INSERT, UPDATE ON TABLE ${TABLE} TO checksops;\nGRANT SELECT ON TABLE ${TABLE} TO authenticated;`,
  }[mode];
  return `
ALTER TABLE public.payment_provider_methods ADD COLUMN provider text, ADD COLUMN connection_status text;
CREATE TABLE ${TABLE} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,
  auto_funding_enabled boolean NOT NULL DEFAULT false,
  funding_bank_account_id uuid REFERENCES public.payment_provider_methods(id) ON DELETE SET NULL,
  funding_payment_method_id text,
  funding_strategy text NOT NULL DEFAULT 'payment_shortage'
    CHECK (funding_strategy IN ('payment_shortage','target_balance','manual')),
  target_wallet_balance_cents bigint NOT NULL DEFAULT 0 CHECK (target_wallet_balance_cents >= 0),
  maximum_single_pull_cents bigint NOT NULL DEFAULT 2500000 CHECK (maximum_single_pull_cents >= 0),
  maximum_daily_pull_cents bigint NOT NULL DEFAULT 5000000 CHECK (maximum_daily_pull_cents >= 0),
  require_payment_approval boolean NOT NULL DEFAULT true,
  authorization_accepted_at timestamptz,
  authorization_accepted_by uuid,
  authorization_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;
${policyBlock('12_final_select_policies.sql', 'aws_select_tenant_wallet_funding_settings')}
${policyBlock('12_final_select_policies.sql', 'aws_select_payment_provider_methods')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_tenant_wallet_funding_settings')}
REVOKE ALL ON TABLE ${TABLE} FROM PUBLIC, checksops, authenticated;
${grants}
INSERT INTO public.user_roles (user_id, role) VALUES ('${MEMBER_B}', 'staff') ON CONFLICT DO NOTHING;`;
}
