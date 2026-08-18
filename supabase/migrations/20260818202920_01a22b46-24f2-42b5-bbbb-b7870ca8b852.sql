DO $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
  FROM public.check_intake_items
  WHERE check_stage IS NOT NULL
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    UPDATE public.check_intake_items
       SET check_stage = check_stage
     WHERE id = v_id;
  END IF;
END;
$$;