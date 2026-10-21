/**
 * payment_transfers / payment_event_log for the SQL 106 PostgreSQL 16 tests, as
 * supabase/migrations/20260727224957_*.sql created them (plus the leg_role / wallet_id columns
 * later migrations added), with their grants and the aws/rls policies; the release fixture's
 * minimal payment_event_log is replaced. Run as the superuser before ownership
 * (releaseFixture({ extra: [PAYMENT_SCHEMA] })). Seeds four transfers.
 */
import { TENANT_A, TENANT_B } from './release-sql-pg.mjs';
import { policyBlock } from './stakeholder-policies-pg.mjs';

export const SEND_A = 'b1000000-0000-4000-8000-00000000000a';
export const FUND_B = 'b1000000-0000-4000-8000-00000000000b';
export const COLLECT_A = 'b1000000-0000-4000-8000-00000000000c';
export const SANDBOX_A = 'b1000000-0000-4000-8000-00000000000d';

// payment_transfers / payment_event_log as supabase/migrations/20260727224957_*.sql created them
// (plus the leg_role / wallet_id columns later migrations added), with their grants and the
// aws/rls policies; the fixture's minimal payment_event_log is replaced.
export const PAYMENT_SCHEMA = `
DROP TABLE public.payment_event_log;
CREATE TABLE public.payment_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  provider_transfer_id text,
  provider_status text,
  status text NOT NULL DEFAULT 'draft',
  idempotency_key text NOT NULL,
  amount_cents bigint NOT NULL,
  description text,
  check_id uuid,
  failure_reason text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  leg_role text,
  wallet_id uuid,
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_transfers_amount_positive CHECK (amount_cents > 0));
CREATE UNIQUE INDEX payment_transfers_provider_id_uniq ON public.payment_transfers (provider, environment, provider_transfer_id)
  WHERE provider_transfer_id IS NOT NULL;
CREATE TABLE public.payment_event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  recipient_id uuid,
  transfer_id uuid REFERENCES public.payment_transfers(id) ON DELETE SET NULL,
  provider_transfer_id text,
  event_type text NOT NULL,
  previous_status text,
  new_status text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.payment_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_event_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_transfers TO authenticated;
GRANT SELECT, INSERT ON public.payment_event_log TO authenticated, checksops;
${policyBlock('12_final_select_policies.sql', 'aws_select_payment_transfers')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_payment_transfers')}
${policyBlock('12_final_select_policies.sql', 'aws_select_payment_event_log')}
INSERT INTO public.payment_transfers (id, tenant_id, environment, provider_transfer_id, provider_status, status, idempotency_key, amount_cents, leg_role) VALUES
  ('${SEND_A}', '${TENANT_A}', 'production', 'mv-send-a', 'created', 'submitted', 'send:a:0:bank', 12500, 'send_bank'),
  ('${FUND_B}', '${TENANT_B}', 'production', 'mv-fund-b', 'pending', 'pending', 'wallet-fund:b', 50000, 'wallet_funding'),
  ('${COLLECT_A}', '${TENANT_A}', 'production', 'mv-collect-a', 'pending', 'submitted', 'collect:a', 9900, 'collection_debit'),
  ('${SANDBOX_A}', '${TENANT_A}', 'sandbox', 'mv-send-a', 'created', 'submitted', 'send:a:sandbox', 12500, 'send_bank');`;
