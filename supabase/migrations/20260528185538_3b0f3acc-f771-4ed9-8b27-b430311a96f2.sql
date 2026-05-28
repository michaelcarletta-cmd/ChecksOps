CREATE OR REPLACE FUNCTION public.loss_draft_action(
  p_loss_draft_id uuid,
  p_action text,
  p_actor_id uuid,
  p_amount numeric DEFAULT NULL::numeric,
  p_notes text DEFAULT NULL::text,
  p_extra jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_draft public.loss_draft_tracking%ROWTYPE;
  v_old jsonb;
  v_new jsonb;
  v_tracking text;
BEGIN
  SELECT * INTO v_draft FROM public.loss_draft_tracking WHERE id = p_loss_draft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loss draft record not found'; END IF;

  v_old := jsonb_build_object(
    'escrow_status', v_draft.escrow_status,
    'monitoring_type', v_draft.monitoring_type,
    'total_escrowed', v_draft.total_escrowed,
    'draw_amount_released', v_draft.draw_amount_released,
    'holdback_amount', v_draft.holdback_amount
  );

  v_tracking := NULLIF(p_extra->>'tracking_number', '');

  IF p_action = 'set_monitoring_type' THEN
    UPDATE public.loss_draft_tracking
      SET monitoring_type = COALESCE(p_extra->>'monitoring_type', 'monitored'),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'mark_sent' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'sent_to_lender',
          check_sent_date = COALESCE(check_sent_date, CURRENT_DATE),
          tracking_number_sent = COALESCE(v_tracking, tracking_number_sent),
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
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'final_release_complete',
          updated_at = now()
    WHERE id = p_loss_draft_id;

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
      SET holdback_amount = COALESCE(holdback_amount, 0) + COALESCE(p_amount, 0),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'mark_final_release' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'final_release_complete',
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'admin_reset_status' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = COALESCE(p_extra->>'target_status', escrow_status),
          updated_at = now()
    WHERE id = p_loss_draft_id;
  END IF;

  SELECT jsonb_build_object(
    'escrow_status', escrow_status,
    'monitoring_type', monitoring_type,
    'total_escrowed', total_escrowed,
    'draw_amount_released', draw_amount_released,
    'holdback_amount', holdback_amount
  ) INTO v_new FROM public.loss_draft_tracking WHERE id = p_loss_draft_id;

  INSERT INTO public.loss_draft_audit_log (loss_draft_id, action, actor_id, amount, notes, old_values, new_values)
  VALUES (p_loss_draft_id, p_action, p_actor_id, p_amount, p_notes, v_old, v_new || COALESCE(p_extra, '{}'::jsonb));
END;
$function$;