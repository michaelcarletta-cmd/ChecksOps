CREATE OR REPLACE FUNCTION public.mirror_mortgage_dates_to_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_claim uuid;
  v_tenant uuid;
  v_check uuid;
  v_company text;
BEGIN
  SELECT ctx.resolved_claim_id, ctx.resolved_tenant_id, ctx.resolved_check_id
    INTO v_claim, v_tenant, v_check
  FROM public.resolve_homeowner_ledger_context(NEW.claim_id, NEW.check_intake_item_id, NULL) ctx
  LIMIT 1;

  v_company := COALESCE(NULLIF(NEW.mortgage_company, ''), NULLIF(NEW.mortgage_servicer, ''), 'mortgage company');

  IF v_claim IS NULL OR v_tenant IS NULL THEN
    RETURN NEW;
  END IF;

  IF (TG_OP = 'INSERT' OR NEW.check_sent_date IS DISTINCT FROM OLD.check_sent_date)
     AND NEW.check_sent_date IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.homeowner_ledger_events hle
       WHERE hle.claim_id = v_claim
         AND hle.event_type = 'mortgage_check_sent'
         AND hle.payload_json->>'mortgage_request_id' = NEW.id::text
     ) THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json
    ) VALUES (
      v_tenant, v_claim, v_check, 'mortgage_check_sent', NEW.check_sent_date,
      'Check sent to ' || v_company,
      jsonb_build_object(
        'mortgage_request_id', NEW.id,
        'mortgage_company', v_company,
        'tracking_number', NULLIF(NEW.note, '')
      )
    );
  END IF;

  IF (TG_OP = 'INSERT' OR NEW.check_received_back_date IS DISTINCT FROM OLD.check_received_back_date)
     AND NEW.check_received_back_date IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.homeowner_ledger_events hle
       WHERE hle.claim_id = v_claim
         AND hle.event_type = 'mortgage_check_returned'
         AND hle.payload_json->>'mortgage_request_id' = NEW.id::text
     ) THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json
    ) VALUES (
      v_tenant, v_claim, v_check, 'mortgage_check_returned', NEW.check_received_back_date,
      'Endorsed check returned from ' || v_company,
      jsonb_build_object(
        'mortgage_request_id', NEW.id,
        'mortgage_company', v_company
      )
    );
  END IF;

  RETURN NEW;
END;
$$;