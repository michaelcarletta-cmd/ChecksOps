-- Partner-visible stage totals: owned checks + active shared_checks targets.
-- Does not change check_intake_items.tenant_id. Does not double-count.

CREATE OR REPLACE FUNCTION public.get_check_stage_totals(p_tenant_id uuid)
RETURNS TABLE(stage text, count bigint, total_amount numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT
      c.id,
      c.status,
      c.check_stage::text AS check_stage,
      c.deposit_recommendation,
      c.ocr_status,
      COALESCE(c.amount, 0) AS amount
    FROM public.check_intake_items c
    WHERE EXISTS (
        SELECT 1
        FROM public.tenant_users tu
        WHERE tu.tenant_id = p_tenant_id
          AND tu.user_id = auth.uid()
      )
      AND (
        c.tenant_id = p_tenant_id
        OR EXISTS (
          SELECT 1
          FROM public.shared_checks sc
          WHERE sc.check_id = c.id
            AND sc.target_tenant_id = p_tenant_id
            AND sc.revoked_at IS NULL
        )
      )
  ),
  bucketed AS (
    SELECT id, amount,
      CASE
        WHEN check_stage = 'funds_released' THEN 'funds_released'
        WHEN check_stage = 'deposited' THEN 'deposited'
        WHEN status = 'loss_draft_required' OR check_stage = 'loss_draft' THEN 'lossdraft'
        WHEN status = 'reissue_requested' THEN 'reissue'
        WHEN status = 'branch_deposit_required' THEN 'branch'
        WHEN status = 'approved_for_deposit'
             OR (deposit_recommendation = 'ready_for_deposit' AND status <> 'deposited') THEN 'ready'
        WHEN status = 'endorsements_in_progress' OR check_stage = 'endorsing' THEN 'endorsing'
        WHEN status IN ('needs_review','manual_review_required','endorsements_complete','uploaded')
             OR deposit_recommendation = 'branch_deposit_recommended'
             OR ocr_status = 'failed' THEN 'review'
        ELSE 'other'
      END AS bucket
    FROM base
  )
  SELECT bucket AS stage, COUNT(*)::bigint AS count, SUM(amount)::numeric AS total_amount
  FROM bucketed
  GROUP BY bucket;
$function$;

COMMENT ON FUNCTION public.get_check_stage_totals(uuid) IS
  'Per-lane counts for a tenant member: owned checks plus active shared_checks targets. No ownership transfer.';

GRANT EXECUTE ON FUNCTION public.get_check_stage_totals(uuid) TO checksops, authenticated;
