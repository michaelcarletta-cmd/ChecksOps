CREATE OR REPLACE FUNCTION public.resolve_check_case(
  _tenant_id uuid,
  _claim_id uuid DEFAULT NULL,
  _external_claim_id uuid DEFAULT NULL,
  _claim_number text DEFAULT NULL,
  _insured_name text DEFAULT NULL,
  _property_address text DEFAULT NULL,
  _carrier_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case_id uuid;
  v_ext uuid := COALESCE(_claim_id, _external_claim_id);
  v_claim public.claims%ROWTYPE;
BEGIN
  IF _tenant_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_ext IS NOT NULL THEN
    SELECT id INTO v_case_id FROM public.check_cases
     WHERE external_system = 'freedom_crm' AND external_claim_id = v_ext
     LIMIT 1;
    IF v_case_id IS NOT NULL THEN
      RETURN v_case_id;
    END IF;
  END IF;

  IF _claim_id IS NOT NULL THEN
    SELECT * INTO v_claim FROM public.claims WHERE id = _claim_id;
  END IF;

  IF v_ext IS NULL AND _claim_number IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_ext IS NULL THEN
    SELECT id INTO v_case_id FROM public.check_cases
     WHERE tenant_id = _tenant_id
       AND external_claim_id IS NULL
       AND claim_number IS NOT DISTINCT FROM _claim_number
     LIMIT 1;
    IF v_case_id IS NOT NULL THEN
      RETURN v_case_id;
    END IF;
  END IF;

  INSERT INTO public.check_cases (
    tenant_id, external_system, external_claim_id, claim_number, insured_name,
    insured_email, insured_phone, property_address, carrier_name, policy_number,
    mortgage_company_id, loan_number, loss_date
  ) VALUES (
    _tenant_id,
    CASE WHEN v_ext IS NULL THEN 'checksops' ELSE 'freedom_crm' END,
    v_ext,
    COALESCE(v_claim.claim_number, _claim_number),
    COALESCE(v_claim.policyholder_name, _insured_name),
    v_claim.policyholder_email,
    v_claim.policyholder_phone,
    COALESCE(v_claim.policyholder_address, _property_address),
    COALESCE(v_claim.insurance_company, _carrier_name),
    v_claim.policy_number,
    v_claim.mortgage_company_id,
    v_claim.loan_number,
    v_claim.loss_date
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_case_id;

  IF v_case_id IS NULL AND v_ext IS NOT NULL THEN
    SELECT id INTO v_case_id FROM public.check_cases
     WHERE external_system = 'freedom_crm' AND external_claim_id = v_ext LIMIT 1;
  END IF;

  RETURN v_case_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_check_intake_assign_case()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.case_id IS NULL THEN
    NEW.case_id := public.resolve_check_case(
      NEW.tenant_id,
      NEW.claim_id,
      NEW.freedom_claim_id,
      COALESCE(NEW.freedom_claim_number, NEW.detected_claim_number),
      NEW.payee_line,
      NEW.property_address,
      NEW.carrier_name
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assign_case_on_check_intake
  BEFORE INSERT OR UPDATE OF claim_id, freedom_claim_id, tenant_id
  ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_check_intake_assign_case();

CREATE OR REPLACE FUNCTION public.tg_loss_draft_assign_case()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_case uuid; v_tenant uuid;
BEGIN
  IF NEW.case_id IS NULL THEN
    SELECT case_id, tenant_id INTO v_case, v_tenant
      FROM public.check_intake_items WHERE id = NEW.check_intake_item_id;
    IF v_case IS NULL AND NEW.claim_id IS NOT NULL THEN
      v_case := public.resolve_check_case(v_tenant, NEW.claim_id);
    END IF;
    NEW.case_id := v_case;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assign_case_on_loss_draft
  BEFORE INSERT OR UPDATE OF claim_id, check_intake_item_id
  ON public.loss_draft_tracking
  FOR EACH ROW EXECUTE FUNCTION public.tg_loss_draft_assign_case();

CREATE OR REPLACE FUNCTION public.tg_claim_id_assign_case()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.case_id IS NULL AND NEW.claim_id IS NOT NULL THEN
    SELECT id INTO NEW.case_id FROM public.check_cases
     WHERE external_system = 'freedom_crm' AND external_claim_id = NEW.claim_id
     LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assign_case_on_ledger_events
  BEFORE INSERT OR UPDATE OF claim_id ON public.homeowner_ledger_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_claim_id_assign_case();

CREATE TRIGGER assign_case_on_ledger_tokens
  BEFORE INSERT OR UPDATE OF claim_id ON public.homeowner_ledger_tokens
  FOR EACH ROW EXECUTE FUNCTION public.tg_claim_id_assign_case();

CREATE TRIGGER assign_case_on_ledger_uploads
  BEFORE INSERT OR UPDATE OF claim_id ON public.homeowner_ledger_check_uploads
  FOR EACH ROW EXECUTE FUNCTION public.tg_claim_id_assign_case();

CREATE TRIGGER assign_case_on_mortgage_releases
  BEFORE INSERT OR UPDATE OF claim_id ON public.mortgage_releases
  FOR EACH ROW EXECUTE FUNCTION public.tg_claim_id_assign_case();

CREATE TRIGGER assign_case_on_mortgage_draws
  BEFORE INSERT OR UPDATE OF claim_id ON public.claim_check_mortgage_draws
  FOR EACH ROW EXECUTE FUNCTION public.tg_claim_id_assign_case();

CREATE TRIGGER assign_case_on_signature_requests
  BEFORE INSERT OR UPDATE OF claim_id ON public.signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_claim_id_assign_case();