
-- 1. Add check_intake_item_id FK to claim_payments for direct linkage
ALTER TABLE public.claim_payments
  ADD COLUMN IF NOT EXISTS check_intake_item_id uuid REFERENCES public.check_intake_items(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_payments_check_intake
  ON public.claim_payments(check_intake_item_id)
  WHERE check_intake_item_id IS NOT NULL;

-- 2. Drop old check-number-based dedup index
DROP INDEX IF EXISTS idx_claim_payments_check_dedup;

-- 3. Fix deposit_recommendation constraint: endorsements_complete is a STATUS, not a recommendation
ALTER TABLE public.check_intake_items DROP CONSTRAINT IF EXISTS check_intake_items_deposit_recommendation_check;
ALTER TABLE public.check_intake_items ADD CONSTRAINT check_intake_items_deposit_recommendation_check
  CHECK (deposit_recommendation IN ('ready_for_deposit','endorsements_pending','manual_review_required','branch_deposit_recommended','request_reissue'));

-- 4. Fix status constraint to include all valid statuses
ALTER TABLE public.check_intake_items DROP CONSTRAINT IF EXISTS check_intake_items_status_check;
ALTER TABLE public.check_intake_items ADD CONSTRAINT check_intake_items_status_check
  CHECK (status IN ('uploaded','processing','ocr_complete','endorsements_in_progress','endorsements_complete','manual_review_required','ready','needs_review','deposited','voided'));

-- 5. Add notification_delivery_status to check_payees
ALTER TABLE public.check_payees
  ADD COLUMN IF NOT EXISTS notification_delivery_status text DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS notification_error text;

-- 6. Transactional RPC for OCR write sequence
CREATE OR REPLACE FUNCTION public.ocr_commit_results(
  p_check_id uuid,
  p_carrier_name text,
  p_check_number text,
  p_amount numeric,
  p_issue_date text,
  p_claim_number text,
  p_payee_line text,
  p_is_multi_payee boolean,
  p_raw_ocr jsonb,
  p_ocr_status text,
  p_check_status text,
  p_payees jsonb,
  p_recommendation text,
  p_reasons jsonb,
  p_rules jsonb,
  p_evaluated_by uuid,
  p_claim_id uuid DEFAULT NULL,
  p_has_active_endorsements boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_payment_id uuid;
  v_payee record;
  v_existing_payment_id uuid;
BEGIN
  -- Step 1: Update check record
  UPDATE check_intake_items SET
    carrier_name = p_carrier_name,
    check_number = p_check_number,
    amount = p_amount,
    issue_date = p_issue_date,
    detected_claim_number = p_claim_number,
    payee_line = p_payee_line,
    is_multi_payee = p_is_multi_payee,
    raw_ocr_front = p_raw_ocr,
    ocr_status = p_ocr_status,
    status = p_check_status,
    deposit_recommendation = p_recommendation,
    deposit_recommendation_reasons = p_reasons,
    updated_at = now()
  WHERE id = p_check_id;

  -- Step 2: Handle payees — only replace if no active endorsement workflow
  IF NOT p_has_active_endorsements THEN
    DELETE FROM check_payees WHERE check_id = p_check_id;
    
    FOR v_payee IN SELECT * FROM jsonb_array_elements(p_payees)
    LOOP
      INSERT INTO check_payees (check_id, payee_name, payee_type, endorsement_token, endorsement_token_expires_at)
      VALUES (
        p_check_id,
        v_payee.value->>'name',
        COALESCE(v_payee.value->>'type', 'unknown'),
        gen_random_uuid()::text,
        now() + interval '30 days'
      );
    END LOOP;
  END IF;

  -- Step 3: Upsert eligibility
  DELETE FROM check_eligibility_results WHERE check_id = p_check_id;
  INSERT INTO check_eligibility_results (check_id, recommendation, reasons, rule_results, evaluated_by)
  VALUES (p_check_id, p_recommendation, p_reasons, p_rules, p_evaluated_by);

  -- Step 4: Upsert claim payment linked by check_intake_item_id
  IF p_claim_id IS NOT NULL AND p_amount IS NOT NULL AND p_amount > 0 THEN
    SELECT id INTO v_existing_payment_id
    FROM claim_payments
    WHERE check_intake_item_id = p_check_id
    LIMIT 1;

    IF v_existing_payment_id IS NOT NULL THEN
      UPDATE claim_payments SET
        amount = p_amount,
        check_number = p_check_number,
        notes = 'Insurance check from ' || COALESCE(p_carrier_name, 'Unknown carrier'),
        updated_at = now()
      WHERE id = v_existing_payment_id;
      v_payment_id := v_existing_payment_id;
    ELSE
      INSERT INTO claim_payments (
        claim_id, amount, payment_method, check_number, notes, payment_date,
        recipient_type, direction, check_intake_item_id
      ) VALUES (
        p_claim_id, p_amount, 'insurance_check', p_check_number,
        'Insurance check from ' || COALESCE(p_carrier_name, 'Unknown carrier'),
        COALESCE(p_issue_date, to_char(now(), 'YYYY-MM-DD')),
        'insured', 'inbound', p_check_id
      )
      RETURNING id INTO v_payment_id;
    END IF;
  END IF;

  -- Step 5: Audit entries
  INSERT INTO check_audit_log (check_id, event_type, event_description, event_data, actor_id)
  VALUES
    (p_check_id, 'ocr_completed',
     format('OCR extracted %s payee(s), amount: $%s', jsonb_array_length(p_payees), p_amount),
     p_raw_ocr, p_evaluated_by),
    (p_check_id, 'eligibility_evaluated',
     format('Recommendation: %s', p_recommendation),
     jsonb_build_object('recommendation', p_recommendation, 'reasons', p_reasons), p_evaluated_by);

  IF v_payment_id IS NOT NULL THEN
    INSERT INTO check_audit_log (check_id, event_type, event_description, event_data, actor_id)
    VALUES (p_check_id, 'claim_wallet_entry',
      format('Payment of $%s linked to claim', p_amount),
      jsonb_build_object('claim_id', p_claim_id, 'payment_id', v_payment_id), p_evaluated_by);
  END IF;

  RETURN jsonb_build_object('success', true, 'payment_id', v_payment_id);
END;
$$;
