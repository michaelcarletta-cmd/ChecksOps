-- NOT APPLIED. Repo artifact only. Do not apply from this PR until reviewed.
--
-- Safe OCR amount persistence for AWS check-ocr-intake.
-- Fills check_intake_items.amount only when the row is still empty and the
-- check has not been deposited/voided. Does not write claim_payments, MICR,
-- or ledger events. Does not GRANT table-column UPDATE of amount.
-- Generic /data/write remains blocked by INTAKE_PROHIBITED_COLUMNS.

CREATE OR REPLACE FUNCTION public.ocr_persist_extracted_amount(
  p_check_id uuid,
  p_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
SET row_security = off
AS $$
DECLARE
  v_existing numeric;
  v_deposited timestamptz;
  v_stage text;
BEGIN
  IF p_check_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'persisted', false, 'code', 'absent');
  END IF;

  SELECT amount, deposited_at, check_stage
    INTO v_existing, v_deposited, v_stage
  FROM public.check_intake_items
  WHERE id = p_check_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'check_not_found');
  END IF;

  IF v_deposited IS NOT NULL OR COALESCE(v_stage, '') IN ('deposited', 'voided', 'returned') THEN
    RETURN jsonb_build_object('ok', true, 'persisted', false, 'code', 'locked');
  END IF;

  IF v_existing IS NOT NULL THEN
    IF v_existing = p_amount THEN
      RETURN jsonb_build_object('ok', true, 'persisted', false, 'code', 'unchanged');
    END IF;
    RETURN jsonb_build_object('ok', true, 'persisted', false, 'code', 'conflict_preserved');
  END IF;

  UPDATE public.check_intake_items
     SET amount = p_amount,
         updated_at = now()
   WHERE id = p_check_id
     AND amount IS NULL
     AND deposited_at IS NULL
     AND COALESCE(check_stage, '') NOT IN ('deposited', 'voided', 'returned');

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'persisted', false, 'code', 'conflict_preserved');
  END IF;

  RETURN jsonb_build_object('ok', true, 'persisted', true, 'code', 'written');
END;
$$;

REVOKE ALL ON FUNCTION public.ocr_persist_extracted_amount(uuid, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ocr_persist_extracted_amount(uuid, numeric) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.ocr_persist_extracted_amount(uuid, numeric) TO checksops;
