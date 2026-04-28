-- Admin-only RPC to delete a check and all its related records safely.
-- Cleans up: check_payees, check_audit_log, check endorsements, deposit ops rows,
-- loss_draft_tracking rows referencing this check, and finally the check itself.
CREATE OR REPLACE FUNCTION public.admin_delete_check(
  p_check_id UUID,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin BOOLEAN;
  v_check RECORD;
BEGIN
  -- Verify admin
  SELECT public.has_role(p_actor_id, 'admin'::app_role) INTO v_is_admin;
  IF NOT COALESCE(v_is_admin, FALSE) THEN
    RAISE EXCEPTION 'Only admins can delete checks';
  END IF;

  SELECT id, claim_id, check_number, front_image_path, back_image_path
    INTO v_check
  FROM public.check_intake_items
  WHERE id = p_check_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Check not found';
  END IF;

  -- Best-effort cascade cleanup of dependents (only touches tables if they exist).
  -- check_payees
  DELETE FROM public.check_payees WHERE check_id = p_check_id;

  -- audit log for the check
  BEGIN
    DELETE FROM public.check_audit_log WHERE check_id = p_check_id;
  EXCEPTION WHEN undefined_table THEN NULL; END;

  -- endorsements
  BEGIN
    DELETE FROM public.check_endorsements WHERE check_id = p_check_id;
  EXCEPTION WHEN undefined_table THEN NULL; END;

  -- deposit-ops related
  BEGIN
    DELETE FROM public.deposit_ops_packets WHERE check_id = p_check_id;
  EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN
    DELETE FROM public.deposit_ops_attachments WHERE check_id = p_check_id;
  EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN
    DELETE FROM public.deposit_ops_exceptions WHERE check_id = p_check_id;
  EXCEPTION WHEN undefined_table THEN NULL; END;

  -- loss draft tracking referencing this check
  BEGIN
    UPDATE public.loss_draft_tracking
       SET check_intake_item_id = NULL
     WHERE check_intake_item_id = p_check_id;
  EXCEPTION WHEN undefined_column THEN NULL; END;

  -- shared checks
  BEGIN
    DELETE FROM public.shared_checks WHERE check_id = p_check_id;
  EXCEPTION WHEN undefined_table THEN NULL; END;

  -- Finally delete the check
  DELETE FROM public.check_intake_items WHERE id = p_check_id;

  -- Log the deletion at the claim level if possible
  IF v_check.claim_id IS NOT NULL THEN
    BEGIN
      INSERT INTO public.claim_audit_log (claim_id, actor_id, event_type, event_description, event_data)
      VALUES (
        v_check.claim_id,
        p_actor_id,
        'check_deleted_by_admin',
        'Admin deleted check #' || COALESCE(v_check.check_number, p_check_id::TEXT),
        jsonb_build_object('check_id', p_check_id, 'check_number', v_check.check_number)
      );
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN jsonb_build_object('success', true, 'check_id', p_check_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_delete_check(UUID, UUID) TO authenticated;