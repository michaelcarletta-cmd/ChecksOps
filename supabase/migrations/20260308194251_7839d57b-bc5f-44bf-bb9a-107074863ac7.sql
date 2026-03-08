
-- ============================================================
-- Endorsement Engine Tables
-- ============================================================

-- 1. check_endorsements — one row per payee per check
CREATE TABLE public.check_endorsements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id UUID NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  payee_id UUID REFERENCES public.check_payees(id) ON DELETE SET NULL,
  payee_name TEXT NOT NULL,
  payee_type TEXT NOT NULL DEFAULT 'other'
    CHECK (payee_type IN ('insured','public_adjuster','mortgage_company','contractor','other')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','signed','waived','manual_required','rejected','expired')),
  signature_method TEXT DEFAULT 'portal'
    CHECK (signature_method IN ('portal','sms','email','internal','manual')),
  signed_at TIMESTAMPTZ,
  signature_image_url TEXT,
  ip_address TEXT,
  user_agent TEXT,
  consent_text TEXT,
  request_sent_at TIMESTAMPTZ,
  last_reminder_at TIMESTAMPTZ,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  token TEXT UNIQUE DEFAULT gen_random_uuid()::text,
  token_expires_at TIMESTAMPTZ DEFAULT (now() + interval '30 days'),
  contact_email TEXT,
  contact_phone TEXT,
  notes TEXT,
  loss_draft_task_created BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_check_endorsements_check_id ON public.check_endorsements(check_id);
CREATE INDEX idx_check_endorsements_token ON public.check_endorsements(token);
CREATE INDEX idx_check_endorsements_status ON public.check_endorsements(status);

-- 2. endorsement_requests — tracks every send/resend attempt
CREATE TABLE public.endorsement_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endorsement_id UUID NOT NULL REFERENCES public.check_endorsements(id) ON DELETE CASCADE,
  check_id UUID NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('email','sms','both')),
  sent_by UUID,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivery_status TEXT DEFAULT 'pending'
    CHECK (delivery_status IN ('pending','delivered','failed','bounced')),
  delivery_error TEXT,
  email_address TEXT,
  phone_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_endorsement_requests_endorsement_id ON public.endorsement_requests(endorsement_id);

-- 3. endorsement_audit_log — full forensic audit trail
CREATE TABLE public.endorsement_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endorsement_id UUID NOT NULL REFERENCES public.check_endorsements(id) ON DELETE CASCADE,
  check_id UUID NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_description TEXT,
  event_data JSONB,
  actor_id UUID,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_endorsement_audit_log_endorsement_id ON public.endorsement_audit_log(endorsement_id);
CREATE INDEX idx_endorsement_audit_log_check_id ON public.endorsement_audit_log(check_id);

-- ============================================================
-- RLS Policies
-- ============================================================

ALTER TABLE public.check_endorsements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.endorsement_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.endorsement_audit_log ENABLE ROW LEVEL SECURITY;

-- Staff/admin can manage endorsements
CREATE POLICY "Staff can manage endorsements"
  ON public.check_endorsements FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

-- Public token-based read for signers (via service role in edge function)
CREATE POLICY "Staff can manage endorsement requests"
  ON public.endorsement_requests FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff can view endorsement audit log"
  ON public.endorsement_audit_log FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff can insert endorsement audit log"
  ON public.endorsement_audit_log FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- RPC: Auto-create endorsements from payees after OCR
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_endorsements_from_payees(
  p_check_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payee RECORD;
  v_count INT := 0;
  v_mortgage_found BOOLEAN := false;
  v_claim_id UUID;
BEGIN
  -- Get claim_id for loss draft creation
  SELECT claim_id INTO v_claim_id
  FROM check_intake_items WHERE id = p_check_id;

  -- Delete existing endorsements that haven't been signed yet (for OCR rerun)
  DELETE FROM check_endorsements
  WHERE check_id = p_check_id AND status IN ('pending', 'sent');

  -- Create one endorsement per payee
  FOR v_payee IN
    SELECT * FROM check_payees WHERE check_id = p_check_id
  LOOP
    INSERT INTO check_endorsements (
      check_id, payee_id, payee_name, payee_type,
      status, signature_method, contact_email, contact_phone
    ) VALUES (
      p_check_id,
      v_payee.id,
      v_payee.payee_name,
      CASE
        WHEN v_payee.payee_type IN ('insured','public_adjuster','mortgage_company','contractor')
        THEN v_payee.payee_type
        ELSE 'other'
      END,
      CASE
        WHEN v_payee.payee_type = 'mortgage_company' THEN 'manual_required'
        ELSE 'pending'
      END,
      CASE
        WHEN v_payee.payee_type IN ('insured','public_adjuster','contractor','other') THEN 'portal'
        WHEN v_payee.payee_type = 'mortgage_company' THEN 'manual'
        ELSE 'portal'
      END,
      v_payee.contact_email,
      v_payee.contact_phone
    );

    v_count := v_count + 1;

    IF v_payee.payee_type = 'mortgage_company' THEN
      v_mortgage_found := true;
    END IF;

    -- Audit
    INSERT INTO endorsement_audit_log (endorsement_id, check_id, event_type, event_description, event_data)
    SELECT id, p_check_id, 'endorsement_created',
      format('Endorsement created for %s (%s)', v_payee.payee_name, v_payee.payee_type),
      jsonb_build_object('payee_id', v_payee.id, 'payee_type', v_payee.payee_type)
    FROM check_endorsements
    WHERE check_id = p_check_id AND payee_id = v_payee.id
    ORDER BY created_at DESC LIMIT 1;
  END LOOP;

  -- If mortgage company found, create loss draft task
  IF v_mortgage_found AND v_claim_id IS NOT NULL THEN
    -- Check if loss draft doesn't already exist for this claim
    IF NOT EXISTS (
      SELECT 1 FROM loss_draft_tracking WHERE claim_id = v_claim_id
    ) THEN
      INSERT INTO loss_draft_tracking (claim_id, lender_name, escrow_status)
      SELECT v_claim_id, v_payee.payee_name, 'pending_send'
      FROM check_payees
      WHERE check_id = p_check_id AND payee_type = 'mortgage_company'
      LIMIT 1;

      -- Initialize documents
      PERFORM init_loss_draft_documents(
        (SELECT id FROM loss_draft_tracking WHERE claim_id = v_claim_id ORDER BY created_at DESC LIMIT 1)
      );
    END IF;

    -- Flag the check
    UPDATE check_intake_items
    SET deposit_recommendation_reasons = COALESCE(deposit_recommendation_reasons, '[]'::jsonb) || '["mortgage_endorsement_required"]'::jsonb
    WHERE id = p_check_id;

    INSERT INTO check_audit_log (check_id, event_type, event_description)
    VALUES (p_check_id, 'mortgage_detected', 'Mortgage company payee detected — loss draft workflow initiated');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'endorsements_created', v_count,
    'mortgage_detected', v_mortgage_found
  );
END;
$$;
