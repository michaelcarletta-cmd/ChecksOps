-- UNAPPLIED. Repo artifact only. Do not apply from this PR.
--
-- Supersede 20260918170100 after a normal migrate-all.
-- 170100 still mirrors claim_checks / claim_payments (other product consumers).
-- It must not create homeowner_ledger_events.check_received.
--
-- Authoritative check_received writer remains:
-- hle_on_check_intake_insert / trg_hle_check_intake_insert (170040).

CREATE OR REPLACE FUNCTION public.sync_check_claim_ledger(p_check_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_check public.check_intake_items%ROWTYPE;
  v_claim_check_id uuid;
  v_payment_id uuid;
  v_payment_date date;
BEGIN
  SELECT * INTO v_check
  FROM public.check_intake_items
  WHERE id = p_check_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Check not found';
  END IF;

  IF v_check.claim_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'skipped', true, 'reason', 'unlinked');
  END IF;

  v_payment_date := COALESCE(v_check.issue_date, CURRENT_DATE);

  INSERT INTO public.claim_checks (
    claim_id,
    check_intake_item_id,
    check_number,
    amount,
    carrier_name,
    check_date,
    payee_line,
    source,
    check_type
  ) VALUES (
    v_check.claim_id,
    v_check.id,
    COALESCE(v_check.check_number, 'OCR-' || v_check.id::text),
    v_check.amount,
    v_check.carrier_name,
    v_payment_date,
    v_check.payee_line,
    'uploaded_check_ocr',
    'insurance_check'
  )
  ON CONFLICT (check_intake_item_id)
  DO UPDATE SET
    claim_id = EXCLUDED.claim_id,
    check_number = EXCLUDED.check_number,
    amount = EXCLUDED.amount,
    carrier_name = EXCLUDED.carrier_name,
    check_date = EXCLUDED.check_date,
    payee_line = EXCLUDED.payee_line,
    updated_at = now()
  RETURNING id INTO v_claim_check_id;

  IF v_check.amount IS NOT NULL THEN
    INSERT INTO public.claim_payments (
      claim_id, check_intake_item_id, amount, payment_method, payment_date,
      recipient_type, direction, check_number, notes
    ) VALUES (
      v_check.claim_id,
      v_check.id,
      v_check.amount,
      'insurance_check',
      v_payment_date,
      'insured',
      'inbound',
      v_check.check_number,
      'Insurance check from ' || COALESCE(v_check.carrier_name, 'Unknown carrier')
    )
    ON CONFLICT (check_intake_item_id) WHERE check_intake_item_id IS NOT NULL
    DO UPDATE SET
      claim_id = EXCLUDED.claim_id,
      amount = EXCLUDED.amount,
      check_number = EXCLUDED.check_number,
      notes = EXCLUDED.notes,
      updated_at = now()
    RETURNING id INTO v_payment_id;
  END IF;

  -- Relink may move existing non-receipt events. Do not INSERT check_received.
  UPDATE public.homeowner_ledger_events
  SET claim_id = v_check.claim_id
  WHERE check_id = v_check.id
    AND event_type IS DISTINCT FROM 'check_received'
    AND (v_check.tenant_id IS NULL OR tenant_id IS NOT DISTINCT FROM v_check.tenant_id)
    AND claim_id IS DISTINCT FROM v_check.claim_id;

  RETURN jsonb_build_object(
    'success', true,
    'claim_id', v_check.claim_id,
    'claim_check_id', v_claim_check_id,
    'payment_id', v_payment_id,
    'inserted_check_received', false
  );
END;
$$;
