-- Ready-lane badge must not count checks that already have an authoritative
-- CheckAlt deposit. Function body only; no table or check_intake_items writes.

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
      COALESCE(c.amount, 0) AS amount,
      EXISTS (
        SELECT 1
        FROM public.checkalt_deposits d
        WHERE d.check_intake_item_id = c.id
          AND (
            d.checkalt_reference IS NOT NULL
            OR COALESCE(d.status_unresolved, false)
            OR d.status IN (
              'pending_approval', 'submitted', 'approved', 'processing',
              'deposited', 'cleared', 'settled', 'submitting'
            )
            OR COALESCE(d.last_status_payload->>'provider_http_attempted', '') = 'true'
            OR COALESCE(d.last_status_payload->>'uncertain', '') = 'true'
            OR COALESCE(d.last_status_payload->>'failure_class', '') IN (
              'provider_timeout', 'db_after_provider'
            )
          )
      ) AS checkalt_submitted
    FROM public.check_intake_items c
    WHERE c.tenant_id = p_tenant_id
      AND EXISTS (
        SELECT 1
        FROM public.tenant_users tu
        WHERE tu.tenant_id = p_tenant_id
          AND tu.user_id = auth.uid()
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
        WHEN checkalt_submitted THEN 'deposited'
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
