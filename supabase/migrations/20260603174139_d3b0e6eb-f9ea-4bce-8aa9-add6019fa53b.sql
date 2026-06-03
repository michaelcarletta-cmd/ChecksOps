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

  WITH auth_tenants AS (
    -- The tenant being queried
    SELECT _tenant_id AS tenant_id
  ),
  scoped AS (
    SELECT ld.*, 
      ci.status AS check_status,
      auth_t.tenant_id as resolved_tenant_id
    FROM public.loss_draft_tracking ld
    LEFT JOIN public.check_intake_items ci ON ci.id = ld.check_intake_item_id
    CROSS JOIN LATERAL (
       -- Either the original owner matches
       SELECT COALESCE(ci.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)) AS tenant_id
       UNION
       -- Or it was shared with this tenant
       SELECT sc.target_tenant_id FROM public.shared_checks sc WHERE sc.check_id = ci.id AND sc.revoked_at IS NULL
    ) auth_t
    WHERE auth_t.tenant_id = _tenant_id
      AND NOT (
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
    'checks_blocked_in_lender', (
      SELECT COUNT(*) 
      FROM public.check_intake_items ci_inner
      LEFT JOIN auth_tenants at ON true
      WHERE ci_inner.status = 'loss_draft_required' 
        AND (
          ci_inner.tenant_id = at.tenant_id
          OR EXISTS (
            SELECT 1 FROM public.shared_checks sc 
            WHERE sc.check_id = ci_inner.id 
              AND sc.target_tenant_id = at.tenant_id 
              AND sc.revoked_at IS NULL
          )
        )
    ),
    'checks_awaiting_docs',     (
      SELECT COUNT(DISTINCT lt2.id)
      FROM public.loss_draft_tracking lt2
      LEFT JOIN public.check_intake_items ci2 ON ci2.id = lt2.check_intake_item_id
      JOIN public.loss_draft_documents ldd ON ldd.loss_draft_id = lt2.id
      CROSS JOIN LATERAL (
        SELECT COALESCE(ci2.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)) AS t_id
        UNION
        SELECT sc2.target_tenant_id FROM public.shared_checks sc2 WHERE sc2.check_id = ci2.id AND sc2.revoked_at IS NULL
      ) auth_t2
      WHERE lt2.escrow_status NOT IN ('final_release_complete','endorsing')
        AND NOT (lt2.monitoring_type = 'not_monitored' AND ci2.status IN ('endorsements_in_progress', 'approved_for_deposit', 'deposited'))
        AND ldd.is_required = true
        AND ldd.is_submitted = false
        AND auth_t2.t_id = _tenant_id
    ),
    'checks_ready_for_release', (
      SELECT COUNT(*) FROM public.loss_draft_tracking lt3
      LEFT JOIN public.check_intake_items ci3 ON ci3.id = lt3.check_intake_item_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(ci3.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)) AS t_id
        UNION
        SELECT sc3.target_tenant_id FROM public.shared_checks sc3 WHERE sc3.check_id = ci3.id AND sc3.revoked_at IS NULL
      ) auth_t3
      WHERE lt3.escrow_status NOT IN ('final_release_complete','endorsing')
        AND NOT (lt3.monitoring_type = 'not_monitored' AND ci3.status IN ('endorsements_in_progress', 'approved_for_deposit', 'deposited'))
        AND auth_t3.t_id = _tenant_id
        AND NOT EXISTS (
          SELECT 1 FROM public.loss_draft_documents ldd2
          WHERE ldd2.loss_draft_id = lt3.id
            AND ldd2.is_required = true
            AND ldd2.is_submitted = false
        )
    )
  ) INTO result FROM scoped;

  RETURN result;
END;
$function$
