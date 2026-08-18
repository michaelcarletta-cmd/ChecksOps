DO $$
DECLARE
  v_check public.check_intake_items%ROWTYPE;
BEGIN
  SELECT *
    INTO v_check
  FROM public.check_intake_items
  ORDER BY updated_at DESC
  LIMIT 1;

  IF FOUND THEN
    PERFORM public.tg_record_mortgage_handling_billing();
  END IF;
EXCEPTION
  WHEN SQLSTATE '0A000' THEN
    NULL;
END;
$$;