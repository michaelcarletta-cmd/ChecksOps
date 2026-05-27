CREATE OR REPLACE FUNCTION public.submit_check_review_decision(p_check_id uuid, p_reviewer_id uuid, p_deposit_path text, p_reviewer_notes text DEFAULT NULL::text, p_confirmed_carrier_name text DEFAULT NULL::text, p_confirmed_check_number text DEFAULT NULL::text, p_confirmed_amount numeric DEFAULT NULL::numeric, p_confirmed_payee_line text DEFAULT NULL::text, p_field_changes jsonb DEFAULT '[]'::jsonb, p_reissue_reason text DEFAULT NULL::text, p_reissue_reason_category text DEFAULT 'other'::text, p_merge_payees jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old record;
  v_decision_id uuid;
  v_new_status text;
  v_new_stage public.check_stage;
  v_new_recommendation text;
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
      WHEN p_deposit_path = 'endorsements_in_progress' THEN 'endorsements_in_progress'
      WHEN p_deposit_path = 'approved_for_deposit' THEN 'approved_for_deposit'
      WHEN p_deposit_path = 'branch_deposit_required' THEN 'branch_deposit_required'
      ELSE v_old.status
    END;

    v_new_stage := CASE
      WHEN p_deposit_path = 'loss_draft_required' THEN 'loss_draft'
      WHEN p_deposit_path = 'endorsements_in_progress' THEN 'endorsing'
      WHEN p_deposit_path IN ('approved_for_deposit','branch_deposit_required') THEN 'ready_for_deposit'
      WHEN p_deposit_path IN ('hold_for_claim_review','revert_to_review','reissue_requested') THEN 'review'
      ELSE 'review'
    END::public.check_stage;

    v_new_recommendation := CASE
      WHEN p_deposit_path = 'approved_for_deposit' THEN 'ready_for_deposit'
      WHEN p_deposit_path = 'branch_deposit_required' THEN 'branch_deposit_recommended'
      WHEN p_deposit_path = 'loss_draft_required' THEN 'loss_draft_required'
      WHEN p_deposit_path = 'reissue_requested' THEN 'request_reissue'
      WHEN p_deposit_path = 'endorsements_in_progress' THEN 'endorsements_pending'
      ELSE v_old.deposit_recommendation
    END;

    UPDATE check_intake_items SET
      status = v_new_status,
      check_stage = v_new_stage,
      ocr_needs_verification = false,
      deposit_recommendation = v_new_recommendation,
      carrier_name = COALESCE(p_confirmed_carrier_name, v_old.carrier_name),
      check_number = COALESCE(p_confirmed_check_number, v_old.check_number),
      amount = COALESCE(p_confirmed_amount, v_old.amount),
      payee_line = COALESCE(p_confirmed_payee_line, v_old.payee_line),
      reviewed_by = p_reviewer_id,
      reviewed_at = now(),
      review_notes = p_reviewer_notes,
      updated_at = now()
    WHERE id = p_check_id;

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

    FOR v_old IN SELECT * FROM jsonb_array_elements(p_field_changes) LOOP
      INSERT INTO check_audit_log (check_id, event_type, event_description, event_data, actor_id)
      VALUES (p_check_id, 'field_corrected',
        format('Field corrected during review: %s', v_old.value->>'field'),
        v_old.value, p_reviewer_id);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('decision_id', v_decision_id, 'new_stage', v_new_stage);
END;
$function$;