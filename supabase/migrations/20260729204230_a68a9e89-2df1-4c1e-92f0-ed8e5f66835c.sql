
CREATE OR REPLACE FUNCTION public.advance_check_stage_on_disbursement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intake_id uuid;
BEGIN
  IF lower(coalesce(NEW.status,'')) NOT IN ('submitted','settled','completed','paid','sent') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND lower(coalesce(OLD.status,'')) IN ('submitted','settled','completed','paid','sent') THEN
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

CREATE OR REPLACE FUNCTION public.advance_check_stage_on_batch_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF lower(coalesce(NEW.status,'')) NOT IN ('completed','settled') THEN
    RETURN NEW;
  END IF;
  IF NEW.check_intake_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.check_intake_items
     SET check_stage = 'funds_released'::public.check_stage,
         updated_at = now()
   WHERE id = NEW.check_intake_item_id
     AND check_stage <> 'funds_released';

  UPDATE public.claim_checks
     SET check_stage = 'funds_released'::public.check_stage,
         updated_at = now()
   WHERE check_intake_item_id = NEW.check_intake_item_id
     AND check_stage <> 'funds_released';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_advance_stage_on_batch_complete ON public.disbursement_batches;
CREATE TRIGGER trg_advance_stage_on_batch_complete
AFTER INSERT OR UPDATE OF status ON public.disbursement_batches
FOR EACH ROW EXECUTE FUNCTION public.advance_check_stage_on_batch_complete();

-- Backfill: any check with a successful payout still not marked funds_released
WITH released AS (
  SELECT DISTINCT b.check_intake_item_id AS id
  FROM public.disbursement_batches b
  LEFT JOIN public.disbursement_splits s ON s.batch_id = b.id
  WHERE b.check_intake_item_id IS NOT NULL
    AND (
      lower(coalesce(b.status,'')) IN ('completed','settled')
      OR lower(coalesce(s.status,'')) IN ('submitted','settled','completed','paid','sent')
    )
)
UPDATE public.check_intake_items c
   SET check_stage = 'funds_released'::public.check_stage,
       updated_at = now()
  FROM released r
 WHERE c.id = r.id
   AND c.check_stage <> 'funds_released';

WITH released AS (
  SELECT DISTINCT b.check_intake_item_id AS id
  FROM public.disbursement_batches b
  LEFT JOIN public.disbursement_splits s ON s.batch_id = b.id
  WHERE b.check_intake_item_id IS NOT NULL
    AND (
      lower(coalesce(b.status,'')) IN ('completed','settled')
      OR lower(coalesce(s.status,'')) IN ('submitted','settled','completed','paid','sent')
    )
)
UPDATE public.claim_checks cc
   SET check_stage = 'funds_released'::public.check_stage,
       updated_at = now()
  FROM released r
 WHERE cc.check_intake_item_id = r.id
   AND cc.check_stage <> 'funds_released';
