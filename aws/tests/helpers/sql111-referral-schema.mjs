/**
 * tenants referral columns and public.referral_events for the SQL 111 PostgreSQL 16 tests, in the
 * shapes the SPA reads them (src/integrations/supabase/types.ts: tenants.referral_code,
 * referred_by_tenant_id, referral_discount_cents, monthly_rate_cents, is_system_tenant;
 * referral_events with referred_user_id, referral_code_used, discount_applied_cents, status,
 * created_at, updated_at), with the aws/rls policies (12 select, 24 write). The release fixture's
 * minimal referral_events table is replaced. Run as the superuser before ownership
 * (releaseFixture({ extra: [REFERRAL_SCHEMA] })).
 *
 * Tenants: A (code ALPHA-1, rate $99), B (BRAVO-2), C (CHARLIE-3, a Supabase-era referral of
 * LEGACY recorded only in tenants.referred_by_tenant_id), LEGACY, R1..R6 (cap test), SYSTEM (a
 * system tenant). MEMBER_A becomes admin of A, VIEWER_A a viewer of A; MEMBER_B stays owner of B.
 */
import { MEMBER_A, TENANT_A, TENANT_B } from './release-sql-pg.mjs';
import { policyBlock } from './stakeholder-policies-pg.mjs';

export const TENANT_C = 'c3000000-0000-4000-8000-000000000003';
export const TENANT_LEGACY = 'c3000000-0000-4000-8000-000000000004';
export const TENANT_SYSTEM = 'c3000000-0000-4000-8000-000000000005';
export const CAP_TENANTS = Object.freeze([1, 2, 3, 4, 5, 6].map((n) => `c3000000-0000-4000-8000-00000000010${n}`));
export const VIEWER_A = 'a1000000-0000-4000-8000-0000000000a2';

export const REFERRAL_SCHEMA = `
ALTER TABLE public.tenants
  ADD COLUMN slug text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN referral_code text,
  ADD COLUMN referred_by_tenant_id uuid REFERENCES public.tenants(id),
  ADD COLUMN referral_discount_cents integer DEFAULT 0,
  ADD COLUMN monthly_rate_cents integer DEFAULT 9900,
  ADD COLUMN is_founding_partner boolean DEFAULT false,
  ADD COLUMN is_system_tenant boolean NOT NULL DEFAULT false;
DROP TABLE public.referral_events;
CREATE TABLE public.referral_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  referred_tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  referred_user_id uuid NOT NULL,
  referral_code_used text NOT NULL,
  discount_applied_cents integer NOT NULL DEFAULT 500,
  status text NOT NULL DEFAULT 'active',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.referral_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.referral_events TO checksops;
${policyBlock('12_final_select_policies.sql', 'aws_select_referral_events')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_referral_events')}
UPDATE public.tenants SET slug = 'a', referral_code = 'ALPHA-1', created_at = now() - interval '30 days' WHERE id = '${TENANT_A}';
UPDATE public.tenants SET slug = 'b', referral_code = 'BRAVO-2', created_at = now() - interval '20 days' WHERE id = '${TENANT_B}';
INSERT INTO public.tenants (id, name, slug, referral_code, referred_by_tenant_id, is_system_tenant) VALUES
  ('${TENANT_C}', 'C', 'c', 'CHARLIE-3', NULL, false),
  ('${TENANT_SYSTEM}', 'System', 'system', 'SYSTEM-0', NULL, true);
INSERT INTO public.tenants (id, name, slug, referral_code, referred_by_tenant_id) VALUES
  ('${TENANT_LEGACY}', 'Legacy', 'legacy', 'LEGACY-4', '${TENANT_C}');
INSERT INTO public.tenants (id, name, slug, referral_code) VALUES
${CAP_TENANTS.map((id, i) => `  ('${id}', 'R${i + 1}', 'r${i + 1}', 'R-${i + 1}')`).join(',\n')};
UPDATE public.tenant_users SET role = 'admin' WHERE tenant_id = '${TENANT_A}' AND user_id = '${MEMBER_A}';
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES ('${VIEWER_A}', 'viewer-a@example.invalid', 'active');
INSERT INTO public.profiles (id, email) VALUES ('${VIEWER_A}', 'viewer-a@example.invalid');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT_A}', '${VIEWER_A}', 'viewer');
`;
