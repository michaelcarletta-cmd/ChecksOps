
-- Phase 3: Loss Draft / Mortgage Escrow Tracker
-- ==============================================

-- Main loss draft tracking table
CREATE TABLE public.loss_draft_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  check_intake_item_id uuid REFERENCES public.check_intake_items(id),
  
  -- Mortgage servicer info
  mortgage_servicer text NOT NULL,
  loss_draft_contact text,
  loss_draft_phone text,
  loss_draft_email text,
  loss_draft_fax text,
  loan_number text,
  
  -- Check tracking
  check_sent_date date,
  check_received_date date,
  
  -- Escrow state
  escrow_status text NOT NULL DEFAULT 'pending_send'
    CHECK (escrow_status IN (
      'pending_send','sent_to_lender','received_by_lender','escrowed',
      'first_draw_requested','partial_release','final_release_complete','disputed'
    )),
  
  -- Draw tracking
  draw_stage integer NOT NULL DEFAULT 0,
  draw_amount_requested numeric(12,2) DEFAULT 0,
  draw_amount_released numeric(12,2) DEFAULT 0,
  holdback_amount numeric(12,2) DEFAULT 0,
  total_escrowed numeric(12,2) DEFAULT 0,
  
  -- Follow-up tracking
  follow_up_date date,
  follow_up_count integer DEFAULT 0,
  last_contact_at timestamptz,
  
  -- Notes
  notes text,
  
  -- Metadata
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Release history (each draw/release event)
CREATE TABLE public.loss_draft_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loss_draft_id uuid NOT NULL REFERENCES public.loss_draft_tracking(id) ON DELETE CASCADE,
  draw_number integer NOT NULL,
  amount_requested numeric(12,2) NOT NULL DEFAULT 0,
  amount_released numeric(12,2) DEFAULT 0,
  holdback_amount numeric(12,2) DEFAULT 0,
  release_date date,
  requested_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','approved','partial','denied','released')),
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Document checklist for each loss draft
CREATE TABLE public.loss_draft_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loss_draft_id uuid NOT NULL REFERENCES public.loss_draft_tracking(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  document_label text NOT NULL,
  is_required boolean NOT NULL DEFAULT true,
  is_submitted boolean NOT NULL DEFAULT false,
  submitted_at timestamptz,
  submitted_by uuid,
  file_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Audit log for loss draft actions
CREATE TABLE public.loss_draft_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loss_draft_id uuid NOT NULL REFERENCES public.loss_draft_tracking(id) ON DELETE CASCADE,
  action text NOT NULL,
  actor_id uuid,
  amount numeric(12,2),
  old_values jsonb,
  new_values jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_loss_draft_claim ON public.loss_draft_tracking(claim_id);
CREATE INDEX idx_loss_draft_status ON public.loss_draft_tracking(escrow_status);
CREATE INDEX idx_loss_draft_followup ON public.loss_draft_tracking(follow_up_date) WHERE follow_up_date IS NOT NULL;
CREATE INDEX idx_loss_draft_releases_draft ON public.loss_draft_releases(loss_draft_id);
CREATE INDEX idx_loss_draft_docs_draft ON public.loss_draft_documents(loss_draft_id);
CREATE INDEX idx_loss_draft_audit_draft ON public.loss_draft_audit_log(loss_draft_id);

-- RLS
ALTER TABLE public.loss_draft_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loss_draft_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loss_draft_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loss_draft_audit_log ENABLE ROW LEVEL SECURITY;

-- Staff/admin policies
CREATE POLICY "Staff can manage loss drafts" ON public.loss_draft_tracking
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff can manage loss draft releases" ON public.loss_draft_releases
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff can manage loss draft documents" ON public.loss_draft_documents
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff can view loss draft audit" ON public.loss_draft_audit_log
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "System can insert loss draft audit" ON public.loss_draft_audit_log
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

-- Read-only users can view
CREATE POLICY "Read-only can view loss drafts" ON public.loss_draft_tracking
  FOR SELECT TO authenticated
  USING (public.is_read_only(auth.uid()));

CREATE POLICY "Read-only can view releases" ON public.loss_draft_releases
  FOR SELECT TO authenticated
  USING (public.is_read_only(auth.uid()));

CREATE POLICY "Read-only can view draft docs" ON public.loss_draft_documents
  FOR SELECT TO authenticated
  USING (public.is_read_only(auth.uid()));

-- Dashboard view
CREATE OR REPLACE VIEW public.loss_draft_dashboard AS
SELECT
  ld.id,
  ld.claim_id,
  c.claim_number,
  c.policyholder_name,
  c.insurance_company,
  ld.mortgage_servicer,
  ld.escrow_status,
  ld.total_escrowed,
  ld.draw_amount_released,
  ld.holdback_amount,
  (ld.total_escrowed - ld.draw_amount_released) AS unreleased_amount,
  ld.draw_stage,
  ld.follow_up_date,
  ld.follow_up_count,
  ld.last_contact_at,
  ld.check_sent_date,
  ld.check_received_date,
  ld.created_at,
  ld.updated_at,
  -- Aging: days since escrowed
  CASE WHEN ld.check_received_date IS NOT NULL
    THEN CURRENT_DATE - ld.check_received_date
    ELSE NULL
  END AS days_in_escrow,
  -- Missing required docs count
  (SELECT COUNT(*) FROM loss_draft_documents ldd
   WHERE ldd.loss_draft_id = ld.id AND ldd.is_required = true AND ldd.is_submitted = false
  ) AS missing_docs_count,
  -- Stale flag (no contact in 14+ days, still has unreleased funds)
  CASE WHEN ld.last_contact_at IS NOT NULL
    AND ld.last_contact_at < (now() - interval '14 days')
    AND (ld.total_escrowed - ld.draw_amount_released) > 0
    THEN true ELSE false
  END AS is_stale
FROM loss_draft_tracking ld
JOIN claims c ON c.id = ld.claim_id;

-- RPC for loss draft action with audit
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
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_ld FROM loss_draft_tracking WHERE id = p_loss_draft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loss draft not found'; END IF;

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
      UPDATE loss_draft_tracking SET
        escrow_status = v_new_status,
        draw_amount_released = v_ld.draw_amount_released + COALESCE(p_amount, 0),
        holdback_amount = GREATEST(0, v_ld.total_escrowed - v_ld.draw_amount_released - COALESCE(p_amount, 0)),
        last_contact_at = now(),
        updated_at = now()
      WHERE id = p_loss_draft_id;

      -- Update latest release record
      UPDATE loss_draft_releases SET
        amount_released = COALESCE(p_amount, 0),
        released_at = now(),
        release_date = CURRENT_DATE,
        status = 'released'
      WHERE loss_draft_id = p_loss_draft_id
        AND draw_number = v_ld.draw_stage
        AND status != 'released';

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

  -- Increment follow-up count on contact
  IF p_action IN ('request_draw', 'record_release', 'mark_escrowed', 'mark_final_release') THEN
    UPDATE loss_draft_tracking SET follow_up_count = follow_up_count + 1 WHERE id = p_loss_draft_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'action', p_action, 'release_id', v_release_id);
