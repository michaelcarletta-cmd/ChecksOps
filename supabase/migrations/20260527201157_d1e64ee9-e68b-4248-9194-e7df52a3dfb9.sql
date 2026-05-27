CREATE OR REPLACE FUNCTION public.submit_check_review_decision(
  p_check_id uuid,
  p_reviewer_id uuid,
  p_deposit_path text,
  p_reviewer_notes text DEFAULT NULL,
  p_confirmed_carrier_name text DEFAULT NULL,
  p_confirmed_check_number text DEFAULT NULL,
  p_confirmed_amount numeric DEFAULT NULL,
  p_confirmed_payee_line text DEFAULT NULL,
  p_field_changes jsonb DEFAULT '[]'::jsonb,
  p_reissue_reason text DEFAULT NULL,
  p_reissue_reason_category text DEFAULT 'other',
  p_merge_payees jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_old record;
  v_decision_id uuid;
  v_change record;
  v_merge record;
  v_target_id uuid;
  v_new_status text;
  v_new_stage public.check_stage;
  v_new_recommendation text;
  v_is_merge_only boolean;
  v_allowed_from text[];
  v_final_amount numeric;
  v_final_carrier text;
  v_final_check_number text;
  v_final_payee_line text;
  v_has_mortgage boolean;
BEGIN
  IF NOT public.has_role(p_reviewer_id, 'staff') AND NOT public.has_role(p_reviewer_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized to submit review decisions';
  END IF;

  SELECT * INTO v_old
  FROM public.check_intake_items
  WHERE id = p_check_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Check not found';
  END IF;

  v_is_merge_only := (p_deposit_path = 'merge_only');

  IF NOT v_is_merge_only THEN
    v_new_status := CASE
      WHEN p_deposit_path = 'endorsements_in_progress' THEN 'endorsements_in_progress'
      WHEN p_deposit_path = 'approved_for_deposit' THEN 'approved_for_deposit'
      WHEN p_deposit_path = 'branch_deposit_required' THEN 'branch_deposit_required'
      WHEN p_deposit_path = 'loss_draft_required' THEN 'loss_draft_required'
      WHEN p_deposit_path = 'reissue_requested' THEN 'reissue_requested'
      WHEN p_deposit_path IN ('hold_for_claim_review', 'revert_to_review') THEN 'needs_review'
      ELSE v_old.status
    END;

    v_new_stage := CASE
      WHEN p_deposit_path = 'loss_draft_required' THEN 'loss_draft'
      WHEN p_deposit_path = 'endorsements_in_progress' THEN 'endorsing'
      WHEN p_deposit_path IN ('approved_for_deposit', 'branch_deposit_required') THEN 'ready_for_deposit'
      WHEN p_deposit_path IN ('hold_for_claim_review', 'revert_to_review', 'reissue_requested') THEN 'review'
      ELSE COALESCE(v_old.check_stage, 'review'::public.check_stage)
    END;

    v_new_recommendation := CASE
      WHEN p_deposit_path = 'approved_for_deposit' THEN 'ready_for_deposit'
      WHEN p_deposit_path = 'branch_deposit_required' THEN 'branch_deposit_recommended'
      WHEN p_deposit_path = 'loss_draft_required' THEN 'loss_draft_required'
      WHEN p_deposit_path = 'reissue_requested' THEN 'request_reissue'
      WHEN p_deposit_path = 'endorsements_in_progress' THEN 'endorsements_pending'
      WHEN p_deposit_path IN ('hold_for_claim_review', 'revert_to_review') THEN v_old.deposit_recommendation
      ELSE v_old.deposit_recommendation
    END;

    -- Loss Draft is reachable from ANY status (warn-not-block lifecycle).
    -- Mortgage-payee requirement is enforced in the UI before this RPC is called.
    v_allowed_from := CASE v_new_status
      WHEN 'endorsements_in_progress' THEN ARRAY['uploaded','ocr_complete','needs_review','manual_review_required','endorsements_complete']
      WHEN 'approved_for_deposit' THEN ARRAY['needs_review','manual_review_required','endorsements_complete','branch_deposit_required','loss_draft_required']
      WHEN 'branch_deposit_required' THEN ARRAY['needs_review','manual_review_required','endorsements_complete','ocr_complete','endorsements_in_progress']
      WHEN 'loss_draft_required' THEN NULL
      WHEN 'reissue_requested' THEN ARRAY['uploaded','ocr_complete','needs_review','manual_review_required','endorsements_complete','branch_deposit_required','approved_for_deposit','loss_draft_required','endorsements_in_progress']
      WHEN 'needs_review' THEN ARRAY['uploaded','ocr_complete','needs_review','manual_review_required','endorsements_complete','branch_deposit_required','approved_for_deposit','loss_draft_required','reissue_requested','endorsements_in_progress']
      ELSE ARRAY[]::text[]
    END;

    IF v_old.status IS NOT NULL AND v_allowed_from IS NOT NULL AND array_length(v_allowed_from, 1) IS NOT NULL AND NOT (v_old.status = ANY(v_allowed_from)) THEN
      RAISE EXCEPTION 'Invalid status transition: % → %', v_old.status, v_new_status;
    END IF;

    UPDATE public.check_intake_items
    SET status = v_new_status,
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

    UPDATE public.claim_checks
    SET check_stage = v_new_stage,
        updated_at = now()
    WHERE check_intake_item_id = p_check_id;

    INSERT INTO public.check_review_decisions (
      check_id,
      reviewer_id,
      decision,
      deposit_path,
      confirmed_carrier_name,
      confirmed_check_number,
      confirmed_amount,
      confirmed_payee_line,
      reviewer_notes
    ) VALUES (
      p_check_id,
      p_reviewer_id,
      p_deposit_path,
      p_deposit_path,
      p_confirmed_carrier_name,
      p_confirmed_check_number,
      p_confirmed_amount,
      p_confirmed_payee_line,
      p_reviewer_notes
    )
    RETURNING id INTO v_decision_id;

    FOR v_change IN SELECT * FROM jsonb_array_elements(COALESCE(p_field_changes, '[]'::jsonb))
    LOOP
      INSERT INTO public.check_audit_log (
        check_id,
        event_type,
        event_description,
        event_data,
        actor_id
      ) VALUES (
        p_check_id,
        'manual_field_edit',
        format(
          'Reviewer changed %s: "%s" → "%s"',
          v_change.value->>'field',
          COALESCE(v_change.value->>'old_value', ''),
          COALESCE(v_change.value->>'new_value', '')
        ),
        v_change.value,
        p_reviewer_id
      );
    END LOOP;

    INSERT INTO public.check_audit_log (
      check_id,
      event_type,
      event_description,
      event_data,
      actor_id
    ) VALUES (
      p_check_id,
      CASE WHEN p_deposit_path = 'revert_to_review' THEN 'decision_reverted' ELSE 'review_decision' END,
      format('Reviewer set deposit path: %s (from %s)', p_deposit_path, COALESCE(v_old.status, 'unknown')),
      jsonb_build_object(
        'deposit_path', p_deposit_path,
        'decision_id', v_decision_id,
        'fields_edited', jsonb_array_length(COALESCE(p_field_changes, '[]'::jsonb)),
        'notes', p_reviewer_notes,
        'previous_status', v_old.status
      ),
      p_reviewer_id
    );

    IF p_deposit_path = 'reissue_requested' THEN
      INSERT INTO public.check_reissue_requests (
        check_id,
        requested_by,
        reason,
        reason_category
      ) VALUES (
        p_check_id,
        p_reviewer_id,
        COALESCE(p_reissue_reason, p_reviewer_notes, 'Check not practically depositable'),
        p_reissue_reason_category
      );

      INSERT INTO public.check_audit_log (
        check_id,
        event_type,
        event_description,
        event_data,
        actor_id
      ) VALUES (
        p_check_id,
        'reissue_requested',
        format('Reissue requested: %s', p_reissue_reason_category),
        jsonb_build_object('reason', p_reissue_reason, 'category', p_reissue_reason_category),
        p_reviewer_id
      );
    END IF;

    v_final_amount := COALESCE(p_confirmed_amount, v_old.amount);
    v_final_carrier := COALESCE(p_confirmed_carrier_name, v_old.carrier_name);
    v_final_check_number := COALESCE(p_confirmed_check_number, v_old.check_number);
    v_final_payee_line := COALESCE(p_confirmed_payee_line, v_old.payee_line);

    IF v_old.claim_id IS NOT NULL AND v_final_amount IS NOT NULL THEN
      BEGIN
        SELECT EXISTS (
          SELECT 1
          FROM public.check_payees
          WHERE check_id = p_check_id AND payee_type = 'mortgage_company'
        ) INTO v_has_mortgage;

        INSERT INTO public.claim_checks (
          claim_id,
          check_number,
          amount,
          carrier_name,
          check_date,
          check_type,
          deposit_status,
          eligibility_status,
          mortgage_flag,
          source,
          check_intake_item_id,
          payee_line
        ) VALUES (
          v_old.claim_id,
          COALESCE(v_final_check_number, 'OCR-' || p_check_id::text),
          v_final_amount,
          v_final_carrier,
          COALESCE(v_old.issue_date::date, CURRENT_DATE),
          'insurance_check',
          CASE
            WHEN p_deposit_path = 'approved_for_deposit' THEN 'approved'
            WHEN p_deposit_path IN ('branch_deposit_required', 'loss_draft_required') THEN 'pending'
            ELSE 'pending'
          END,
          v_new_status,
          COALESCE(v_has_mortgage, false),
          'uploaded_check_ocr',
          p_check_id,
          v_final_payee_line
        )
        ON CONFLICT (check_intake_item_id)
        DO UPDATE SET
          check_number = EXCLUDED.check_number,
          amount = EXCLUDED.amount,
          carrier_name = EXCLUDED.carrier_name,
          check_date = EXCLUDED.check_date,
          deposit_status = EXCLUDED.deposit_status,
          eligibility_status = EXCLUDED.eligibility_status,
          mortgage_flag = EXCLUDED.mortgage_flag,
          payee_line = EXCLUDED.payee_line,
          updated_at = now();
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'claim_checks sync in review failed (non-fatal): %', SQLERRM;
      END;
    END IF;
  END IF;

  IF p_merge_payees IS NOT NULL AND jsonb_array_length(p_merge_payees) > 0 THEN
    FOR v_merge IN SELECT * FROM jsonb_array_elements(p_merge_payees)
    LOOP
      v_target_id := (v_merge.value->>'target_payee_id')::uuid;

      DELETE FROM public.check_payees
      WHERE id = (v_merge.value->>'source_payee_id')::uuid
        AND check_id = p_check_id
        AND endorsement_status = 'pending';

      IF v_merge.value->>'merged_name' IS NOT NULL THEN
        UPDATE public.check_payees
        SET payee_name = v_merge.value->>'merged_name',
            updated_at = now()
        WHERE id = v_target_id
          AND check_id = p_check_id;
      END IF;

      INSERT INTO public.check_audit_log (
        check_id,
        event_type,
        event_description,
        event_data,
        actor_id
      ) VALUES (
        p_check_id,
        'payee_merged',
        format('Payee %s merged into %s', v_merge.value->>'source_payee_id', v_target_id),
        v_merge.value,
        p_reviewer_id
      );
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'decision_id', v_decision_id,
    'merge_only', v_is_merge_only,
    'new_stage', v_new_stage
  );
END;
$$;