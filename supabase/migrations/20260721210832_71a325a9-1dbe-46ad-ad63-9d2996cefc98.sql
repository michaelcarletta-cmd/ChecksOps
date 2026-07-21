
CREATE INDEX IF NOT EXISTS idx_cii_tenant_review
  ON public.check_intake_items (tenant_id, created_at DESC)
  WHERE status IN ('needs_review','manual_review_required','endorsements_complete','uploaded')
     OR deposit_recommendation = 'branch_deposit_recommended'
     OR ocr_status = 'failed';

CREATE INDEX IF NOT EXISTS idx_cii_tenant_endorsing
  ON public.check_intake_items (tenant_id, created_at DESC)
  WHERE status = 'endorsements_in_progress' OR check_stage = 'endorsing'::check_stage;

CREATE INDEX IF NOT EXISTS idx_cii_tenant_ready
  ON public.check_intake_items (tenant_id, created_at DESC)
  WHERE status = 'approved_for_deposit' OR deposit_recommendation = 'ready_for_deposit';

CREATE INDEX IF NOT EXISTS idx_cii_tenant_deposited
  ON public.check_intake_items (tenant_id, created_at DESC)
  WHERE status = 'deposited' OR check_stage = 'deposited'::check_stage;

CREATE INDEX IF NOT EXISTS idx_cii_tenant_lossdraft
  ON public.check_intake_items (tenant_id, created_at DESC)
  WHERE status = 'loss_draft_required' OR check_stage = 'loss_draft'::check_stage;

CREATE INDEX IF NOT EXISTS idx_cii_tenant_reissue
  ON public.check_intake_items (tenant_id, created_at DESC)
  WHERE status = 'reissue_requested';

CREATE INDEX IF NOT EXISTS idx_cii_tenant_branch
  ON public.check_intake_items (tenant_id, created_at DESC)
  WHERE status = 'branch_deposit_required';

CREATE OR REPLACE FUNCTION public.get_check_stage_totals(p_tenant_id uuid)
RETURNS TABLE (
  stage text,
  count bigint,
  total_amount numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      c.id,
      c.status,
      c.check_stage::text AS check_stage,
      c.deposit_recommendation,
      c.ocr_status,
      COALESCE(c.amount, 0) AS amount
    FROM public.check_intake_items c
    WHERE c.tenant_id = p_tenant_id
      AND EXISTS (
        SELECT 1 FROM public.tenant_users tu
        WHERE tu.tenant_id = p_tenant_id AND tu.user_id = auth.uid()
      )
  ),
  bucketed AS (
    SELECT id, amount,
      CASE
        WHEN status = 'deposited' OR check_stage = 'deposited' THEN 'deposited'
        WHEN check_stage = 'funds_released' THEN 'funds_released'
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
$$;

GRANT EXECUTE ON FUNCTION public.get_check_stage_totals(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_check_stage_totals(uuid) TO service_role;
