
-- =========================================================
-- Homeowner Ledger: tokens, events, pre-claim uploads
-- =========================================================

-- ---------- homeowner_ledger_tokens ----------
CREATE TABLE public.homeowner_ledger_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  tenant_id UUID NOT NULL,
  claim_id UUID REFERENCES public.claims(id) ON DELETE CASCADE,
  homeowner_email TEXT,
  homeowner_phone TEXT,
  homeowner_name TEXT,
  expires_at TIMESTAMPTZ,           -- null = never expires
  revoked_at TIMESTAMPTZ,
  last_viewed_at TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_hlt_claim ON public.homeowner_ledger_tokens(claim_id);
CREATE INDEX idx_hlt_tenant ON public.homeowner_ledger_tokens(tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.homeowner_ledger_tokens TO authenticated;
GRANT ALL ON public.homeowner_ledger_tokens TO service_role;

ALTER TABLE public.homeowner_ledger_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant staff manage ledger tokens"
  ON public.homeowner_ledger_tokens
  FOR ALL
  TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE TRIGGER trg_hlt_updated_at
  BEFORE UPDATE ON public.homeowner_ledger_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ---------- homeowner_ledger_events ----------
CREATE TABLE public.homeowner_ledger_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  check_id UUID,                     -- optional; may reference claim_checks or check_intake_items
  event_type TEXT NOT NULL CHECK (event_type IN (
    'check_received','endorsement_requested','endorsement_signed',
    'deposited','cleared','funds_released',
    'production_projected','production_confirmed','production_doc_uploaded',
    'supplement_check','depreciation_check','deductible_check',
    'homeowner_check_upload'
  )),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount NUMERIC(12,2),
  actor_label TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_hle_claim_time ON public.homeowner_ledger_events(claim_id, occurred_at DESC);
CREATE INDEX idx_hle_tenant ON public.homeowner_ledger_events(tenant_id);
CREATE INDEX idx_hle_check ON public.homeowner_ledger_events(check_id);

GRANT SELECT, INSERT ON public.homeowner_ledger_events TO authenticated;
GRANT ALL ON public.homeowner_ledger_events TO service_role;

ALTER TABLE public.homeowner_ledger_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant staff read ledger events"
  ON public.homeowner_ledger_events
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE POLICY "tenant staff insert ledger events"
  ON public.homeowner_ledger_events
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));


-- ---------- homeowner_check_uploads (pre-claim triage) ----------
-- Note: an existing table with the same name exists for the /h/upload contractor flow.
-- We create a distinct table for ledger pre-claim intake.
CREATE TABLE public.homeowner_ledger_check_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  token_id UUID REFERENCES public.homeowner_ledger_tokens(id) ON DELETE SET NULL,
  claim_id UUID REFERENCES public.claims(id) ON DELETE SET NULL,
  front_path TEXT NOT NULL,
  back_path TEXT,
  amount_estimate NUMERIC(12,2),
  homeowner_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','attached','rejected')),
  attached_check_id UUID,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_hlcu_tenant_status ON public.homeowner_ledger_check_uploads(tenant_id, status);
CREATE INDEX idx_hlcu_token ON public.homeowner_ledger_check_uploads(token_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.homeowner_ledger_check_uploads TO authenticated;
GRANT ALL ON public.homeowner_ledger_check_uploads TO service_role;

ALTER TABLE public.homeowner_ledger_check_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant staff manage ledger check uploads"
  ON public.homeowner_ledger_check_uploads
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE TRIGGER trg_hlcu_updated_at
  BEFORE UPDATE ON public.homeowner_ledger_check_uploads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =========================================================
-- Auto-population triggers
-- =========================================================

-- Insert 'check_received' when a new insurance check intake row is created (with a claim)
CREATE OR REPLACE FUNCTION public.hle_on_check_intake_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.claim_id IS NOT NULL AND NEW.check_source = 'insurance' THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json
    ) VALUES (
      NEW.tenant_id, NEW.claim_id, NEW.id, 'check_received',
      COALESCE(NEW.issue_date::timestamptz, NEW.created_at, now()),
      NEW.amount,
      NEW.carrier_name,
      jsonb_build_object(
        'check_number', NEW.check_number,
        'payee_line', NEW.payee_line
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_hle_check_intake_insert
  AFTER INSERT ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.hle_on_check_intake_insert();

-- 'deposited' event when deposited_at is populated
CREATE OR REPLACE FUNCTION public.hle_on_check_intake_deposited()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.claim_id IS NOT NULL
     AND NEW.deposited_at IS NOT NULL
     AND (OLD.deposited_at IS DISTINCT FROM NEW.deposited_at) THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, check_id, event_type, occurred_at, amount, payload_json
    ) VALUES (
      NEW.tenant_id, NEW.claim_id, NEW.id, 'deposited',
      NEW.deposited_at, NEW.amount,
      jsonb_build_object('check_number', NEW.check_number)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_hle_check_intake_deposited
  AFTER UPDATE OF deposited_at ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.hle_on_check_intake_deposited();

-- Endorsement request/sign events
CREATE OR REPLACE FUNCTION public.hle_on_endorsement_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim UUID;
  v_tenant UUID;
BEGIN
  SELECT claim_id, tenant_id INTO v_claim, v_tenant
  FROM public.check_intake_items WHERE id = NEW.check_id;

  IF v_claim IS NULL THEN
    RETURN NEW;
  END IF;

  -- On insert: endorsement requested
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json
    ) VALUES (
      v_tenant, v_claim, NEW.check_id, 'endorsement_requested',
      NEW.created_at, NEW.payee_name,
      jsonb_build_object('payee_type', NEW.payee_type)
    );
  END IF;

  -- On update to signed status
  IF TG_OP = 'UPDATE'
     AND NEW.status = 'signed'
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json
    ) VALUES (
      v_tenant, v_claim, NEW.check_id, 'endorsement_signed',
      COALESCE(NEW.signed_at, now()), NEW.payee_name,
      jsonb_build_object('payee_type', NEW.payee_type, 'method', NEW.signature_method)
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_hle_endorsement_insert
  AFTER INSERT ON public.check_endorsements
  FOR EACH ROW EXECUTE FUNCTION public.hle_on_endorsement_change();

CREATE TRIGGER trg_hle_endorsement_update
  AFTER UPDATE ON public.check_endorsements
  FOR EACH ROW EXECUTE FUNCTION public.hle_on_endorsement_change();

-- Disbursements → funds_released when status transitions to 'sent' or 'completed'
CREATE OR REPLACE FUNCTION public.hle_on_disbursement_sent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  IF NEW.status NOT IN ('sent','completed','paid') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id INTO v_tenant FROM public.claims WHERE id = NEW.claim_id;
  IF v_tenant IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.homeowner_ledger_events (
    tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json
  ) VALUES (
    v_tenant, NEW.claim_id, NEW.check_id, 'funds_released',
    now(), NEW.amount, NEW.recipient_name,
    jsonb_build_object('recipient_type', NEW.recipient_type, 'method', NEW.method, 'status', NEW.status)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_hle_disbursement_ins
  AFTER INSERT ON public.claim_disbursements
  FOR EACH ROW EXECUTE FUNCTION public.hle_on_disbursement_sent();

CREATE TRIGGER trg_hle_disbursement_upd
  AFTER UPDATE OF status ON public.claim_disbursements
  FOR EACH ROW EXECUTE FUNCTION public.hle_on_disbursement_sent();
