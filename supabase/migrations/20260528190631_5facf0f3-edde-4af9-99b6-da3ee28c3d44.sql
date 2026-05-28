-- Fix send_for_endorsements in loss_draft_action: also move the underlying
-- check_intake_items back into the Endorsing lane, and use escrow_status
-- 'endorsing' (not 'final_release_complete') so the check doesn't vanish.
CREATE OR REPLACE FUNCTION public.loss_draft_action(
  p_loss_draft_id uuid,
  p_action text,
  p_actor_id uuid,
  p_amount numeric DEFAULT NULL,
  p_tracking_number text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_target_status text DEFAULT NULL,
  p_monitoring_type text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_check_id uuid;
BEGIN
  SELECT to_jsonb(ld.*) INTO v_old
  FROM public.loss_draft_tracking ld
  WHERE ld.id = p_loss_draft_id;

  IF v_old IS NULL THEN
    RAISE EXCEPTION 'Loss draft % not found', p_loss_draft_id;
  END IF;

  v_check_id := (v_old->>'check_intake_item_id')::uuid;

  IF p_action = 'set_monitoring_type' THEN
    UPDATE public.loss_draft_tracking
      SET monitoring_type = COALESCE(p_monitoring_type, monitoring_type),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'mark_sent' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'sent_to_lender',
          check_sent_date = COALESCE(check_sent_date, CURRENT_DATE),
          tracking_number_sent = COALESCE(p_tracking_number, tracking_number_sent),
          last_contact_at = now(),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'mark_received_back' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'check_received_back',
          check_received_back_date = COALESCE(check_received_back_date, CURRENT_DATE),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'send_for_endorsements' THEN
    -- Route check back into the Endorsing lane in Check Command Center
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'endorsing',
          updated_at = now()
    WHERE id = p_loss_draft_id;

    IF v_check_id IS NOT NULL THEN
      UPDATE public.check_intake_items
        SET status = 'endorsements_in_progress',
            check_stage = 'endorsing',
            updated_at = now()
      WHERE id = v_check_id;
    END IF;

  ELSIF p_action = 'mark_escrowed' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'escrowed',
          total_escrowed = COALESCE(p_amount, total_escrowed),
          check_received_date = COALESCE(check_received_date, CURRENT_DATE),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'request_draw' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'first_draw_requested',
          draw_amount_requested = COALESCE(draw_amount_requested, 0) + COALESCE(p_amount, 0),
          draw_stage = draw_stage + 1,
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'record_release' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = CASE
            WHEN COALESCE(draw_amount_released, 0) + COALESCE(p_amount, 0) >= COALESCE(total_escrowed, 0)
              AND COALESCE(total_escrowed, 0) > 0
            THEN 'final_release_complete'
            ELSE 'partial_release'
          END,
          draw_amount_released = COALESCE(draw_amount_released, 0) + COALESCE(p_amount, 0),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'record_holdback' THEN
    UPDATE public.loss_draft_tracking
      SET holdback_amount = COALESCE(p_amount, holdback_amount),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'mark_final_release' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'final_release_complete',
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'admin_reset_status' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = COALESCE(p_target_status, escrow_status),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSE
    RAISE EXCEPTION 'Unknown loss_draft_action: %', p_action;
  END IF;

  SELECT to_jsonb(ld.*) INTO v_new
  FROM public.loss_draft_tracking ld
  WHERE ld.id = p_loss_draft_id;

  INSERT INTO public.loss_draft_audit_log (loss_draft_id, action, actor_id, amount, notes, old_values, new_values)
  VALUES (
    p_loss_draft_id,
    p_action,
    p_actor_id,
    p_amount,
    p_notes,
    v_old,
    v_new
  );

  RETURN v_new;
END;
$$;

-- Recover Meghan Lago's check that was orphaned by the previous bug
UPDATE public.loss_draft_tracking
  SET escrow_status = 'endorsing', updated_at = now()
WHERE id = '7e2f6bcd-f94a-4b6d-9640-b01e1d5c700a';

UPDATE public.check_intake_items
  SET status = 'endorsements_in_progress',
      check_stage = 'endorsing',
      updated_at = now()
WHERE id = '98286516-df82-44b6-8174-9e3e1ebacc9c';