
CREATE OR REPLACE FUNCTION public.recompute_check_release_stage(_check_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_amount numeric;
  v_stage public.check_stage;
  v_released numeric;
  v_fully boolean;
BEGIN
  IF _check_id IS NULL THEN RETURN; END IF;

  SELECT amount, check_stage INTO v_amount, v_stage
  FROM public.check_intake_items WHERE id = _check_id;

  IF NOT FOUND THEN RETURN; END IF;
  -- only manage the deposited <-> funds_released boundary
  IF v_stage IS NOT NULL AND v_stage NOT IN ('deposited'::public.check_stage, 'funds_released'::public.check_stage) THEN
    RETURN;
  END IF;

  SELECT coalesce(sum(s.amount), 0) INTO v_released
  FROM public.disbursement_splits s
  JOIN public.disbursement_batches b ON b.id = s.batch_id
  WHERE b.check_intake_item_id = _check_id
    AND lower(coalesce(s.status, '')) IN ('submitted','settled','completed','paid','sent');

  v_fully := coalesce(v_amount, 0) > 0 AND v_released >= (coalesce(v_amount, 0) - 0.01);

  IF v_fully AND v_stage IS DISTINCT FROM 'funds_released'::public.check_stage THEN
    UPDATE public.check_intake_items
       SET check_stage = 'funds_released'::public.check_stage, updated_at = now()
     WHERE id = _check_id;
    UPDATE public.claim_checks
       SET check_stage = 'funds_released'::public.check_stage, updated_at = now()
     WHERE check_intake_item_id = _check_id
       AND check_stage IS DISTINCT FROM 'funds_released'::public.check_stage;
  ELSIF (NOT v_fully) AND v_stage = 'funds_released'::public.check_stage THEN
    UPDATE public.check_intake_items
       SET check_stage = 'deposited'::public.check_stage, updated_at = now()
     WHERE id = _check_id;
    UPDATE public.claim_checks
       SET check_stage = 'deposited'::public.check_stage, updated_at = now()
     WHERE check_intake_item_id = _check_id
       AND check_stage IS DISTINCT FROM 'deposited'::public.check_stage;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_check_stage_on_disbursement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_intake_id uuid;
BEGIN
  SELECT check_intake_item_id INTO v_intake_id
  FROM public.disbursement_batches
  WHERE id = coalesce(NEW.batch_id, OLD.batch_id);

  IF v_intake_id IS NOT NULL THEN
    PERFORM public.recompute_check_release_stage(v_intake_id);
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_check_stage_on_batch_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.check_intake_item_id IS NOT NULL THEN
    PERFORM public.recompute_check_release_stage(NEW.check_intake_item_id);
  END IF;
  RETURN NEW;
END;
$$;

-- Backfill existing checks sitting in deposited / funds_released
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id FROM public.check_intake_items
    WHERE check_stage IN ('deposited'::public.check_stage, 'funds_released'::public.check_stage)
  LOOP
    PERFORM public.recompute_check_release_stage(r.id);
  END LOOP;
END $$;
