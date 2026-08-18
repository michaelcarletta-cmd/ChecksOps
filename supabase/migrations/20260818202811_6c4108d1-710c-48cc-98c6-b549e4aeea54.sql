CREATE OR REPLACE FUNCTION public.tg_record_mortgage_handling_billing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_claim_id uuid;
  v_is_first_check boolean;
  v_fee_cents integer;
BEGIN
  -- check_stage uses the canonical lane names: review and loss_draft.
  -- Compare enum values only against values that exist in public.check_stage.
  IF NEW.check_stage IN (
       'review'::public.check_stage,
       'loss_draft'::public.check_stage
     )
     AND OLD.check_stage NOT IN (
       'review'::public.check_stage,
       'loss_draft'::public.check_stage
     )
     AND NEW.check_source = 'insurance'
  THEN
    SELECT c.tenant_id, c.claim_id
      INTO v_tenant_id, v_claim_id
    FROM public.check_intake_items AS c
    WHERE c.id = NEW.id;

    IF v_tenant_id IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT NOT EXISTS (
      SELECT 1
      FROM public.check_billing_events AS e
      WHERE e.tenant_id = v_tenant_id
        AND e.event_type = 'mortgage_handling'
        AND e.check_intake_item_id IN (
          SELECT c.id
          FROM public.check_intake_items AS c
          WHERE c.tenant_id = v_tenant_id
            AND c.claim_id = v_claim_id
        )
    ) INTO v_is_first_check;

    v_fee_cents := CASE WHEN v_is_first_check THEN 1000 ELSE 500 END;

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
$$;