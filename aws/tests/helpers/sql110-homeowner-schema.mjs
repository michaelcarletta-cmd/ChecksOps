/**
 * homeowner_ledger_tokens / homeowner_ledger_check_uploads / homeowner_ledger_events for the
 * SQL 110 PostgreSQL 16 tests, as supabase/migrations/20260712113217_*.sql created them (plus
 * partner_code / sent_by_user_id / assigned_to_user_id from 20260712121802_*.sql and the
 * event_type CHECK of 20260722013730_*.sql), with SQL 68's grants (checksops: SELECT, INSERT,
 * UPDATE on tokens and uploads, no DELETE; authenticated: nothing, the AWS copy was restored
 * --no-acl) and the aws/rls policies (12 select, 24 / 21 write). The release fixture's minimal
 * tokens and events tables are replaced. Run as the superuser before ownership
 * (releaseFixture({ extra: [HOMEOWNER_SCHEMA] })). MEMBER_A becomes staff of TENANT_A and
 * MEMBER_B staff of TENANT_B, so aws_can_write_tenant holds for each in its own tenant only.
 * Seeds three tokens of TENANT_A: a pre-claim one, a revoked one and an expired one.
 */
import { CLAIM_A, MEMBER_A, MEMBER_B, TENANT_A } from './release-sql-pg.mjs';
import { policyBlock } from './stakeholder-policies-pg.mjs';

export const TOKEN_OK_ID = 'c1000000-0000-4000-8000-000000000001';
export const TOKEN_REVOKED_ID = 'c1000000-0000-4000-8000-000000000002';
export const TOKEN_EXPIRED_ID = 'c1000000-0000-4000-8000-000000000003';
export const TOKEN_CLAIM_ID = 'c1000000-0000-4000-8000-000000000004';
export const TOKEN_OK = 'preclaim-ok-token-0001';
export const TOKEN_REVOKED = 'preclaim-revoked-token-0002';
export const TOKEN_EXPIRED = 'preclaim-expired-token-0003';
export const TOKEN_CLAIM = 'claim-linked-token-0004';

export const HOMEOWNER_SCHEMA = `
DROP TABLE public.homeowner_ledger_tokens;
DROP TABLE public.homeowner_ledger_events;
CREATE TABLE public.homeowner_ledger_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE DEFAULT md5(random()::text),
  tenant_id uuid NOT NULL,
  claim_id uuid REFERENCES public.claims(id) ON DELETE CASCADE,
  homeowner_email text, homeowner_phone text, homeowner_name text,
  expires_at timestamptz, revoked_at timestamptz, last_viewed_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  partner_code text,
  sent_by_user_id uuid);
CREATE TABLE public.homeowner_ledger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  check_id uuid,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  amount numeric(12,2),
  actor_label text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.homeowner_ledger_events ADD CONSTRAINT homeowner_ledger_events_event_type_check CHECK (event_type = ANY (ARRAY[
  'check_received','endorsement_requested','endorsement_signed','endorsements_sent','ready_for_deposit','loss_draft_routing',
  'deposited','cleared','funds_released','production_projected','production_confirmed','production_doc_uploaded',
  'supplement_check','depreciation_check','deductible_check','homeowner_check_upload','homeowner_upload_attached',
  'document_sent','document_uploaded','document_signed_all','document_shared','document_delivered','document_viewed',
  'signature_reminder','mortgage_check_sent','mortgage_check_returned','mortgage_followup','mortgage_update',
  'contractor_upload','ops_note'
]));
CREATE TABLE public.homeowner_ledger_check_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  token_id uuid REFERENCES public.homeowner_ledger_tokens(id) ON DELETE SET NULL,
  claim_id uuid REFERENCES public.claims(id) ON DELETE SET NULL,
  front_path text NOT NULL,
  back_path text,
  amount_estimate numeric(12,2),
  homeowner_note text,
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','attached','rejected')),
  attached_check_id uuid, reviewed_by uuid, reviewed_at timestamptz, review_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  partner_code text,
  assigned_to_user_id uuid);
REVOKE ALL ON TABLE public.homeowner_ledger_tokens, public.homeowner_ledger_check_uploads, public.homeowner_ledger_events
  FROM checksops, authenticated;
-- SQL 68 (aws/workflows/sql/68_staging_class_a_grants.sql).
GRANT SELECT, INSERT, UPDATE ON TABLE public.homeowner_ledger_tokens TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.homeowner_ledger_check_uploads TO checksops;
GRANT SELECT ON TABLE public.homeowner_ledger_events TO checksops;
ALTER TABLE public.homeowner_ledger_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.homeowner_ledger_check_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.homeowner_ledger_events ENABLE ROW LEVEL SECURITY;
${policyBlock('12_final_select_policies.sql', 'aws_select_homeowner_ledger_tokens')}
${policyBlock('12_final_select_policies.sql', 'aws_select_homeowner_ledger_check_uploads')}
${policyBlock('12_final_select_policies.sql', 'aws_select_homeowner_ledger_events')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_homeowner_ledger_tokens')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_homeowner_ledger_check_uploads')}
${policyBlock('21_proposed_write_policies.sql', 'aws_write_homeowner_ledger_events')}
INSERT INTO public.user_roles (user_id, role) VALUES ('${MEMBER_A}', 'staff'), ('${MEMBER_B}', 'staff');
INSERT INTO public.homeowner_ledger_tokens (id, token, tenant_id, claim_id, partner_code, sent_by_user_id, created_by, revoked_at, expires_at) VALUES
  ('${TOKEN_OK_ID}', '${TOKEN_OK}', '${TENANT_A}', NULL, 'PARTNER1', '${MEMBER_A}', '${MEMBER_A}', NULL, now() + interval '30 days'),
  ('${TOKEN_REVOKED_ID}', '${TOKEN_REVOKED}', '${TENANT_A}', NULL, NULL, NULL, '${MEMBER_A}', now(), NULL),
  ('${TOKEN_EXPIRED_ID}', '${TOKEN_EXPIRED}', '${TENANT_A}', NULL, NULL, NULL, '${MEMBER_A}', NULL, now() - interval '1 day'),
  ('${TOKEN_CLAIM_ID}', '${TOKEN_CLAIM}', '${TENANT_A}', '${CLAIM_A}', NULL, NULL, '${MEMBER_A}', NULL, NULL);
`;
