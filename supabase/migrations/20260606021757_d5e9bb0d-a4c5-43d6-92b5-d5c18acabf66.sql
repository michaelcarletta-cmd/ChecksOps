
-- Add verification columns to stakeholder_accounts
ALTER TABLE public.stakeholder_accounts
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verification_initiated_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_amount_1_cents integer,
  ADD COLUMN IF NOT EXISTS verification_amount_2_cents integer,
  ADD COLUMN IF NOT EXISTS verification_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS verification_token uuid,
  ADD COLUMN IF NOT EXISTS verification_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_failure_reason text,
  ADD COLUMN IF NOT EXISTS verification_recipient_email text;

ALTER TABLE public.stakeholder_accounts
  DROP CONSTRAINT IF EXISTS stakeholder_accounts_verification_status_check;
ALTER TABLE public.stakeholder_accounts
  ADD CONSTRAINT stakeholder_accounts_verification_status_check
  CHECK (verification_status IN ('unverified','pending','verified','failed','locked','admin_override'));

CREATE UNIQUE INDEX IF NOT EXISTS stakeholder_accounts_verification_token_idx
  ON public.stakeholder_accounts (verification_token)
  WHERE verification_token IS NOT NULL;

-- Hide secret amount columns from non-admin reads via a view + column privileges.
-- Revoke direct column SELECT on the secret amounts from authenticated.
REVOKE SELECT (verification_amount_1_cents, verification_amount_2_cents)
  ON public.stakeholder_accounts FROM authenticated;
GRANT SELECT (verification_amount_1_cents, verification_amount_2_cents)
  ON public.stakeholder_accounts TO service_role;

-- Audit log table
CREATE TABLE IF NOT EXISTS public.stakeholder_account_verification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stakeholder_account_id uuid NOT NULL REFERENCES public.stakeholder_accounts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'initiated','resent','attempt_success','attempt_failed','locked','expired','admin_override','reset'
  )),
  actor_user_id uuid REFERENCES auth.users(id),
  ip_address text,
  user_agent text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.stakeholder_account_verification_log TO authenticated;
GRANT ALL ON public.stakeholder_account_verification_log TO service_role;

ALTER TABLE public.stakeholder_account_verification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_users_read_verification_log"
  ON public.stakeholder_account_verification_log
  FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_users.tenant_id FROM public.tenant_users
      WHERE tenant_users.user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS verification_log_account_idx
  ON public.stakeholder_account_verification_log (stakeholder_account_id, created_at DESC);
