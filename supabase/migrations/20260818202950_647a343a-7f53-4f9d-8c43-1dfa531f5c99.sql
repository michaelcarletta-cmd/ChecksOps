DO $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
  FROM public.check_intake_items
  WHERE check_stage IN ('ready_for_deposit'::public.check_stage, 'deposited'::public.check_stage, 'funds_released'::public.check_stage)
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    PERFORM public.recompute_check_release_stage(v_id);
  END IF;
END;
$$;