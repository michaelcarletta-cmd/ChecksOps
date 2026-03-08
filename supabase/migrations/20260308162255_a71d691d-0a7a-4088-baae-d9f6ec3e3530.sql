
-- Transactional RPC: submit_check_review_decision
-- Atomically updates check, writes review decision, inserts audit rows, and optionally creates reissue request
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
BEGIN
  -- Verify caller is staff/admin
  IF NOT public.has_role(p_reviewer_id, 'staff') AND NOT public.has_role(p_reviewer_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized to submit review decisions';
  END IF;

  -- Get current check state
  SELECT * INTO v_old FROM check_intake_items WHERE id = p_check_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Check not found';
  END IF;

  -- Step 1: Update check_intake_items
  UPDATE check_intake_items SET
    status = CASE
      WHEN p_deposit_path = 'reissue_requested' THEN 'reissue_requested'
      WHEN p_deposit_path = 'hold_for_claim_review' THEN 'needs_review'
      ELSE p_deposit_path
    END,
    deposit_recommendation = CASE
      WHEN p_deposit_path = 'approved_for_deposit' THEN 'ready_for_deposit'
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

  -- Step 2: Insert review decision
  INSERT INTO check_review_decisions (
    check_id, reviewer_id, decision, deposit_path,
    confirmed_carrier_name, confirmed_check_number,
    confirmed_amount, confirmed_payee_line, reviewer_notes
  ) VALUES (
    p_check_id, p_reviewer_id, p_deposit_path, p_deposit_path,
    p_confirmed_carrier_name, p_confirmed_check_number,
    p_confirmed_amount, p_confirmed_payee_line, p_reviewer_notes
  ) RETURNING id INTO v_decision_id;

  -- Step 3: Audit each field change
  FOR v_change IN SELECT * FROM jsonb_array_elements(p_field_changes)
  LOOP
    INSERT INTO check_audit_log (check_id, event_type, event_description, event_data, actor_id)
    VALUES (
      p_check_id,
      'manual_field_edit',
      format('Reviewer changed %s: "%s" → "%s"',
        v_change.value->>'field',
        COALESCE(v_change.value->>'old_value', ''),
        COALESCE(v_change.value->>'new_value', '')),
      v_change.value,
      p_reviewer_id
    );
  END LOOP;

  -- Step 4: Audit the decision itself
  INSERT INTO check_audit_log (check_id, event_type, event_description, event_data, actor_id)
  VALUES (
    p_check_id,
    'review_decision',
    format('Reviewer set deposit path: %s', p_deposit_path),
    jsonb_build_object(
      'deposit_path', p_deposit_path,
      'decision_id', v_decision_id,
      'fields_edited', jsonb_array_length(p_field_changes),
      'notes', p_reviewer_notes
    ),
    p_reviewer_id
  );

  -- Step 5: Create reissue request if applicable
  IF p_deposit_path = 'reissue_requested' THEN
    INSERT INTO check_reissue_requests (check_id, requested_by, reason, reason_category)
    VALUES (
      p_check_id,
      p_reviewer_id,
      COALESCE(p_reissue_reason, p_reviewer_notes, 'Check not practically depositable'),
      p_reissue_reason_category
    );

    INSERT INTO check_audit_log (check_id, event_type, event_description, event_data, actor_id)
    VALUES (
      p_check_id, 'reissue_requested',
      format('Reissue requested: %s', p_reissue_reason_category),
      jsonb_build_object('reason', p_reissue_reason, 'category', p_reissue_reason_category),
      p_reviewer_id
    );
  END IF;

  -- Step 6: Merge payees if requested
  IF p_merge_payees IS NOT NULL AND jsonb_array_length(p_merge_payees) > 0 THEN
    FOR v_merge IN SELECT * FROM jsonb_array_elements(p_merge_payees)
    LOOP
      v_target_id := (v_merge.value->>'target_payee_id')::uuid;

      -- Delete the source payee (only if no endorsement activity)
      DELETE FROM check_payees
      WHERE id = (v_merge.value->>'source_payee_id')::uuid
        AND check_id = p_check_id
        AND endorsement_status = 'pending';

      -- Update target payee name if provided
      IF v_merge.value->>'merged_name' IS NOT NULL THEN
        UPDATE check_payees
        SET payee_name = v_merge.value->>'merged_name',
            updated_at = now()
        WHERE id = v_target_id AND check_id = p_check_id;
      END IF;

      INSERT INTO check_audit_log (check_id, event_type, event_description, event_data, actor_id)
      VALUES (
        p_check_id, 'payee_merged',
        format('Payee %s merged into %s', v_merge.value->>'source_payee_id', v_target_id),
        v_merge.value,
        p_reviewer_id
      );
    END LOOP;
  END IF;

  RETURN jsonb_build_object('success', true, 'decision_id', v_decision_id);
END;
$$;
