
-- Phase 3 Hardening: transition validation, audited doc toggle, idempotent creation, improved release logic

-- 1. Replace loss_draft_action with transition-validated version
CREATE OR REPLACE FUNCTION public.loss_draft_action(
  p_loss_draft_id uuid,
  p_action text,
  p_actor_id uuid,
  p_amount numeric DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_extra jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_ld record;
  v_new_status text;
  v_draw_num integer;
  v_release_id uuid;
  v_allowed_from text[];
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_ld FROM loss_draft_tracking WHERE id = p_loss_draft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loss draft not found'; END IF;

  -- Action-transition validation matrix
  v_allowed_from := CASE p_action
    WHEN 'mark_sent' THEN ARRAY['pending_send']
    WHEN 'mark_escrowed' THEN ARRAY['sent_to_lender','received_by_lender','pending_send']
    WHEN 'request_draw' THEN ARRAY['escrowed','first_draw_requested','partial_release']
    WHEN 'record_release' THEN ARRAY['first_draw_requested','partial_release','escrowed']
    WHEN 'record_holdback' THEN ARRAY['escrowed','first_draw_requested','partial_release']
    WHEN 'mark_final_release' THEN ARRAY['partial_release','escrowed','first_draw_requested']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (v_ld.escrow_status = ANY(v_allowed_from)) THEN
    RAISE EXCEPTION 'Invalid action % from status %', p_action, v_ld.escrow_status;
  END IF;

  CASE p_action
    WHEN 'mark_sent' THEN
      v_new_status := 'sent_to_lender';
      UPDATE loss_draft_tracking SET
        escrow_status = v_new_status,
        check_sent_date = COALESCE((p_extra->>'sent_date')::date, CURRENT_DATE),
        updated_at = now()
      WHERE id = p_loss_draft_id;

    WHEN 'mark_escrowed' THEN
      v_new_status := 'escrowed';
      UPDATE loss_draft_tracking SET
        escrow_status = v_new_status,
        check_received_date = COALESCE((p_extra->>'received_date')::date, CURRENT_DATE),
        total_escrowed = COALESCE(p_amount, v_ld.total_escrowed),
        holdback_amount = COALESCE(p_amount, v_ld.total_escrowed),
        updated_at = now()
      WHERE id = p_loss_draft_id;

    WHEN 'request_draw' THEN
      v_draw_num := v_ld.draw_stage + 1;
      v_new_status := CASE WHEN v_draw_num = 1 THEN 'first_draw_requested' ELSE v_ld.escrow_status END;
      
      INSERT INTO loss_draft_releases (loss_draft_id, draw_number, amount_requested, notes, created_by)
      VALUES (p_loss_draft_id, v_draw_num, COALESCE(p_amount, 0), p_notes, p_actor_id)
      RETURNING id INTO v_release_id;

      UPDATE loss_draft_tracking SET
        escrow_status = v_new_status,
        draw_stage = v_draw_num,
        draw_amount_requested = COALESCE(p_amount, 0),
        follow_up_date = CURRENT_DATE + 7,
        last_contact_at = now(),
        updated_at = now()
      WHERE id = p_loss_draft_id;

    WHEN 'record_release' THEN
      v_new_status := 'partial_release';
      
      -- Try to update latest open release row, or insert a new one
      UPDATE loss_draft_releases SET
        amount_released = COALESCE(p_amount, 0),
        released_at = now(),
        release_date = CURRENT_DATE,
        status = 'released',
        notes = COALESCE(p_notes, notes)
      WHERE id = (
        SELECT id FROM loss_draft_releases
        WHERE loss_draft_id = p_loss_draft_id AND status != 'released'
        ORDER BY draw_number DESC LIMIT 1
      )
      RETURNING id INTO v_release_id;

      -- If no open release row found, append a new one
      IF v_release_id IS NULL THEN
        INSERT INTO loss_draft_releases (
          loss_draft_id, draw_number, amount_requested, amount_released,
          release_date, released_at, status, notes, created_by
        ) VALUES (
          p_loss_draft_id, v_ld.draw_stage + 1, COALESCE(p_amount, 0), COALESCE(p_amount, 0),
          CURRENT_DATE, now(), 'released', p_notes, p_actor_id
        ) RETURNING id INTO v_release_id;

        UPDATE loss_draft_tracking SET draw_stage = v_ld.draw_stage + 1 WHERE id = p_loss_draft_id;
      END IF;

      UPDATE loss_draft_tracking SET
        escrow_status = v_new_status,
        draw_amount_released = v_ld.draw_amount_released + COALESCE(p_amount, 0),
        holdback_amount = GREATEST(0, v_ld.total_escrowed - v_ld.draw_amount_released - COALESCE(p_amount, 0)),
        last_contact_at = now(),
        updated_at = now()
      WHERE id = p_loss_draft_id;

    WHEN 'record_holdback' THEN
      UPDATE loss_draft_tracking SET
        holdback_amount = COALESCE(p_amount, v_ld.holdback_amount),
        last_contact_at = now(),
        updated_at = now()
      WHERE id = p_loss_draft_id;

    WHEN 'mark_final_release' THEN
      v_new_status := 'final_release_complete';
      UPDATE loss_draft_tracking SET
        escrow_status = v_new_status,
        draw_amount_released = v_ld.total_escrowed,
        holdback_amount = 0,
        last_contact_at = now(),
        updated_at = now()
      WHERE id = p_loss_draft_id;

    ELSE
      RAISE EXCEPTION 'Unknown action: %', p_action;
  END CASE;

  -- Audit
  INSERT INTO loss_draft_audit_log (loss_draft_id, action, actor_id, amount, old_values, new_values, notes)
  VALUES (
    p_loss_draft_id, p_action, p_actor_id, p_amount,
    jsonb_build_object('escrow_status', v_ld.escrow_status, 'draw_stage', v_ld.draw_stage,
      'draw_amount_released', v_ld.draw_amount_released, 'holdback_amount', v_ld.holdback_amount),
    jsonb_build_object('escrow_status', COALESCE(v_new_status, v_ld.escrow_status)),
    p_notes
  );

  IF p_action IN ('request_draw', 'record_release', 'mark_escrowed', 'mark_final_release') THEN
    UPDATE loss_draft_tracking SET follow_up_count = follow_up_count + 1 WHERE id = p_loss_draft_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'action', p_action, 'release_id', v_release_id);
