
CREATE OR REPLACE FUNCTION public.get_loss_draft_dashboard_counts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT has_role(auth.uid(), 'staff') AND NOT has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

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
    'checks_blocked_in_lender', (SELECT COUNT(*) FROM public.check_intake_items WHERE status = 'loss_draft_required'),
    'checks_awaiting_docs',     (
      SELECT COUNT(DISTINCT lt2.id)
      FROM public.loss_draft_tracking lt2
      JOIN public.loss_draft_documents ldd ON ldd.loss_draft_id = lt2.id
      WHERE lt2.escrow_status NOT IN ('final_release_complete')
        AND ldd.is_required = true
        AND ldd.is_received = false
    ),
    'checks_ready_for_release', (
      SELECT COUNT(*) FROM public.loss_draft_tracking lt3
      WHERE lt3.escrow_status NOT IN ('final_release_complete')
        AND NOT EXISTS (
          SELECT 1 FROM public.loss_draft_documents ldd2
          WHERE ldd2.loss_draft_id = lt3.id
            AND ldd2.is_required = true
            AND ldd2.is_received = false
        )
    )
  ) INTO result
  FROM public.loss_draft_tracking;

  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;
