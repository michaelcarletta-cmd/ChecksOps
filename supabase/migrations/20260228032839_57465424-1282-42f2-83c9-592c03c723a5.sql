
-- Update portfolio_intelligence to exclude suspended from at-risk %
DROP MATERIALIZED VIEW IF EXISTS public.portfolio_intelligence;
CREATE MATERIALIZED VIEW public.portfolio_intelligence AS
SELECT
  COUNT(*) FILTER (WHERE NOT is_closed AND automation_mode NOT IN ('closed', 'suspended')) AS total_active_claims,
  COALESCE(SUM(claim_amount) FILTER (WHERE NOT is_closed AND automation_mode != 'closed'), 0) -
    COALESCE((SELECT SUM(cc.amount) FROM claim_checks cc JOIN claims c2 ON cc.claim_id = c2.id WHERE NOT c2.is_closed AND c2.automation_mode != 'closed'), 0) AS total_outstanding_gap,
  0 AS total_unreleased_depreciation,
  ROUND(
    (AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400) FILTER (WHERE NOT is_closed AND automation_mode NOT IN ('closed', 'suspended')))::numeric
  , 1) AS avg_days_open,
  COUNT(*) FILTER (WHERE status = 'Denied' AND NOT is_closed AND automation_mode NOT IN ('closed', 'suspended')) AS denied_claims,
  ROUND(
    (COUNT(*) FILTER (WHERE status = 'Denied' AND NOT is_closed AND automation_mode NOT IN ('closed', 'suspended'))::numeric /
     NULLIF(COUNT(*) FILTER (WHERE NOT is_closed AND automation_mode NOT IN ('closed', 'suspended')), 0) * 100), 1
  ) AS pct_at_risk
FROM claims;

-- Recreate dependent RPC
CREATE OR REPLACE FUNCTION public.get_portfolio_intelligence()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') AND NOT public.has_role(auth.uid(), 'staff') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT row_to_json(pi.*) INTO result FROM public.portfolio_intelligence pi LIMIT 1;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;
