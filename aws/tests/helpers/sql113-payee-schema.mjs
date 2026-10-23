/**
 * The three payee tables for the SQL 113 PostgreSQL 16 tests, as the supabase migrations left
 * them (run as the superuser before the release fixture hands schema public to checksops_admin;
 * releaseFixture({ extra: [PAYEE_SCHEMA] })):
 *
 *   - public.external_payment_recipients: supabase/migrations/20260727224957_*.sql, plus
 *     stakeholder_account_id / provider_bank_name / provider_last_four / bank_linked_at
 *     (20260728120105_*.sql) and recipient_tenant_id (20260820194902_*.sql);
 *   - public.stakeholder_accounts: the fixture's minimal table (helpers/stakeholder-policies-pg.mjs)
 *     widened with the Lovable-era base columns the functions use and the supabase columns and
 *     checks: verification_status_check (20260606021757), account_type_check and origin /
 *     is_partner_payout / homeowner columns (20260712161508), the provider columns,
 *     verification_source_check and the four-value stakeholder_accounts_origin_check
 *     (20260728110453) with its provider_account_uniq index;
 *   - public.payment_provider_methods: 20260727224957_*.sql with its owner CHECK and bank_uniq
 *     unique index (the release fixture's minimal table is replaced).
 *
 * The AWS copy was restored without ACLs, so neither checksops nor authenticated holds any grant on
 * external_payment_recipients or payment_provider_methods (stakeholder_accounts keeps the
 * fixture's SELECT). Row-level security is on for all three with the aws/rls SELECT policies of
 * 12_final_select_policies.sql. The release fixture seeds TENANT_A (member MEMBER_A) and TENANT_B
 * (member MEMBER_B).
 */
import { policyBlock } from './stakeholder-policies-pg.mjs';

export const RECIPIENTS = 'public.external_payment_recipients';
export const STAKEHOLDERS = 'public.stakeholder_accounts';
export const METHODS = 'public.payment_provider_methods';

/** The four-value check supabase migration 20260728110453 left (what SQL 113 replaces). */
export const ORIGIN_CHECK_FOUR = "CHECK ((origin = ANY (ARRAY['tenant_owned'::text, 'partner_shared'::text, 'homeowner_link'::text, 'provider_connected'::text])))";

