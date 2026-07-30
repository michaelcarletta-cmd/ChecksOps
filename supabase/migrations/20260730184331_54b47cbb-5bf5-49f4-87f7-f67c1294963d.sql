CREATE OR REPLACE FUNCTION public.recompute_check_release_stage(_check_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_stage public.check_stage;
  v_ok int;
  v_outstanding int;
  v_fully boolean;
BEGIN
  IF _check_id IS NULL THEN RETURN; END IF;

  SELECT check_stage INTO v_stage
  FROM public.check_intake_items
  WHERE id = _check_id;

  IF NOT FOUND THEN RETURN; END IF;
  IF v_stage IS NOT NULL
     AND v_stage NOT IN ('deposited'::public.check_stage, 'funds_released'::public.check_stage) THEN
    RETURN;
  END IF;

  SELECT
    count(*) FILTER (
      WHERE lower(coalesce(s.status, '')) IN ('submitted', 'settled', 'completed', 'paid', 'sent', 'cleared', 'processed')
    ),
    count(*) FILTER (
      WHERE lower(coalesce(s.status, '')) NOT IN (
        'submitted', 'settled', 'completed', 'paid', 'sent', 'cleared', 'processed',
        'failed', 'returned', 'rejected', 'declined', 'canceled', 'cancelled', 'voided'
      )
    )
  INTO v_ok, v_outstanding
  FROM public.disbursement_splits s
  JOIN public.disbursement_batches b ON b.id = s.batch_id
  WHERE b.check_intake_item_id = _check_id;

  v_fully := v_ok > 0 AND v_outstanding = 0;

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