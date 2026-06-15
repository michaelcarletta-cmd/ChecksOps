
CREATE OR REPLACE FUNCTION public.admin_delete_check(p_check_id uuid, p_actor_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin BOOLEAN;
  v_check RECORD;
  v_snapshot JSONB;
BEGIN
  SELECT public.has_role(p_actor_id, 'admin'::app_role) INTO v_is_admin;
  IF NOT COALESCE(v_is_admin, FALSE) THEN
    RAISE EXCEPTION 'Only admins can delete checks';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'A deletion reason (min 3 characters) is required';
  END IF;

  SELECT * INTO v_check FROM public.check_intake_items WHERE id = p_check_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Check not found';
  END IF;

  v_snapshot := to_jsonb(v_check);

  -- Non-cascading FK holders (these are the ones that block deletion)
  BEGIN DELETE FROM public.deposit_items WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.disbursement_batches WHERE check_intake_item_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.claim_check_payments WHERE check_intake_item_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.claim_checks WHERE check_intake_item_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE public.claim_payments SET check_intake_item_id = NULL WHERE check_intake_item_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE public.loss_draft_tracking SET check_intake_item_id = NULL WHERE check_intake_item_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- Cascading FK holders cleared explicitly for belt-and-suspenders + audit clarity
  BEGIN DELETE FROM public.check_payees WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_audit_log WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_endorsements WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_endorsement_events WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_eligibility_results WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_intake_mortgage_draws WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_reissue_requests WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_review_decisions WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_message_reads WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_messages WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.endorsement_audit_log WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.endorsement_requests WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.shared_checks WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_files WHERE check_intake_item_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_stakeholders WHERE check_intake_item_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_billing_events WHERE check_intake_item_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_status_audit WHERE check_intake_item_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_reconciliation_alerts WHERE check_intake_item_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.signature_requests WHERE check_intake_item_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.checkalt_deposits WHERE check_intake_item_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.check_payment_directions WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- Legacy / optional tables (kept for safety)
  BEGIN DELETE FROM public.deposit_ops_packets WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.deposit_ops_attachments WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.deposit_ops_exceptions WHERE check_id = p_check_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  DELETE FROM public.check_intake_items WHERE id = p_check_id;

  INSERT INTO public.check_deletion_log
    (check_id, claim_id, check_number, amount, status, reason, deleted_by, snapshot)
  VALUES (
    p_check_id, v_check.claim_id, v_check.check_number,
    (v_snapshot->>'amount')::NUMERIC, v_check.status::TEXT,
    btrim(p_reason), p_actor_id, v_snapshot
  );

  IF v_check.claim_id IS NOT NULL THEN
    BEGIN
      INSERT INTO public.claim_audit_log (claim_id, actor_id, event_type, event_description, event_data)
      VALUES (
        v_check.claim_id, p_actor_id, 'check_deleted_by_admin',
        'Admin deleted check #' || COALESCE(v_check.check_number, p_check_id::TEXT) || ' — Reason: ' || btrim(p_reason),
        jsonb_build_object('check_id', p_check_id, 'check_number', v_check.check_number, 'reason', btrim(p_reason))
      );
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN jsonb_build_object('success', true, 'check_id', p_check_id);
END;
$function$;
