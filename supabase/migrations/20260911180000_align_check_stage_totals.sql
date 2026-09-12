-- Staging/production-safe: replace get_check_stage_totals so badge counts
-- match Check Command Center row filters. Does NOT rewrite existing rows.
-- Do not add a CHECK constraint here: inconsistent production rows must be
-- reported first (get_inconsistent_check_status_stages / AWS read RPC).

CREATE OR REPLACE FUNCTION public.get_check_stage_totals(p_tenant_id uuid)
RETURNS TABLE(stage text, count bigint, total_amount numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH membership AS (
    SELECT 1
    FROM public.tenant_users tu
    WHERE tu.tenant_id = p_tenant_id
      AND tu.user_id = auth.uid()
    UNION ALL
    SELECT 1
    WHERE public.is_master_owner()
  ),
  latest_checkalt AS (
    SELECT DISTINCT ON (d.check_intake_item_id)
      d.check_intake_item_id,
      d.status
    FROM public.checkalt_deposits d
    ORDER BY d.check_intake_item_id, COALESCE(d.updated_at, d.approved_at, d.submitted_at) DESC NULLS LAST
  ),
  base AS (
    SELECT
      c.id,
      c.status,
      c.check_stage::text AS check_stage,
      c.deposit_recommendation,
      c.ocr_status,
      COALESCE(c.amount, 0) AS amount,
      ca.status AS checkalt_status
    FROM public.check_intake_items c
    LEFT JOIN latest_checkalt ca ON ca.check_intake_item_id = c.id
    WHERE c.tenant_id = p_tenant_id
      AND EXISTS (SELECT 1 FROM membership)
  )
  SELECT 'review'::text, COUNT(*)::bigint, COALESCE(SUM(amount), 0)::numeric
  FROM base
  WHERE check_stage IS DISTINCT FROM 'loss_draft'
    AND check_stage IS DISTINCT FROM 'deposited'
    AND check_stage IS DISTINCT FROM 'endorsing'
    AND check_stage IS DISTINCT FROM 'funds_released'
    AND check_stage IS DISTINCT FROM 'disbursed_externally'
    AND status IS DISTINCT FROM 'loss_draft_required'
    AND status IS DISTINCT FROM 'reissue_requested'
    AND status IS DISTINCT FROM 'branch_deposit_required'
    AND status IS DISTINCT FROM 'deposited'
    AND status IS DISTINCT FROM 'endorsements_in_progress'
    AND status IS DISTINCT FROM 'approved_for_deposit'
    AND (
      check_stage = 'review'
      OR status IN ('needs_review', 'manual_review_required', 'endorsements_complete', 'uploaded')
      OR deposit_recommendation = 'branch_deposit_recommended'
      OR ocr_status = 'failed'
    )
  UNION ALL
  SELECT 'endorsing', COUNT(*)::bigint, COALESCE(SUM(amount), 0)::numeric
  FROM base
  WHERE status = 'endorsements_in_progress'
  UNION ALL
  SELECT 'ready', COUNT(*)::bigint, COALESCE(SUM(amount), 0)::numeric
  FROM base
  WHERE check_stage IS DISTINCT FROM 'deposited'
    AND checkalt_status IS DISTINCT FROM 'pending_approval'
    AND (
      status = 'approved_for_deposit'
      OR (deposit_recommendation = 'ready_for_deposit' AND status IS DISTINCT FROM 'deposited')
    )
  UNION ALL
  SELECT 'deposited', COUNT(*)::bigint, COALESCE(SUM(amount), 0)::numeric
  FROM base
  WHERE check_stage IS DISTINCT FROM 'funds_released'
    AND check_stage IS DISTINCT FROM 'disbursed_externally'
    AND (
      status = 'deposited'
      OR check_stage = 'deposited'
      OR checkalt_status = 'pending_approval'
    )
  UNION ALL
  SELECT 'reissue', COUNT(*)::bigint, COALESCE(SUM(amount), 0)::numeric
  FROM base
  WHERE status = 'reissue_requested'
  UNION ALL
  SELECT 'lossdraft', COUNT(*)::bigint, COALESCE(SUM(amount), 0)::numeric
  FROM base
  WHERE check_stage = 'loss_draft' OR status = 'loss_draft_required'
  UNION ALL
  SELECT 'funds_released', COUNT(*)::bigint, COALESCE(SUM(ds.amount), 0)::numeric
  FROM public.disbursement_splits ds
  WHERE ds.tenant_id = p_tenant_id
    AND ds.status = 'settled'
    AND EXISTS (SELECT 1 FROM membership)
  UNION ALL
  SELECT 'lossdraft_active', COUNT(*)::bigint, 0::numeric
  FROM public.loss_draft_tracking ld
  JOIN public.check_intake_items ci ON ci.id = ld.check_intake_item_id
  WHERE ci.tenant_id = p_tenant_id
    AND EXISTS (SELECT 1 FROM membership)
    AND ld.escrow_status IS DISTINCT FROM 'final_release_complete'
    AND ld.escrow_status IS DISTINCT FROM 'endorsing';
$function$;

GRANT EXECUTE ON FUNCTION public.get_check_stage_totals(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_check_stage_totals(uuid) TO service_role;

COMMENT ON FUNCTION public.get_check_stage_totals(uuid) IS
  'Check Center lane totals. Independent filters match the rows shown in each queue. Does not rewrite rows.';
