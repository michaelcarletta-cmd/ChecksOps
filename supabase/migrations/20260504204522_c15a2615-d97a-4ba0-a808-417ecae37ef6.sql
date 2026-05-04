-- ============================================================
-- Migration 1: routing/account number columns
-- ============================================================
ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS routing_number text,
  ADD COLUMN IF NOT EXISTS account_number text;

ALTER TABLE public.claim_checks
  ADD COLUMN IF NOT EXISTS routing_number text,
  ADD COLUMN IF NOT EXISTS account_number text;

-- ============================================================
-- Migration 2: refresh check status transition trigger
-- (clears stuck endorsement state by allowing reroutes)
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_check_status_transition()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  allowed_statuses text[] := ARRAY[
    'uploaded',
    'needs_review',
    'manual_review_required',
    'endorsements_in_progress',
    'endorsements_complete',
    'signature_waived',
    'approved_for_deposit',
    'ready_for_deposit',
    'ready',
    'deposited',
    'cleared',
    'voided'
  ];
  valid_transitions jsonb := '{
    "uploaded": ["needs_review","manual_review_required","endorsements_in_progress","endorsements_complete","approved_for_deposit","ready_for_deposit","ready","signature_waived","voided"],
    "needs_review": ["uploaded","manual_review_required","endorsements_in_progress","endorsements_complete","approved_for_deposit","ready_for_deposit","ready","signature_waived","voided"],
    "manual_review_required": ["needs_review","uploaded","endorsements_in_progress","endorsements_complete","approved_for_deposit","ready_for_deposit","ready","signature_waived","voided"],
    "endorsements_in_progress": ["needs_review","endorsements_complete","signature_waived","approved_for_deposit","ready_for_deposit","ready","voided"],
    "endorsements_complete": ["needs_review","approved_for_deposit","ready_for_deposit","ready","signature_waived","voided"],
    "signature_waived": ["needs_review","approved_for_deposit","ready_for_deposit","ready","voided"],
    "approved_for_deposit": ["ready_for_deposit","ready","deposited","needs_review","voided"],
    "ready_for_deposit": ["ready","deposited","needs_review","voided"],
    "ready": ["deposited","needs_review","approved_for_deposit","ready_for_deposit","voided"],
    "deposited": ["cleared","voided","needs_review"],
    "cleared": ["needs_review"],
    "voided": ["needs_review"]
  }'::jsonb;
  next_allowed jsonb;
BEGIN
  IF NEW.status IS NULL THEN RAISE EXCEPTION 'check status cannot be null'; END IF;
  IF NOT (NEW.status = ANY(allowed_statuses)) THEN RAISE EXCEPTION 'invalid check status: %', NEW.status; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    next_allowed := valid_transitions -> OLD.status;
    IF next_allowed IS NULL OR NOT (next_allowed ? NEW.status) THEN
      RAISE EXCEPTION 'invalid check status transition: % -> %', OLD.status, NEW.status;
    END IF;
    INSERT INTO public.check_status_audit(check_intake_item_id, from_status, to_status, changed_by, source)
    VALUES (NEW.id, OLD.status, NEW.status, auth.uid(), 'trigger');
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.check_status_audit(check_intake_item_id, from_status, to_status, changed_by, source)
    VALUES (NEW.id, NULL, NEW.status, auth.uid(), 'trigger');
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- Migration 3: loss_draft_admin_delete RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.loss_draft_admin_delete(
  p_loss_draft_id uuid,
  p_actor_id uuid,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin boolean;
  v_check_id uuid;
  v_claim_id uuid;
BEGIN
  SELECT public.has_role(p_actor_id, 'admin'::app_role) INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Only admins can delete loss draft records';
  END IF;

  SELECT check_intake_item_id, claim_id
    INTO v_check_id, v_claim_id
    FROM public.loss_draft_tracking
    WHERE id = p_loss_draft_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loss draft not found';
  END IF;

  BEGIN DELETE FROM public.loss_draft_releases WHERE loss_draft_id = p_loss_draft_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.loss_draft_documents WHERE loss_draft_id = p_loss_draft_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.loss_draft_audit_log WHERE loss_draft_id = p_loss_draft_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  DELETE FROM public.loss_draft_tracking WHERE id = p_loss_draft_id;

  BEGIN
    INSERT INTO public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    VALUES (p_actor_id, 'loss_draft_admin_delete', 'loss_draft_tracking', p_loss_draft_id,
            jsonb_build_object('reason', p_reason, 'claim_id', v_claim_id, 'check_intake_item_id', v_check_id));
  EXCEPTION WHEN undefined_table THEN NULL; END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.loss_draft_admin_delete(uuid, uuid, text) TO authenticated;