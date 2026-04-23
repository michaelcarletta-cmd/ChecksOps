
CREATE OR REPLACE FUNCTION public.loss_draft_action(
  p_loss_draft_id uuid,
  p_action text,
  p_actor_id uuid,
  p_amount numeric DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_extra jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft loss_draft_tracking%ROWTYPE;
  v_target_status text;
  v_release_id uuid;
  v_check_id uuid;
BEGIN
  SELECT * INTO v_draft FROM loss_draft_tracking WHERE id = p_loss_draft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loss draft record not found'; END IF;

  IF p_action = 'set_monitoring_type' THEN
    UPDATE loss_draft_tracking
      SET monitoring_type = COALESCE(p_extra->>'monitoring_type', 'monitored'),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'mark_sent' THEN
    UPDATE loss_draft_tracking
      SET escrow_status = 'sent_to_lender',
          check_sent_date = now()::date,
          tracking_number_sent = COALESCE(p_extra->>'tracking_number', tracking_number_sent),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'mark_received_back' THEN
    UPDATE loss_draft_tracking
      SET check_received_back_date = now()::date,
          escrow_status = 'check_received_back',
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'send_for_endorsements' THEN
    UPDATE loss_draft_tracking
      SET escrow_status = 'endorsing',
          updated_at = now()
    WHERE id = p_loss_draft_id;

    SELECT ci.id INTO v_check_id
    FROM check_intake_items ci
    WHERE ci.claim_id = v_draft.claim_id
    ORDER BY ci.created_at DESC
    LIMIT 1;

    IF v_check_id IS NOT NULL THEN
      UPDATE check_intake_items
        SET status = 'endorsing',
            updated_at = now()
      WHERE id = v_check_id;
    END IF;

  ELSIF p_action = 'mark_escrowed' THEN
    UPDATE loss_draft_tracking
      SET escrow_status = 'escrowed',
          total_escrowed = COALESCE(p_amount, total_escrowed),
          check_received_date = now()::date,
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'request_draw' THEN
    UPDATE loss_draft_tracking
      SET escrow_status = 'first_draw_requested',
          draw_stage = draw_stage + 1,
          draw_amount_requested = COALESCE(p_amount, 0),
          updated_at = now()
    WHERE id = p_loss_draft_id;

    INSERT INTO loss_draft_releases (loss_draft_id, draw_number, amount_requested, status)
    VALUES (p_loss_draft_id, v_draft.draw_stage + 1, COALESCE(p_amount, 0), 'requested');

  ELSIF p_action = 'record_release' THEN
    UPDATE loss_draft_tracking
      SET escrow_status = 'partial_release',
          draw_amount_released = draw_amount_released + COALESCE(p_amount, 0),
          updated_at = now()
    WHERE id = p_loss_draft_id;

    SELECT id INTO v_release_id
    FROM loss_draft_releases
    WHERE loss_draft_id = p_loss_draft_id AND status = 'requested'
    ORDER BY draw_number DESC
    LIMIT 1;

    IF v_release_id IS NOT NULL THEN
      UPDATE loss_draft_releases
        SET status = 'released',
            amount_released = COALESCE(p_amount, 0),
            released_at = now()
      WHERE id = v_release_id;
    END IF;

  ELSIF p_action = 'record_holdback' THEN
    UPDATE loss_draft_tracking
      SET holdback_amount = holdback_amount + COALESCE(p_amount, 0),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'mark_final_release' THEN
    UPDATE loss_draft_tracking
      SET escrow_status = 'final_release_complete',
          updated_at = now()
    WHERE id = p_loss_draft_id;

    SELECT ci.id INTO v_check_id
    FROM check_intake_items ci
    WHERE ci.claim_id = v_draft.claim_id
    ORDER BY ci.created_at DESC
    LIMIT 1;

    IF v_check_id IS NOT NULL THEN
      UPDATE check_intake_items
        SET status = 'approved_for_deposit',
            updated_at = now()
      WHERE id = v_check_id;
    END IF;

  ELSIF p_action = 'admin_reset_status' THEN
    v_target_status := p_extra->>'target_status';
    IF v_target_status IS NULL THEN
      RAISE EXCEPTION 'target_status is required for admin_reset_status';
    END IF;

    UPDATE loss_draft_tracking
      SET escrow_status = v_target_status,
          check_sent_date = CASE WHEN v_target_status = 'pending_send' THEN NULL ELSE check_sent_date END,
          check_received_date = CASE WHEN v_target_status IN ('pending_send','sent_to_lender') THEN NULL ELSE check_received_date END,
          check_received_back_date = CASE WHEN v_target_status IN ('pending_send','sent_to_lender','received_by_lender') THEN NULL ELSE check_received_back_date END,
          tracking_number_sent = CASE WHEN v_target_status = 'pending_send' THEN NULL ELSE tracking_number_sent END,
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSE
    RAISE EXCEPTION 'Unknown action: %', p_action;
  END IF;

  INSERT INTO loss_draft_audit_log (loss_draft_id, action, performed_by, notes, extra)
  VALUES (p_loss_draft_id, p_action, p_actor_id, p_notes, p_extra);
END;
$$;
