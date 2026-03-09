-- Update ocr_commit_results to also auto-detect mortgage from claim's mortgage_company_id
-- and override status to loss_draft_required when mortgage is involved
CREATE OR REPLACE FUNCTION public.ocr_commit_results(
  p_check_id uuid, p_carrier_name text, p_check_number text, p_amount numeric,
  p_issue_date text, p_claim_number text, p_payee_line text, p_is_multi_payee boolean,
  p_raw_ocr jsonb, p_ocr_status text, p_check_status text, p_payees jsonb,
  p_recommendation text, p_reasons jsonb, p_rules jsonb, p_evaluated_by uuid,
  p_claim_id uuid DEFAULT NULL, p_has_active_endorsements boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payment_id uuid;
  v_payee record;
  v_existing_payment_id uuid;
  v_accounting_id uuid;
  v_has_mortgage boolean;
  v_payee_names text[];
  v_claim_has_mortgage boolean;
  v_final_status text;
  v_final_recommendation text;
  v_final_reasons jsonb;
BEGIN
  -- Step 1: Determine if claim has a mortgage company linked
  v_claim_has_mortgage := false;
  IF p_claim_id IS NOT NULL THEN
    SELECT mortgage_company_id IS NOT NULL INTO v_claim_has_mortgage
    FROM claims WHERE id = p_claim_id;
  END IF;

  -- Compute final status: if mortgage detected (by OCR or claim), override to loss_draft_required
  v_final_status := p_check_status;
  v_final_recommendation := p_recommendation;
  v_final_reasons := p_reasons;

  IF v_claim_has_mortgage AND v_final_status NOT IN ('needs_review') AND v_final_recommendation != 'loss_draft_required' THEN
    v_final_status := 'loss_draft_required';
    v_final_recommendation := 'loss_draft_required';
    v_final_reasons := v_final_reasons || '["Claim has mortgage company linked — auto-routed to Loss Draft"]'::jsonb;
  END IF;

  -- Step 1: Update check record AND clear heartbeat transactionally
  UPDATE check_intake_items SET
    carrier_name = p_carrier_name,
    check_number = p_check_number,
    amount = p_amount,
    issue_date = p_issue_date::date,
    detected_claim_number = p_claim_number,
    payee_line = p_payee_line,
    is_multi_payee = p_is_multi_payee,
    raw_ocr_front = p_raw_ocr,
    ocr_status = p_ocr_status,
    ocr_heartbeat_at = NULL,
    status = v_final_status,
    deposit_recommendation = v_final_recommendation,
    deposit_recommendation_reasons = v_final_reasons,
    updated_at = now()
  WHERE id = p_check_id;

  -- Step 2: Handle payees
  v_has_mortgage := false;
  v_payee_names := ARRAY[]::text[];

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
      v_payee_names := array_append(v_payee_names, v_payee.value->>'name');
      IF COALESCE(v_payee.value->>'type', 'unknown') = 'mortgage_company' THEN
        v_has_mortgage := true;
      END IF;
    END LOOP;
  ELSE
    SELECT EXISTS(
      SELECT 1 FROM check_payees WHERE check_id = p_check_id AND payee_type = 'mortgage_company'
    ) INTO v_has_mortgage;
    SELECT array_agg(payee_name) INTO v_payee_names FROM check_payees WHERE check_id = p_check_id;
  END IF;

  -- Also set mortgage flag from claim if not already detected
  v_has_mortgage := v_has_mortgage OR v_claim_has_mortgage;

  -- Step 3: Upsert eligibility
  DELETE FROM check_eligibility_results WHERE check_id = p_check_id;
  INSERT INTO check_eligibility_results (check_id, recommendation, reasons, rule_results, evaluated_by)
  VALUES (p_check_id, v_final_recommendation, v_final_reasons, p_rules, p_evaluated_by);

  -- Step 4: Upsert claim payment linked by check_intake_item_id
  IF p_claim_id IS NOT NULL AND p_amount IS NOT NULL AND p_amount > 0 THEN
    SELECT id INTO v_existing_payment_id
    FROM claim_payments
    WHERE check_intake_item_id = p_check_id
    LIMIT 1;

    IF v_existing_payment_id IS NOT NULL THEN
      UPDATE claim_payments SET
        amount = p_amount,
        payment_type = 'insurance_check',
        description = format('Check #%s from %s', COALESCE(p_check_number, '?'), COALESCE(p_carrier_name, 'Unknown')),
        updated_at = now()
      WHERE id = v_existing_payment_id;
      v_payment_id := v_existing_payment_id;
    ELSE
      INSERT INTO claim_payments (
        claim_id, amount, payment_type, description,
        direction, status, received_date, check_intake_item_id
      ) VALUES (
        p_claim_id, p_amount, 'insurance_check',
        format('Check #%s from %s', COALESCE(p_check_number, '?'), COALESCE(p_carrier_name, 'Unknown')),
        'inbound', 'pending', CURRENT_DATE, p_check_id
      ) RETURNING id INTO v_payment_id;
    END IF;
  END IF;

  -- Step 5: Auto-upsert into claim_checks for accounting
  IF p_claim_id IS NOT NULL AND p_amount IS NOT NULL THEN
    INSERT INTO claim_checks (
      claim_id, check_number, amount, carrier, date_received,
      deposit_status, eligibility_status, mortgage_flag, source,
      check_intake_item_id, payee_names
    ) VALUES (
      p_claim_id,
      COALESCE(p_check_number, 'OCR-' || p_check_id::text),
      p_amount,
      p_carrier_name,
      COALESCE(p_issue_date::date, CURRENT_DATE),
      'pending',
      v_final_recommendation,
      v_has_mortgage,
      'uploaded_check_ocr',
      p_check_id,
      v_payee_names
    )
    ON CONFLICT (check_intake_item_id)
    DO UPDATE SET
      check_number = EXCLUDED.check_number,
      amount = EXCLUDED.amount,
      carrier = EXCLUDED.carrier,
      date_received = EXCLUDED.date_received,
      eligibility_status = EXCLUDED.eligibility_status,
      mortgage_flag = EXCLUDED.mortgage_flag,
      payee_names = EXCLUDED.payee_names,
      updated_at = now();
  END IF;

  -- Step 6: Audit
  INSERT INTO check_audit_log (check_id, event_type, event_description, event_data, actor_id)
  VALUES (
    p_check_id, 'ocr_committed',
    format('OCR committed: status=%s rec=%s payees=%s mortgage=%s',
      v_final_status, v_final_recommendation, array_length(v_payee_names, 1), v_has_mortgage),
    jsonb_build_object(
      'status', v_final_status, 'recommendation', v_final_recommendation,
      'amount', p_amount, 'carrier', p_carrier_name,
      'payee_count', jsonb_array_length(p_payees),
      'has_mortgage', v_has_mortgage, 'claim_has_mortgage', v_claim_has_mortgage,
      'payment_id', v_payment_id
    ), p_evaluated_by
  );

  RETURN jsonb_build_object(
    'success', true,
    'check_id', p_check_id,
    'status', v_final_status,
    'recommendation', v_final_recommendation,
    'has_mortgage', v_has_mortgage,
    'claim_has_mortgage', v_claim_has_mortgage,
    'payment_id', v_payment_id
  );
END;
$function$;