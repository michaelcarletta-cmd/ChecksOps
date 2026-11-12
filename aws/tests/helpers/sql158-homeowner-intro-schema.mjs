/**
 * public.homeowner_intro_requests for the SQL 158 PostgreSQL tests, added to the release fixture
 * (helpers/release-sql-pg.mjs, `extra`): the columns the Leads list reads, row-level security on and
 * main's real SELECT policy (aws/rls/sql/12_final_select_policies.sql, aws_select_homeowner_intro_requests),
 * and production's grants as far as the 2026-11-10 log proves them: neither checksops nor a role it
 * inherits from (authenticated) holds SELECT on the table, so its read is refused with "permission
 * denied for table homeowner_intro_requests". Production's full ACL on the table has not been read;
 * the production inspect reads it. service_role holds a SELECT of its own here, the "other grant"
 * SQL 158 must leave as it was (other_table_privileges_unchanged).
 */
import { policyBlock } from './stakeholder-policies-pg.mjs';

export const TABLE = 'public.homeowner_intro_requests';
export const CONTRACTOR = 'a1000000-0000-4000-8000-000000000001';
export const OTHER_USER = 'a1000000-0000-4000-8000-000000000009';
export const LEAD_ID = 'c1580000-0000-4000-8000-000000000001';

/** The Leads card's read (src/components/networking/ContractorLeadsCard.tsx), as the data path runs it. */
export const LEADS_READ = `SELECT id, homeowner_name, homeowner_email, homeowner_phone, property_zip, loss_type, message,
         status, created_at, contacted_at, accepted_at, dtp_claim_number
    FROM public.homeowner_intro_requests ORDER BY created_at DESC LIMIT 200`;

export function homeownerIntroSchema() {
  return `
CREATE TABLE public.homeowner_intro_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id uuid,
  contractor_user_id uuid,
  homeowner_name text NOT NULL,
  homeowner_email text NOT NULL,
  homeowner_phone text,
  property_zip text,
  loss_type text,
  message text,
  status text NOT NULL DEFAULT 'new',
  access_token text NOT NULL DEFAULT md5(random()::text),
  created_at timestamptz NOT NULL DEFAULT now(),
  contacted_at timestamptz,
  accepted_at timestamptz,
  dtp_claim_number text
);
ALTER TABLE public.homeowner_intro_requests ENABLE ROW LEVEL SECURITY;
${policyBlock('12_final_select_policies.sql', 'aws_select_homeowner_intro_requests')}
DO $sql158_fixture$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $sql158_fixture$;
REVOKE ALL ON TABLE public.homeowner_intro_requests FROM checksops, authenticated, PUBLIC;
GRANT SELECT ON TABLE public.homeowner_intro_requests TO service_role;
INSERT INTO public.homeowner_intro_requests (id, contractor_user_id, homeowner_name, homeowner_email, status)
  VALUES ('${LEAD_ID}', '${CONTRACTOR}', 'Home Owner', 'owner@example.invalid', 'new');
`;
}