END;
$$;

-- 2. Audited document toggle RPC
CREATE OR REPLACE FUNCTION public.loss_draft_toggle_document(
  p_doc_id uuid,
  p_is_submitted boolean,
  p_actor_id uuid,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_doc record;
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_doc FROM loss_draft_documents WHERE id = p_doc_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document not found'; END IF;

  UPDATE loss_draft_documents SET
    is_submitted = p_is_submitted,
    submitted_at = CASE WHEN p_is_submitted THEN now() ELSE NULL END,
    submitted_by = CASE WHEN p_is_submitted THEN p_actor_id ELSE NULL END,
    notes = COALESCE(p_notes, notes),
    updated_at = now()
  WHERE id = p_doc_id;

  INSERT INTO loss_draft_audit_log (loss_draft_id, action, actor_id, notes)
  VALUES (
    v_doc.loss_draft_id,
    CASE WHEN p_is_submitted THEN 'document_submitted' ELSE 'document_unsubmitted' END,
    p_actor_id,
    format('Document "%s" marked %s', v_doc.document_label,
      CASE WHEN p_is_submitted THEN 'submitted' ELSE 'not submitted' END)
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

-- 3. Idempotent loss draft creation (unique per claim + servicer)
CREATE UNIQUE INDEX idx_loss_draft_claim_servicer
  ON public.loss_draft_tracking (claim_id, lower(mortgage_servicer))
  WHERE escrow_status != 'final_release_complete';
