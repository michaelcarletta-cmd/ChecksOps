-- Phase 2: Strip guards, wire stage writes, add lifecycle automations

-- ===== submit_check_review_decision: drop guard, write check_stage =====
CREATE OR REPLACE FUNCTION public.submit_check_review_decision(
  p_check_id uuid, p_reviewer_id uuid, p_deposit_path text,
  p_reviewer_notes text DEFAULT NULL, p_confirmed_carrier_name text DEFAULT NULL,
  p_confirmed_check_number text DEFAULT NULL, p_confirmed_amount numeric DEFAULT NULL,
  p_confirmed_payee_line text DEFAULT NULL, p_field_changes jsonb DEFAULT '[]'::jsonb,
  p_reissue_reason text DEFAULT NULL, p_reissue_reason_category text DEFAULT 'other',
  p_merge_payees jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_old record;
  v_decision_id uuid;
  v_new_status text;
  v_new_stage public.check_stage;
  v_is_merge_only boolean;
BEGIN
  IF NOT public.has_role(p_reviewer_id, 'staff') AND NOT public.has_role(p_reviewer_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized to submit review decisions';
  END IF;
  SELECT * INTO v_old FROM check_intake_items WHERE id = p_check_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Check not found'; END IF;

  v_is_merge_only := (p_deposit_path = 'merge_only');
  IF NOT v_is_merge_only THEN
    v_new_status := CASE
      WHEN p_deposit_path = 'reissue_requested' THEN 'reissue_requested'
      WHEN p_deposit_path = 'hold_for_claim_review' THEN 'needs_review'
      WHEN p_deposit_path = 'loss_draft_required' THEN 'loss_draft_required'
      WHEN p_deposit_path = 'revert_to_review' THEN 'needs_review'
      ELSE p_deposit_path
    END;

    -- Map deposit path → new stage. NO transition guards. Warn-not-block.
    v_new_stage := CASE
      WHEN p_deposit_path = 'loss_draft_required' THEN 'loss_draft'
      WHEN p_deposit_path = 'endorsements_in_progress' THEN 'endorsing'
      WHEN p_deposit_path IN ('approved_for_deposit','branch_deposit_required') THEN 'ready_for_deposit'
      WHEN p_deposit_path IN ('hold_for_claim_review','revert_to_review','reissue_requested') THEN 'review'
      ELSE 'review'
    END::public.check_stage;

    UPDATE check_intake_items SET
      status = v_new_status,
      check_stage = v_new_stage,
      ocr_needs_verification = false,  -- review decision = human verified
      deposit_recommendation = CASE
        WHEN p_deposit_path = 'approved_for_deposit' THEN 'ready_for_deposit'
        WHEN p_deposit_path = 'branch_deposit_required' THEN 'branch_deposit_recommended'
        WHEN p_deposit_path = 'loss_draft_required' THEN 'branch_deposit_recommended'
        WHEN p_deposit_path = 'reissue_requested' THEN 'request_reissue'
        WHEN p_deposit_path = 'revert_to_review' THEN v_old.deposit_recommendation
        WHEN p_deposit_path = 'hold_for_claim_review' THEN v_old.deposit_recommendation
        ELSE p_deposit_path
      END,
      carrier_name = COALESCE(p_confirmed_carrier_name, v_old.carrier_name),
      check_number = COALESCE(p_confirmed_check_number, v_old.check_number),
      amount = COALESCE(p_confirmed_amount, v_old.amount),
      payee_line = COALESCE(p_confirmed_payee_line, v_old.payee_line),
      reviewed_by = p_reviewer_id,
      reviewed_at = now(),
      review_notes = p_reviewer_notes,
      updated_at = now()
    WHERE id = p_check_id;

    -- Mirror stage to claim_checks
    UPDATE claim_checks SET check_stage = v_new_stage, updated_at = now()
    WHERE check_intake_item_id = p_check_id;

    INSERT INTO check_review_decisions (
      check_id, reviewer_id, decision, deposit_path,
      confirmed_carrier_name, confirmed_check_number,
      confirmed_amount, confirmed_payee_line, reviewer_notes
    ) VALUES (
      p_check_id, p_reviewer_id, p_deposit_path, p_deposit_path,
      p_confirmed_carrier_name, p_confirmed_check_number,
      p_confirmed_amount, p_confirmed_payee_line, p_reviewer_notes
    ) RETURNING id INTO v_decision_id;

    -- Field change audit
    FOR v_old IN SELECT * FROM jsonb_array_elements(p_field_changes) LOOP
      INSERT INTO check_audit_log (check_id, event_type, event_description, event_data, actor_id)
      VALUES (p_check_id, 'field_corrected',
        format('Field corrected during review: %s', v_old.value->>'field'),
        v_old.value, p_reviewer_id);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('decision_id', v_decision_id, 'new_stage', v_new_stage);
END;
$$;

-- ===== ocr_commit_results: write check_stage on OCR completion =====
CREATE OR REPLACE FUNCTION public.ocr_commit_results(
  p_check_id uuid, p_carrier_name text, p_check_number text, p_amount numeric,
  p_issue_date text, p_claim_number text, p_payee_line text, p_is_multi_payee boolean,
  p_raw_ocr jsonb, p_ocr_status text, p_check_status text, p_payees jsonb,
  p_recommendation text, p_reasons jsonb, p_rules jsonb, p_evaluated_by uuid,
  p_claim_id uuid, p_has_active_endorsements boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_payee record;
  v_existing_payment_id uuid;
  v_has_mortgage boolean := false;
  v_payee_names text[] := ARRAY[]::text[];
  v_claim_has_mortgage boolean := false;
  v_final_status text;
  v_needs_verification boolean;
BEGIN
  IF p_claim_id IS NOT NULL THEN
    SELECT mortgage_company_id IS NOT NULL INTO v_claim_has_mortgage FROM claims WHERE id = p_claim_id;
  END IF;

  -- Always land in review. Do not auto-route. Stage is the new source of truth.
  v_final_status := COALESCE(p_check_status, 'needs_review');
  v_needs_verification := (
    p_ocr_status IN ('failed','low_confidence','manual_required')
    OR (p_raw_ocr->>'needs_manual_review')::boolean = true
    OR p_amount IS NULL
  );

  UPDATE check_intake_items SET
    carrier_name = p_carrier_name, check_number = p_check_number,
    amount = p_amount,
    issue_date = CASE WHEN p_issue_date IS NULL OR p_issue_date='' THEN NULL ELSE p_issue_date::date END,
    detected_claim_number = p_claim_number, payee_line = p_payee_line,
    is_multi_payee = p_is_multi_payee, raw_ocr_front = p_raw_ocr,
    ocr_status = p_ocr_status, ocr_heartbeat_at = NULL,
    status = v_final_status,
    check_stage = 'review',
    ocr_needs_verification = v_needs_verification,
    deposit_recommendation = p_recommendation,
    deposit_recommendation_reasons = p_reasons,
    updated_at = now()
  WHERE id = p_check_id;

  IF NOT p_has_active_endorsements THEN
    DELETE FROM check_payees WHERE check_id = p_check_id;
    FOR v_payee IN SELECT * FROM jsonb_array_elements(p_payees) LOOP
      INSERT INTO check_payees (check_id, payee_name, payee_type, endorsement_token, endorsement_token_expires_at)
      VALUES (p_check_id, v_payee.value->>'name',
        COALESCE(v_payee.value->>'type','unknown'),
        gen_random_uuid()::text, now() + interval '30 days');
      v_payee_names := array_append(v_payee_names, v_payee.value->>'name');
      IF COALESCE(v_payee.value->>'type','unknown')='mortgage_company' THEN v_has_mortgage := true; END IF;
    END LOOP;
  ELSE
    SELECT EXISTS(SELECT 1 FROM check_payees WHERE check_id=p_check_id AND payee_type='mortgage_company') INTO v_has_mortgage;
    SELECT array_agg(payee_name) INTO v_payee_names FROM check_payees WHERE check_id=p_check_id;
  END IF;

  DELETE FROM check_eligibility_results WHERE check_id = p_check_id;
  INSERT INTO check_eligibility_results (check_id, recommendation, reasons, rule_results, evaluated_by)
  VALUES (p_check_id, p_recommendation, p_reasons, p_rules, p_evaluated_by);

  IF p_claim_id IS NOT NULL AND p_amount IS NOT NULL AND p_amount > 0 THEN
    SELECT id INTO v_existing_payment_id FROM claim_payments WHERE check_intake_item_id=p_check_id LIMIT 1;
    IF v_existing_payment_id IS NOT NULL THEN
      UPDATE claim_payments SET amount=p_amount, payment_method='check',
        notes=format('Check #%s from %s', COALESCE(p_check_number,'?'), COALESCE(p_carrier_name,'Unknown')),
        updated_at=now() WHERE id=v_existing_payment_id;
    ELSE
      INSERT INTO claim_payments (claim_id, amount, payment_method, payment_date, recipient_type, direction, notes, check_number, check_intake_item_id)
      VALUES (p_claim_id, p_amount, 'check', CURRENT_DATE, 'company', 'inbound',
        format('Check #%s from %s', COALESCE(p_check_number,'?'), COALESCE(p_carrier_name,'Unknown')),
        p_check_number, p_check_id);
    END IF;
  END IF;

  -- Mirror to claim_checks
  UPDATE claim_checks SET check_stage='review', ocr_needs_verification=v_needs_verification, updated_at=now()
  WHERE check_intake_item_id=p_check_id;

  RETURN jsonb_build_object('status', v_final_status, 'stage', 'review', 'needs_verification', v_needs_verification);
END;
$$;

-- ===== Trigger: endorsement completion → ready_for_deposit =====
CREATE OR REPLACE FUNCTION public.advance_check_on_endorsement_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_remaining int;
  v_check_id uuid;
BEGIN
  v_check_id := COALESCE(NEW.check_id, OLD.check_id);
  IF v_check_id IS NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_remaining FROM check_endorsements
  WHERE check_id = v_check_id AND status NOT IN ('signed','waived','manual_required');

  IF v_remaining = 0 THEN
    UPDATE check_intake_items
      SET check_stage = 'ready_for_deposit', updated_at = now()
      WHERE id = v_check_id AND check_stage <> 'deposited';
    UPDATE claim_checks
      SET check_stage = 'ready_for_deposit', updated_at = now()
      WHERE check_intake_item_id = v_check_id AND check_stage <> 'deposited';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_advance_on_endorsement_complete ON public.check_endorsements;
CREATE TRIGGER trg_advance_on_endorsement_complete
AFTER INSERT OR UPDATE OF status ON public.check_endorsements
FOR EACH ROW EXECUTE FUNCTION public.advance_check_on_endorsement_complete();

-- ===== Trigger: loss-draft (mortgage) released → back to review =====
CREATE OR REPLACE FUNCTION public.return_check_to_review_on_mortgage_release()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.mortgage_final_released_at IS NOT NULL
     AND (OLD.mortgage_final_released_at IS NULL OR OLD.mortgage_final_released_at IS DISTINCT FROM NEW.mortgage_final_released_at)
     AND NEW.check_stage NOT IN ('deposited','ready_for_deposit') THEN
    NEW.check_stage := 'review';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_return_to_review_on_release ON public.check_intake_items;
CREATE TRIGGER trg_return_to_review_on_release
BEFORE UPDATE OF mortgage_final_released_at ON public.check_intake_items
FOR EACH ROW EXECUTE FUNCTION public.return_check_to_review_on_mortgage_release();

-- ===== Trigger: deposited locks the stage =====
CREATE OR REPLACE FUNCTION public.lock_stage_on_deposit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.deposit_status IN ('deposited','cleared') AND
     (OLD.deposit_status IS NULL OR OLD.deposit_status NOT IN ('deposited','cleared')) THEN
    NEW.check_stage := 'deposited';
    -- Mirror back to intake
    UPDATE check_intake_items SET check_stage = 'deposited', updated_at = now()
    WHERE id = NEW.check_intake_item_id AND check_stage <> 'deposited';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_stage_on_deposit ON public.claim_checks;
CREATE TRIGGER trg_lock_stage_on_deposit
BEFORE UPDATE OF deposit_status ON public.claim_checks
FOR EACH ROW EXECUTE FUNCTION public.lock_stage_on_deposit();