export const PAYEE_SCHEMA = `
ALTER TABLE ${STAKEHOLDERS}
  ADD COLUMN nickname text NOT NULL DEFAULT 'Account',
  ADD COLUMN custname text,
  ADD COLUMN account_type text NOT NULL DEFAULT 'operating',
  ADD COLUMN is_primary boolean NOT NULL DEFAULT false,
  ADD COLUMN chk_aba text,
  ADD COLUMN chk_acct text,
  ADD COLUMN created_by uuid,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN verification_source text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- 20260606021757
ALTER TABLE ${STAKEHOLDERS}
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verification_initiated_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS verification_token uuid,
  ADD COLUMN IF NOT EXISTS verification_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_failure_reason text,
  ADD COLUMN IF NOT EXISTS verification_recipient_email text;
ALTER TABLE ${STAKEHOLDERS}
  ADD CONSTRAINT stakeholder_accounts_verification_status_check
  CHECK (verification_status IN ('unverified','pending','verified','failed','locked','admin_override'));
-- 20260712161508
ALTER TABLE ${STAKEHOLDERS}
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'tenant_owned',
  ADD COLUMN IF NOT EXISTS is_partner_payout boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS homeowner_link_token_id uuid,
  ADD COLUMN IF NOT EXISTS homeowner_email text,
  ADD COLUMN IF NOT EXISTS homeowner_name text;
CREATE UNIQUE INDEX IF NOT EXISTS stakeholder_accounts_one_partner_payout
  ON ${STAKEHOLDERS} (tenant_id) WHERE is_partner_payout = true AND is_active = true;
ALTER TABLE ${STAKEHOLDERS}
  ADD CONSTRAINT stakeholder_accounts_account_type_check
  CHECK (account_type IN (
    'operating','vendor','subcontractor','overhead','insured',
    'contractor','supplier','sales_rep','homeowner','other'
  ));
-- 20260728110453
ALTER TABLE ${STAKEHOLDERS}
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_environment text,
  ADD COLUMN IF NOT EXISTS provider_account_id text,
  ADD COLUMN IF NOT EXISTS provider_bank_account_id text,
  ADD COLUMN IF NOT EXISTS provider_bank_name text,
  ADD COLUMN IF NOT EXISTS provider_last_four text;
ALTER TABLE ${STAKEHOLDERS}
  ADD CONSTRAINT stakeholder_accounts_verification_source_check
  CHECK (verification_source = ANY (ARRAY['authentecheck'::text,'plaid'::text,'manual'::text,'moov'::text]));
ALTER TABLE ${STAKEHOLDERS}
  ADD CONSTRAINT stakeholder_accounts_origin_check
  CHECK (origin = ANY (ARRAY['tenant_owned'::text,'partner_shared'::text,'homeowner_link'::text,'provider_connected'::text]));
CREATE UNIQUE INDEX IF NOT EXISTS stakeholder_accounts_provider_account_uniq
  ON ${STAKEHOLDERS} (tenant_id, provider, provider_environment)
  WHERE origin = 'provider_connected';

-- 20260727224957 (external recipients), 20260728120105 and 20260820194902 (their later columns).
CREATE TABLE ${RECIPIENTS} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  display_name text NOT NULL,
  email text,
  phone text,
  recipient_type text NOT NULL DEFAULT 'individual',
  relationship text,
  provider_account_id text,
  onboarding_status text NOT NULL DEFAULT 'not_started',
  secure_token text UNIQUE,
  token_expires_at timestamptz,
  token_used_at timestamptz,
  claim_id uuid,
  check_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX external_payment_recipients_tenant_idx ON ${RECIPIENTS} (tenant_id);
ALTER TABLE ${RECIPIENTS}
  ADD COLUMN IF NOT EXISTS stakeholder_account_id uuid REFERENCES ${STAKEHOLDERS}(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider_bank_name text,
  ADD COLUMN IF NOT EXISTS provider_last_four text,
  ADD COLUMN IF NOT EXISTS bank_linked_at timestamptz;
CREATE INDEX external_payment_recipients_stakeholder_idx ON ${RECIPIENTS} (stakeholder_account_id);
ALTER TABLE ${RECIPIENTS} ADD COLUMN IF NOT EXISTS recipient_tenant_id uuid REFERENCES public.tenants(id);

-- 20260727224957 (payment methods); replaces the release fixture's minimal table.
DROP TABLE ${METHODS};
CREATE TABLE ${METHODS} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
  external_recipient_id uuid REFERENCES ${RECIPIENTS}(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  provider_account_id text NOT NULL,
  provider_bank_account_id text NOT NULL,
  provider_payment_method_id text,
  bank_name text,
  account_type text,
  last_four text,
  holder_name text,
  verification_status text NOT NULL DEFAULT 'pending',
  connection_status text NOT NULL DEFAULT 'pending',
  can_send boolean NOT NULL DEFAULT false,
  can_receive boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  connected_at timestamptz,
  disconnected_at timestamptz,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_provider_methods_owner_chk
    CHECK (tenant_id IS NOT NULL OR external_recipient_id IS NOT NULL)
);
CREATE UNIQUE INDEX payment_provider_methods_bank_uniq
  ON ${METHODS} (provider, environment, provider_account_id, provider_bank_account_id);

-- Restored without ACLs: no grant to checksops or authenticated on the two payment tables.
REVOKE ALL ON TABLE ${RECIPIENTS}, ${METHODS} FROM PUBLIC, checksops, authenticated;
ALTER TABLE ${RECIPIENTS} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${METHODS} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${STAKEHOLDERS} ENABLE ROW LEVEL SECURITY;
${policyBlock('12_final_select_policies.sql', 'aws_select_external_payment_recipients')}
${policyBlock('12_final_select_policies.sql', 'aws_select_payment_provider_methods')}
${policyBlock('12_final_select_policies.sql', 'aws_select_stakeholder_accounts')}
`;

/** The three-value check of 20260712161508 (before 20260728110453): SQL 113 refuses it. */
export const ORIGIN_CHECK_THREE_VALUES = `
ALTER TABLE ${STAKEHOLDERS} DROP CONSTRAINT stakeholder_accounts_origin_check;
ALTER TABLE ${STAKEHOLDERS} ADD CONSTRAINT stakeholder_accounts_origin_check
  CHECK (origin IN ('tenant_owned','partner_shared','homeowner_link'));`;
