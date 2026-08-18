
-- Trigger to record MortgageOps handling billing events
CREATE OR REPLACE FUNCTION public.tg_record_mortgage_handling_billing()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id uuid;
  v_claim_id uuid;
  v_is_first_check boolean;
  v_fee_cents integer;
BEGIN
  -- We only care about transitions TO 'needs_review' or 'loss_draft_required' 
  -- if the check_source is 'insurance' (mortgage ops only handles insurance checks)
  IF (NEW.check_stage IN ('needs_review', 'loss_draft_required')) AND 
     (OLD.check_stage NOT IN ('needs_review', 'loss_draft_required')) AND
     (NEW.check_source = 'insurance') THEN
    
    SELECT tenant_id, claim_id INTO v_tenant_id, v_claim_id
    FROM public.claim_checks
    WHERE id = NEW.id;

    -- Check if this claim has already had a mortgage handling event billed
    SELECT NOT EXISTS (
      SELECT 1 FROM public.check_billing_events
      WHERE tenant_id = v_tenant_id
        AND event_type = 'mortgage_handling'
        AND check_intake_item_id IN (
          SELECT id FROM public.check_intake_items WHERE claim_id = v_claim_id
        )
    ) INTO v_is_first_check;

    v_fee_cents := CASE WHEN v_is_first_check THEN 1000 ELSE 500 END;

    -- Record the event if not already recorded for this specific check
    INSERT INTO public.check_billing_events (
      tenant_id,
      check_intake_item_id,
      event_type,
      unit_price_cents,
      status
    )
    VALUES (
      v_tenant_id,
      NEW.id,
      'mortgage_handling',
      v_fee_cents,
      'reported'
    )
    ON CONFLICT (tenant_id, check_intake_item_id, event_type) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_record_mortgage_handling_billing ON public.check_intake_items;
CREATE TRIGGER tr_record_mortgage_handling_billing
  AFTER UPDATE OF check_stage ON public.check_intake_items
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_record_mortgage_handling_billing();
