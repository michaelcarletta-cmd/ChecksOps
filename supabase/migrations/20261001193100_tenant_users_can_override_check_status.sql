-- Tenant company users may override check workflow status. Platform admin
-- still can. Deposit remains a separate path that requires endorsements.
CREATE OR REPLACE FUNCTION public.admin_override_check_status(p_check_id uuid, p_new_status text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_check public.check_intake_items%ROWTYPE;
  v_stage public.check_stage;
  v_rec text;
  v_allowed text[] := ARRAY[
    'uploaded','processing','ocr_complete','needs_review','manual_review_required',
    'reissue_requested','endorsements_in_progress','endorsements_complete',
    'approved_for_deposit','branch_deposit_required','loss_draft_required',
    'voided'
  ];
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_new_status IS NULL OR NOT (p_new_status = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'Invalid status: %', p_new_status;
  END IF;

  SELECT * INTO v_check FROM public.check_intake_items WHERE id = p_check_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Check not found';
  END IF;

  IF NOT public.has_role(p_actor_id, 'admin'::app_role)
     AND NOT public.user_belongs_to_tenant(p_actor_id, v_check.tenant_id)
  THEN
    RAISE EXCEPTION 'Not permitted to override this check';
  END IF;

  v_stage := (CASE p_new_status
    WHEN 'endorsements_in_progress' THEN 'endorsing'
    WHEN 'endorsements_complete' THEN 'endorsing'
    WHEN 'approved_for_deposit' THEN 'ready_for_deposit'
    WHEN 'branch_deposit_required' THEN 'ready_for_deposit'
    WHEN 'loss_draft_required' THEN 'loss_draft'
    ELSE 'review'
  END)::public.check_stage;

  v_rec := CASE p_new_status
    WHEN 'endorsements_in_progress' THEN 'endorsements_pending'
    WHEN 'endorsements_complete' THEN 'endorsements_pending'
    WHEN 'approved_for_deposit' THEN 'ready_for_deposit'
    WHEN 'branch_deposit_required' THEN 'branch_deposit_recommended'
    WHEN 'loss_draft_required' THEN 'loss_draft_required'
    WHEN 'reissue_requested' THEN 'request_reissue'
    ELSE NULL
  END;

  UPDATE public.check_intake_items
  SET status = p_new_status,
      check_stage = v_stage,
      deposit_recommendation = v_rec,
      updated_at = now()
  WHERE id = p_check_id;

  UPDATE public.claim_checks
  SET check_stage = v_stage, updated_at = now()
  WHERE check_intake_item_id = p_check_id;

  INSERT INTO public.check_audit_log (check_id, event_type, actor_id, event_description, event_data)
  VALUES (
    p_check_id,
    'status_manual_override',
    p_actor_id,
    format('Status manually changed from "%s" to "%s"', v_check.status, p_new_status),
    jsonb_build_object('old_status', v_check.status, 'new_status', p_new_status, 'new_stage', v_stage)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'check_id', p_check_id,
    'old_status', v_check.status,
    'new_status', p_new_status,
    'new_stage', v_stage
  );
END;
$function$;
