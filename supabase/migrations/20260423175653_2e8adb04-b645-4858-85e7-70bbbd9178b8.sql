
DROP FUNCTION IF EXISTS public.loss_draft_action(uuid,text,uuid,numeric,text,jsonb);

CREATE OR REPLACE FUNCTION public.loss_draft_action(
  p_loss_draft_id uuid,
  p_action text,
  p_actor_id uuid,
  p_amount numeric DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_extra jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft loss_draft_tracking%ROWTYPE;
  v_draw_number int;
  v_target_status text;
BEGIN
  SELECT * INTO v_draft FROM loss_draft_tracking WHERE id = p_loss_draft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loss draft not found'; END IF;

  CASE p_action
    WHEN 'set_monitoring_type' THEN
      UPDATE loss_draft_tracking
        SET monitoring_type = COALESCE(p_extra->>'monitoring_type', 'monitored'),
            updated_at = now()
        WHERE id = p_loss_draft_id;

    WHEN 'mark_sent' THEN
      UPDATE loss_draft_tracking
        SET escrow_status = 'sent_to_lender',
            check_sent_date = CURRENT_DATE,
            tracking_number_sent = COALESCE(p_extra->>'tracking_number', tracking_number_sent),
            shipping_method_sent = COALESCE(p_extra->>'shipping_method', shipping_method_sent),
            last_contact_at = now(),
            follow_up_count = follow_up_count + 1,
            follow_up_date = CURRENT_DATE + interval '7 days',
            updated_at = now()
        WHERE id = p_loss_draft_id;

    WHEN 'mark_received_back' THEN
      UPDATE loss_draft_tracking
        SET check_received_back_date = CURRENT_DATE,
            escrow_status = 'final_release_complete',
            last_contact_at = now(),
            updated_at = now()
        WHERE id = p_loss_draft_id;

    WHEN 'mark_escrowed' THEN
      UPDATE loss_draft_tracking
        SET escrow_status = 'escrowed',
            total_escrowed = COALESCE(p_amount, total_escrowed),
            check_received_date = CURRENT_DATE,
            last_contact_at = now(),
            updated_at = now()
        WHERE id = p_loss_draft_id;

    WHEN 'request_draw' THEN
      v_draw_number := v_draft.draw_stage + 1;
      UPDATE loss_draft_tracking
        SET escrow_status = 'first_draw_requested',
            draw_stage = v_draw_number,
            draw_amount_requested = COALESCE(p_amount, 0),
            last_contact_at = now(),
            follow_up_count = follow_up_count + 1,
            follow_up_date = CURRENT_DATE + interval '7 days',
            updated_at = now()
        WHERE id = p_loss_draft_id;
      INSERT INTO loss_draft_releases (loss_draft_id, draw_number, amount_requested, status, requested_at, notes)
        VALUES (p_loss_draft_id, v_draw_number, COALESCE(p_amount, 0), 'requested', now(), p_notes);

    WHEN 'record_release' THEN
      UPDATE loss_draft_tracking
        SET escrow_status = 'partial_release',
            draw_amount_released = draw_amount_released + COALESCE(p_amount, 0),
            last_contact_at = now(),
            updated_at = now()
        WHERE id = p_loss_draft_id;
      UPDATE loss_draft_releases
        SET amount_released = COALESCE(p_amount, 0),
            status = 'released',
            released_at = now(),
            release_date = CURRENT_DATE,
            notes = COALESCE(p_notes, notes)
        WHERE loss_draft_id = p_loss_draft_id AND draw_number = v_draft.draw_stage AND status = 'requested';

    WHEN 'record_holdback' THEN
      UPDATE loss_draft_tracking
        SET holdback_amount = holdback_amount + COALESCE(p_amount, 0),
            last_contact_at = now(),
            updated_at = now()
        WHERE id = p_loss_draft_id;

    WHEN 'mark_final_release' THEN
      UPDATE loss_draft_tracking
        SET escrow_status = 'final_release_complete',
            draw_amount_released = total_escrowed,
            holdback_amount = 0,
            last_contact_at = now(),
            updated_at = now()
        WHERE id = p_loss_draft_id;

    WHEN 'admin_reset_status' THEN
      v_target_status := COALESCE(p_extra->>'target_status', 'pending_send');
      UPDATE loss_draft_tracking
        SET escrow_status = v_target_status,
            check_sent_date = CASE WHEN v_target_status = 'pending_send' THEN NULL ELSE check_sent_date END,
            check_received_date = CASE WHEN v_target_status IN ('pending_send', 'sent_to_lender') THEN NULL ELSE check_received_date END,
            check_received_back_date = CASE WHEN v_target_status != 'final_release_complete' THEN NULL ELSE check_received_back_date END,
            tracking_number_sent = CASE WHEN v_target_status = 'pending_send' THEN NULL ELSE tracking_number_sent END,
            updated_at = now()
        WHERE id = p_loss_draft_id;

    ELSE
      RAISE EXCEPTION 'Unknown action: %', p_action;
  END CASE;

  INSERT INTO loss_draft_audit_log (loss_draft_id, action, actor_id, amount, notes)
    VALUES (p_loss_draft_id, p_action, p_actor_id, p_amount, p_notes);
END;
$$;
