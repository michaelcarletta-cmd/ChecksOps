-- 1. Add Shipping Label to the document init function + back-fill existing records
CREATE OR REPLACE FUNCTION public.init_loss_draft_documents(p_loss_draft_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.loss_draft_documents (loss_draft_id, document_type, document_label, is_required)
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
    (p_loss_draft_id, 'adjuster_report', 'Insurance Adjuster Report', false),
    (p_loss_draft_id, 'shipping_label', 'Shipping Label', false)
  ON CONFLICT DO NOTHING;
END;
$function$;

-- Back-fill Shipping Label for existing loss drafts
INSERT INTO public.loss_draft_documents (loss_draft_id, document_type, document_label, is_required)
SELECT ld.id, 'shipping_label', 'Shipping Label', false
FROM public.loss_draft_tracking ld
WHERE NOT EXISTS (
  SELECT 1 FROM public.loss_draft_documents ldd
  WHERE ldd.loss_draft_id = ld.id AND ldd.document_type = 'shipping_label'
);

-- 2. loss_draft_set_lender RPC
CREATE OR REPLACE FUNCTION public.loss_draft_set_lender(
  p_loss_draft_id uuid,
  p_lender_name text,
  p_actor_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_draft public.loss_draft_tracking%ROWTYPE;
  v_lender_name text;
  v_mortgage_company_id uuid;
  v_tenant_id uuid;
BEGIN
  SELECT * INTO v_draft
  FROM public.loss_draft_tracking
  WHERE id = p_loss_draft_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loss draft record not found';
  END IF;

  SELECT COALESCE(ci.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1))
  INTO v_tenant_id
  FROM public.loss_draft_tracking ld
  LEFT JOIN public.check_intake_items ci ON ci.id = ld.check_intake_item_id
  WHERE ld.id = p_loss_draft_id;

  IF NOT public.has_role(auth.uid(), 'admin')
     AND NOT public.has_role(auth.uid(), 'staff')
     AND NOT public.is_tenant_member(auth.uid(), v_tenant_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_lender_name := NULLIF(BTRIM(p_lender_name), '');
  IF v_lender_name IS NULL THEN
    RAISE EXCEPTION 'Lender name is required';
  END IF;

  SELECT id INTO v_mortgage_company_id
  FROM public.mortgage_companies
  WHERE lower(name) = lower(v_lender_name)
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_mortgage_company_id IS NULL THEN
    INSERT INTO public.mortgage_companies (name, is_active)
    VALUES (v_lender_name, true)
    RETURNING id INTO v_mortgage_company_id;
  END IF;

  UPDATE public.claims
  SET mortgage_company_id = v_mortgage_company_id,
      updated_at = now()
  WHERE id = v_draft.claim_id;

  UPDATE public.loss_draft_tracking
  SET mortgage_servicer = v_lender_name,
      updated_at = now()
  WHERE id = p_loss_draft_id;

  INSERT INTO public.loss_draft_audit_log (loss_draft_id, action, actor_id, notes, new_values)
  VALUES (
    p_loss_draft_id,
    'set_lender',
    COALESCE(p_actor_id, auth.uid()),
    'Lender updated manually',
    jsonb_build_object('mortgage_servicer', v_lender_name, 'mortgage_company_id', v_mortgage_company_id)
  );
END;
$function$;

-- 3. Update loss_draft_action: not-monitored send_for_endorsements goes to final_release_complete
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
  v_target_status text;
  v_release_id uuid;
  v_check_id uuid;
BEGIN
  SELECT * INTO v_draft FROM public.loss_draft_tracking WHERE id = p_loss_draft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loss draft record not found'; END IF;

  IF p_action = 'set_monitoring_type' THEN
    UPDATE public.loss_draft_tracking
      SET monitoring_type = COALESCE(p_extra->>'monitoring_type', 'monitored'),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'mark_sent' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'sent_to_lender',
          check_sent_date = now()::date,
          tracking_number_sent = COALESCE(p_extra->>'tracking_number', tracking_number_sent),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'mark_received_back' THEN
    UPDATE public.loss_draft_tracking
      SET check_received_back_date = now()::date,
          escrow_status = 'check_received_back',
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'send_for_endorsements' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = CASE WHEN v_draft.monitoring_type = 'not_monitored' THEN 'final_release_complete' ELSE 'endorsing' END,
          updated_at = now()
    WHERE id = p_loss_draft_id;

    v_check_id := v_draft.check_intake_item_id;
    IF v_check_id IS NULL THEN
      SELECT ci.id INTO v_check_id
      FROM public.check_intake_items ci
      WHERE ci.claim_id = v_draft.claim_id
      ORDER BY ci.created_at DESC
      LIMIT 1;
    END IF;

    IF v_check_id IS NOT NULL THEN
      UPDATE public.check_intake_items
        SET status = 'endorsements_in_progress',
            mortgage_received_at = COALESCE(mortgage_received_at, now()),
            updated_at = now()
      WHERE id = v_check_id;
    END IF;

  ELSIF p_action = 'mark_received' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'escrowed',
          total_escrowed = COALESCE(p_amount, total_escrowed),
          check_received_date = now()::date,
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'mark_escrowed' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'escrowed',
          total_escrowed = COALESCE(p_amount, total_escrowed),
          check_received_date = COALESCE(check_received_date, now()::date),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'request_draw' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'first_draw_requested',
          draw_stage = draw_stage + 1,
          draw_amount_requested = COALESCE(p_amount, 0),
          updated_at = now()
    WHERE id = p_loss_draft_id;

    INSERT INTO public.loss_draft_releases (loss_draft_id, draw_number, amount_requested, status)
    VALUES (p_loss_draft_id, v_draft.draw_stage + 1, COALESCE(p_amount, 0), 'requested');

  ELSIF p_action = 'record_release' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'partial_release',
          draw_amount_released = draw_amount_released + COALESCE(p_amount, 0),
          updated_at = now()
    WHERE id = p_loss_draft_id;

    SELECT id INTO v_release_id
    FROM public.loss_draft_releases
    WHERE loss_draft_id = p_loss_draft_id AND status = 'requested'
    ORDER BY draw_number DESC
    LIMIT 1;

    IF v_release_id IS NOT NULL THEN
      UPDATE public.loss_draft_releases
        SET status = 'released',
            amount_released = COALESCE(p_amount, 0),
            released_at = now()
      WHERE id = v_release_id;
    END IF;

  ELSIF p_action = 'record_holdback' THEN
    UPDATE public.loss_draft_tracking
      SET holdback_amount = holdback_amount + COALESCE(p_amount, 0),
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSIF p_action = 'mark_final_release' THEN
    UPDATE public.loss_draft_tracking
      SET escrow_status = 'final_release_complete',
          updated_at = now()
    WHERE id = p_loss_draft_id;

    v_check_id := v_draft.check_intake_item_id;
    IF v_check_id IS NULL THEN
      SELECT ci.id INTO v_check_id
      FROM public.check_intake_items ci
      WHERE ci.claim_id = v_draft.claim_id
      ORDER BY ci.created_at DESC
      LIMIT 1;
    END IF;

    IF v_check_id IS NOT NULL THEN
      UPDATE public.check_intake_items
        SET status = 'approved_for_deposit',
            mortgage_final_released_at = COALESCE(mortgage_final_released_at, now()),
            updated_at = now()
      WHERE id = v_check_id;
    END IF;

  ELSIF p_action = 'admin_reset_status' THEN
    v_target_status := p_extra->>'target_status';
    IF v_target_status IS NULL THEN
      RAISE EXCEPTION 'target_status is required for admin_reset_status';
    END IF;

    UPDATE public.loss_draft_tracking
      SET escrow_status = v_target_status,
          check_sent_date = CASE WHEN v_target_status = 'pending_send' THEN NULL ELSE check_sent_date END,
          check_received_date = CASE WHEN v_target_status IN ('pending_send','sent_to_lender') THEN NULL ELSE check_received_date END,
          check_received_back_date = CASE WHEN v_target_status IN ('pending_send','sent_to_lender','received_by_lender') THEN NULL ELSE check_received_back_date END,
          tracking_number_sent = CASE WHEN v_target_status = 'pending_send' THEN NULL ELSE tracking_number_sent END,
          updated_at = now()
    WHERE id = p_loss_draft_id;

  ELSE
    RAISE EXCEPTION 'Unknown action: %', p_action;
  END IF;

  INSERT INTO public.loss_draft_audit_log (loss_draft_id, action, actor_id, amount, notes, new_values)
  VALUES (p_loss_draft_id, p_action, p_actor_id, p_amount, p_notes, p_extra);
END;
$function$;

-- 4. Updated dashboard view: excludes endorsing + non-monitored downstream checks; falls back to claim's mortgage company name
CREATE OR REPLACE VIEW public.loss_draft_dashboard AS
SELECT
  ld.id,
  ld.claim_id,
  c.claim_number,
  c.policyholder_name,
  c.insurance_company,
  CASE
    WHEN NULLIF(BTRIM(ld.mortgage_servicer), '') IS NULL
      OR lower(BTRIM(ld.mortgage_servicer)) IN ('unknown lender', 'unknown servicer', 'unknown')
    THEN COALESCE(mc.name, ld.mortgage_servicer)
    ELSE ld.mortgage_servicer
  END AS mortgage_servicer,
  ld.escrow_status,
  ld.total_escrowed,
  ld.draw_amount_released,
  ld.holdback_amount,
  ld.total_escrowed - ld.draw_amount_released AS unreleased_amount,
  ld.draw_stage,
  ld.follow_up_date,
  ld.follow_up_count,
  ld.last_contact_at,
  ld.check_sent_date,
  ld.check_received_date,
  ld.created_at,
  ld.updated_at,
  CASE
    WHEN ld.check_received_date IS NOT NULL THEN CURRENT_DATE - ld.check_received_date
    ELSE NULL::integer
  END AS days_in_escrow,
  (
    SELECT count(*) AS count
    FROM public.loss_draft_documents ldd
    WHERE ldd.loss_draft_id = ld.id
      AND ldd.is_required = true
      AND ldd.is_submitted = false
  ) AS missing_docs_count,
  CASE
    WHEN ld.last_contact_at IS NOT NULL
      AND ld.last_contact_at < (now() - '14 days'::interval)
      AND (ld.total_escrowed - ld.draw_amount_released) > 0::numeric
    THEN true
    ELSE false
  END AS is_stale,
  COALESCE(ci.tenant_id, (SELECT tenants.id FROM public.tenants WHERE tenants.is_system_tenant = true LIMIT 1)) AS tenant_id,
  ld.monitoring_type,
  ci.status AS check_status
FROM public.loss_draft_tracking ld
JOIN public.claims c ON c.id = ld.claim_id
LEFT JOIN public.mortgage_companies mc ON mc.id = c.mortgage_company_id
LEFT JOIN public.check_intake_items ci ON ci.id = ld.check_intake_item_id
WHERE NOT (
  ld.escrow_status = 'endorsing'
  OR (
    ld.monitoring_type = 'not_monitored'
    AND ci.status IN ('endorsements_in_progress', 'approved_for_deposit', 'deposited')
  )
);

-- 5. Updated counts function with same exclusion rules
CREATE OR REPLACE FUNCTION public.get_loss_draft_dashboard_counts_for_tenant(_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE result jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin')
     AND NOT public.has_role(auth.uid(), 'staff')
     AND NOT public.is_tenant_member(auth.uid(), _tenant_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  WITH scoped AS (
    SELECT ld.*,
      ci.status AS check_status,
      COALESCE(ci.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)) AS resolved_tenant_id
    FROM public.loss_draft_tracking ld
    LEFT JOIN public.check_intake_items ci ON ci.id = ld.check_intake_item_id
    WHERE NOT (
      ld.escrow_status = 'endorsing'
      OR (
        ld.monitoring_type = 'not_monitored'
        AND ci.status IN ('endorsements_in_progress', 'approved_for_deposit', 'deposited')
      )
    )
  )
  SELECT jsonb_build_object(
    'total_active',             COUNT(*) FILTER (WHERE escrow_status NOT IN ('final_release_complete')),
    'pending_send',             COUNT(*) FILTER (WHERE escrow_status = 'pending_send'),
    'escrowed',                 COUNT(*) FILTER (WHERE escrow_status = 'escrowed'),
    'draw_requested',           COUNT(*) FILTER (WHERE escrow_status = 'first_draw_requested'),
    'partial_release',          COUNT(*) FILTER (WHERE escrow_status = 'partial_release'),
    'final_complete',           COUNT(*) FILTER (WHERE escrow_status = 'final_release_complete'),
    'total_unreleased',         COALESCE(SUM(total_escrowed - draw_amount_released) FILTER (WHERE escrow_status NOT IN ('final_release_complete')), 0),
    'stale_count',              COUNT(*) FILTER (WHERE last_contact_at < now() - interval '14 days' AND escrow_status NOT IN ('final_release_complete','pending_send')),
    'overdue_followup',         COUNT(*) FILTER (WHERE follow_up_date < CURRENT_DATE AND escrow_status NOT IN ('final_release_complete')),
    'checks_blocked_in_lender', (SELECT COUNT(*) FROM public.check_intake_items WHERE status = 'loss_draft_required' AND tenant_id = _tenant_id),
    'checks_awaiting_docs',     (
      SELECT COUNT(DISTINCT lt2.id)
      FROM public.loss_draft_tracking lt2
      LEFT JOIN public.check_intake_items ci2 ON ci2.id = lt2.check_intake_item_id
      JOIN public.loss_draft_documents ldd ON ldd.loss_draft_id = lt2.id
      WHERE lt2.escrow_status NOT IN ('final_release_complete','endorsing')
        AND NOT (lt2.monitoring_type = 'not_monitored' AND ci2.status IN ('endorsements_in_progress', 'approved_for_deposit', 'deposited'))
        AND ldd.is_required = true
        AND ldd.is_submitted = false
        AND COALESCE(ci2.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)) = _tenant_id
    ),
    'checks_ready_for_release', (
      SELECT COUNT(*) FROM public.loss_draft_tracking lt3
      LEFT JOIN public.check_intake_items ci3 ON ci3.id = lt3.check_intake_item_id
      WHERE lt3.escrow_status NOT IN ('final_release_complete','endorsing')
        AND NOT (lt3.monitoring_type = 'not_monitored' AND ci3.status IN ('endorsements_in_progress', 'approved_for_deposit', 'deposited'))
        AND COALESCE(ci3.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)) = _tenant_id
        AND NOT EXISTS (
          SELECT 1 FROM public.loss_draft_documents ldd2
          WHERE ldd2.loss_draft_id = lt3.id
            AND ldd2.is_required = true
            AND ldd2.is_submitted = false
        )
    )
  ) INTO result
  FROM scoped
  WHERE resolved_tenant_id = _tenant_id;

  RETURN COALESCE(result, '{}'::jsonb);
END;
$function$;