ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS returned_at timestamptz,
  ADD COLUMN IF NOT EXISTS return_code text,
  ADD COLUMN IF NOT EXISTS return_reason text,
  ADD COLUMN IF NOT EXISTS return_notes text,
  ADD COLUMN IF NOT EXISTS return_recorded_by uuid,
  ADD COLUMN IF NOT EXISTS return_source text,
  ADD COLUMN IF NOT EXISTS pre_return_stage public.check_stage,
  ADD COLUMN IF NOT EXISTS return_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS return_resolution text;

ALTER TABLE public.checkalt_deposits
  ADD COLUMN IF NOT EXISTS return_code text,
  ADD COLUMN IF NOT EXISTS return_window_until timestamptz;

CREATE INDEX IF NOT EXISTS idx_check_intake_returned
  ON public.check_intake_items (tenant_id, returned_at DESC)
  WHERE returned_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_checkalt_deposits_return_window
  ON public.checkalt_deposits (return_window_until)
  WHERE return_window_until IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_check_return(
  p_check_id uuid,
  p_return_code text,
  p_return_reason text,
  p_returned_at timestamptz DEFAULT now(),
  p_notes text DEFAULT NULL,
  p_actor_id uuid DEFAULT NULL,
  p_source text DEFAULT 'manual'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_check public.check_intake_items%ROWTYPE;
  v_prev public.check_stage;
  v_disbursed numeric := 0;
BEGIN
  SELECT * INTO v_check FROM public.check_intake_items WHERE id = p_check_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Check % not found', p_check_id;
  END IF;

  IF v_check.check_stage = 'returned'::public.check_stage THEN
    RETURN jsonb_build_object('ok', true, 'already_returned', true, 'check_id', p_check_id);
  END IF;

  v_prev := v_check.check_stage;

  SELECT COALESCE(SUM(ds.amount), 0) INTO v_disbursed
  FROM public.disbursement_splits ds
  JOIN public.disbursement_batches db ON db.id = ds.batch_id
  WHERE db.check_intake_item_id = p_check_id
    AND ds.status NOT IN ('failed', 'cancelled', 'returned');

  UPDATE public.check_intake_items
     SET check_stage = 'returned'::public.check_stage,
         status = 'returned',
         pre_return_stage = v_prev,
         returned_at = COALESCE(p_returned_at, now()),
         return_code = p_return_code,
         return_reason = p_return_reason,
         return_notes = p_notes,
         return_recorded_by = p_actor_id,
         return_source = COALESCE(p_source, 'manual'),
         return_resolved_at = NULL,
         return_resolution = NULL,
         updated_at = now()
   WHERE id = p_check_id;

  UPDATE public.claim_checks
     SET deposit_status = 'returned'
   WHERE check_intake_item_id = p_check_id;

  INSERT INTO public.check_audit_log (check_id, event_type, event_description, event_data, actor_id, tenant_id)
  VALUES (
    p_check_id,
    'check_returned',
    'Check returned by bank: ' || COALESCE(p_return_reason, p_return_code, 'unspecified'),
    jsonb_build_object(
      'return_code', p_return_code,
      'return_reason', p_return_reason,
      'returned_at', COALESCE(p_returned_at, now()),
      'previous_stage', v_prev,
      'source', COALESCE(p_source, 'manual'),
      'disbursed_amount', v_disbursed,
      'notes', p_notes
    ),
    p_actor_id,
    v_check.tenant_id
  );

  INSERT INTO public.check_reconciliation_alerts (alert_type, severity, check_intake_item_id, details)
  VALUES (
    'check_returned',
    CASE WHEN v_disbursed > 0 THEN 'critical' ELSE 'warning' END,
    p_check_id,
    jsonb_build_object(
      'return_code', p_return_code,
      'return_reason', p_return_reason,
      'returned_at', COALESCE(p_returned_at, now()),
      'previous_stage', v_prev,
      'amount', v_check.amount,
      'disbursed_amount', v_disbursed,
      'clawback_exposure', v_disbursed > 0,
      'source', COALESCE(p_source, 'manual')
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'check_id', p_check_id,
    'previous_stage', v_prev,
    'disbursed_amount', v_disbursed,
    'clawback_exposure', v_disbursed > 0
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_check_return(
  p_check_id uuid,
  p_resolution text,
  p_actor_id uuid DEFAULT NULL,
  p_restore_stage boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_check public.check_intake_items%ROWTYPE;
  v_target public.check_stage;
BEGIN
  SELECT * INTO v_check FROM public.check_intake_items WHERE id = p_check_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Check % not found', p_check_id;
  END IF;

  v_target := CASE
    WHEN p_restore_stage THEN COALESCE(v_check.pre_return_stage, 'ready_for_deposit'::public.check_stage)
    ELSE 'returned'::public.check_stage
  END;

  UPDATE public.check_intake_items
     SET check_stage = v_target,
         status = CASE WHEN p_restore_stage THEN 'approved_for_deposit' ELSE status END,
         return_resolved_at = now(),
         return_resolution = p_resolution,
         updated_at = now()
   WHERE id = p_check_id;

  UPDATE public.check_reconciliation_alerts
     SET resolved = true, resolved_at = now(), resolved_by = p_actor_id
   WHERE check_intake_item_id = p_check_id
     AND alert_type = 'check_returned'
     AND resolved = false;

  INSERT INTO public.check_audit_log (check_id, event_type, event_description, event_data, actor_id, tenant_id)
  VALUES (
    p_check_id,
    'check_return_resolved',
    'Return resolved: ' || COALESCE(p_resolution, 'resolved'),
    jsonb_build_object('resolution', p_resolution, 'restored_stage', v_target),
    p_actor_id,
    v_check.tenant_id
  );

  RETURN jsonb_build_object('ok', true, 'check_id', p_check_id, 'stage', v_target);
END;
$$;

REVOKE ALL ON FUNCTION public.record_check_return(uuid, text, text, timestamptz, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_check_return(uuid, text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_check_return(uuid, text, text, timestamptz, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_check_return(uuid, text, uuid, boolean) TO authenticated, service_role;