END;
$$;

-- RPC to initialize standard document checklist
CREATE OR REPLACE FUNCTION public.init_loss_draft_documents(p_loss_draft_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO loss_draft_documents (loss_draft_id, document_type, document_label, is_required)
  VALUES
    (p_loss_draft_id, 'endorsed_check', 'Endorsed Insurance Check', true),
    (p_loss_draft_id, 'contractor_estimate', 'Contractor Estimate / Scope of Work', true),
    (p_loss_draft_id, 'signed_contract', 'Signed Repair Contract', true),
    (p_loss_draft_id, 'w9', 'Contractor W-9', true),
    (p_loss_draft_id, 'certificate_completion', 'Certificate of Completion', true),
    (p_loss_draft_id, 'inspection_report', 'Lender Inspection Report', true),
    (p_loss_draft_id, 'photos_before', 'Before Photos', true),
    (p_loss_draft_id, 'photos_progress', 'Progress Photos', false),
    (p_loss_draft_id, 'photos_after', 'After / Completion Photos', true),
    (p_loss_draft_id, 'lien_waiver', 'Lien Waiver', false),
    (p_loss_draft_id, 'adjuster_report', 'Insurance Adjuster Report', false)
  ON CONFLICT DO NOTHING;
END;
$$;

-- Dashboard counts RPC
CREATE OR REPLACE FUNCTION public.get_loss_draft_dashboard_counts()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT has_role(auth.uid(), 'staff') AND NOT has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  
  SELECT jsonb_build_object(
    'total_active', COUNT(*) FILTER (WHERE escrow_status NOT IN ('final_release_complete')),
    'pending_send', COUNT(*) FILTER (WHERE escrow_status = 'pending_send'),
    'escrowed', COUNT(*) FILTER (WHERE escrow_status = 'escrowed'),
    'draw_requested', COUNT(*) FILTER (WHERE escrow_status = 'first_draw_requested'),
    'partial_release', COUNT(*) FILTER (WHERE escrow_status = 'partial_release'),
    'final_complete', COUNT(*) FILTER (WHERE escrow_status = 'final_release_complete'),
    'total_unreleased', COALESCE(SUM(total_escrowed - draw_amount_released) FILTER (WHERE escrow_status NOT IN ('final_release_complete')), 0),
    'stale_count', COUNT(*) FILTER (WHERE last_contact_at < now() - interval '14 days' AND escrow_status NOT IN ('final_release_complete','pending_send')),
    'overdue_followup', COUNT(*) FILTER (WHERE follow_up_date < CURRENT_DATE AND escrow_status NOT IN ('final_release_complete'))
  ) INTO result
  FROM loss_draft_tracking;
  
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.loss_draft_tracking;
