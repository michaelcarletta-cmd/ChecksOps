-- Tenant-scoped loss draft dashboard view and counts
-- Loss drafts inherit tenant from their linked check_intake_item.
-- Loss drafts without a check fall back to system tenant (Freedom Claims).

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
  (SELECT count(*) FROM loss_draft_documents ldd
     WHERE ldd.loss_draft_id = ld.id AND ldd.is_required = true AND ldd.is_submitted = false) AS missing_docs_count,
  CASE
    WHEN ld.last_contact_at IS NOT NULL 
      AND ld.last_contact_at < (now() - '14 days'::interval) 
      AND (ld.total_escrowed - ld.draw_amount_released) > 0::numeric THEN true
    ELSE false
  END AS is_stale,
  -- Tenant scoping: prefer linked check's tenant, fallback to system tenant
  COALESCE(
    ci.tenant_id,
    (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)
  ) AS tenant_id
FROM loss_draft_tracking ld
JOIN claims c ON c.id = ld.claim_id
LEFT JOIN check_intake_items ci ON ci.id = ld.check_intake_item_id;

-- Update counts function to be tenant-scoped
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
      COALESCE(ci.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)) AS resolved_tenant_id
    FROM public.loss_draft_tracking ld
    LEFT JOIN public.check_intake_items ci ON ci.id = ld.check_intake_item_id
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
      WHERE lt2.escrow_status NOT IN ('final_release_complete')
        AND ldd.is_required = true
        AND ldd.is_received = false
        AND COALESCE(ci2.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)) = _tenant_id
    ),
    'checks_ready_for_release', (
      SELECT COUNT(*) FROM public.loss_draft_tracking lt3
      LEFT JOIN public.check_intake_items ci3 ON ci3.id = lt3.check_intake_item_id
      WHERE lt3.escrow_status NOT IN ('final_release_complete')
        AND COALESCE(ci3.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)) = _tenant_id
        AND NOT EXISTS (
          SELECT 1 FROM public.loss_draft_documents ldd2
          WHERE ldd2.loss_draft_id = lt3.id
            AND ldd2.is_required = true
            AND ldd2.is_received = false
        )
    )
  ) INTO result
  FROM scoped
  WHERE resolved_tenant_id = _tenant_id;

  RETURN COALESCE(result, '{}'::jsonb);
END;
$function$;