CREATE TABLE IF NOT EXISTS public.micro_deposit_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  stakeholder_account_id uuid NOT NULL REFERENCES public.stakeholder_accounts(id) ON DELETE CASCADE,
  initiated_by uuid NOT NULL REFERENCES auth.users(id),
  actum_order_id_1 text,
  actum_history_id_1 text,
  actum_order_id_2 text,
  actum_history_id_2 text,
  amount_1_cents integer NOT NULL,
  amount_2_cents integer NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'failed', 'expired')),
  verified_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.micro_deposit_verifications TO authenticated;
GRANT ALL ON public.micro_deposit_verifications TO service_role;

ALTER TABLE public.micro_deposit_verifications ENABLE ROW LEVEL SECURITY;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'micro_deposit_verifications' 
    AND policyname = 'tenant_isolation_micro_deposits'
  ) THEN
    CREATE POLICY "tenant_isolation_micro_deposits" ON public.micro_deposit_verifications
      FOR ALL USING (tenant_id IN (
        SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()
      ));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.verify_micro_deposits(
  p_verification_id uuid,
  p_amount_1 numeric,
  p_amount_2 numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_verification record;
  v_amount_1_cents integer;
  v_amount_2_cents integer;
BEGIN
  SELECT * INTO v_verification FROM public.micro_deposit_verifications
    WHERE id = p_verification_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Verification not found'); END IF;
  IF v_verification.status != 'pending' THEN RETURN jsonb_build_object('success', false, 'error', 'Verification is no longer pending'); END IF;
  IF v_verification.expires_at < now() THEN
    UPDATE public.micro_deposit_verifications SET status = 'expired' WHERE id = p_verification_id;
    RETURN jsonb_build_object('success', false, 'error', 'Verification expired. Please request new deposits.');
  END IF;
  IF v_verification.attempts >= v_verification.max_attempts THEN
    UPDATE public.micro_deposit_verifications SET status = 'failed' WHERE id = p_verification_id;
    UPDATE public.stakeholder_accounts SET verification_status = 'failed' WHERE id = v_verification.stakeholder_account_id;
    RETURN jsonb_build_object('success', false, 'error', 'Too many failed attempts.');
  END IF;
  v_amount_1_cents := ROUND(p_amount_1 * 100)::integer;
  v_amount_2_cents := ROUND(p_amount_2 * 100)::integer;
  IF (v_amount_1_cents = v_verification.amount_1_cents AND v_amount_2_cents = v_verification.amount_2_cents)
    OR (v_amount_1_cents = v_verification.amount_2_cents AND v_amount_2_cents = v_verification.amount_1_cents) THEN
    UPDATE public.micro_deposit_verifications SET status = 'verified', verified_at = now() WHERE id = p_verification_id;
    UPDATE public.stakeholder_accounts SET verification_status = 'verified', verified_at = now() WHERE id = v_verification.stakeholder_account_id;
    RETURN jsonb_build_object('success', true);
  ELSE
    UPDATE public.micro_deposit_verifications SET attempts = attempts + 1 WHERE id = p_verification_id;
    RETURN jsonb_build_object('success', false, 'error',
      format('%s attempt(s) remaining.', v_verification.max_attempts - v_verification.attempts - 1));
  END IF;
END; $$;