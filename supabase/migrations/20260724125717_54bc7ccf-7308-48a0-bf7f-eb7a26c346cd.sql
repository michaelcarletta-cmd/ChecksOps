
-- Only advance check to funds_released when a split reaches a successful state (submitted/settled).
DROP TRIGGER IF EXISTS trg_advance_stage_on_disbursement ON public.disbursement_splits;

CREATE OR REPLACE FUNCTION public.advance_check_stage_on_disbursement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intake_id uuid;
BEGIN
  -- Only fire on successful states
  IF NEW.status NOT IN ('submitted','settled') THEN
    RETURN NEW;
  END IF;

  -- On UPDATE: only if this row wasn't already successful
  IF TG_OP = 'UPDATE' AND OLD.status IN ('submitted','settled') THEN
    RETURN NEW;
  END IF;

  SELECT check_intake_item_id INTO v_intake_id
  FROM public.disbursement_batches
  WHERE id = NEW.batch_id;

  IF v_intake_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.check_intake_items
     SET check_stage = 'funds_released'::public.check_stage,
         updated_at = now()
   WHERE id = v_intake_id
     AND check_stage <> 'funds_released';

  UPDATE public.claim_checks
     SET check_stage = 'funds_released'::public.check_stage,
         updated_at = now()
   WHERE check_intake_item_id = v_intake_id
     AND check_stage <> 'funds_released';

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_advance_stage_on_disbursement
AFTER INSERT OR UPDATE OF status ON public.disbursement_splits
FOR EACH ROW
EXECUTE FUNCTION public.advance_check_stage_on_disbursement();
