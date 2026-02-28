
DROP MATERIALIZED VIEW IF EXISTS public.portfolio_intelligence;
CREATE MATERIALIZED VIEW public.portfolio_intelligence AS
SELECT
  COUNT(*) FILTER (WHERE NOT is_closed AND automation_mode != 'closed') AS total_active_claims,
  COALESCE(SUM(claim_amount) FILTER (WHERE NOT is_closed AND automation_mode != 'closed'), 0) -
    COALESCE((SELECT SUM(cc.amount) FROM claim_checks cc JOIN claims c2 ON cc.claim_id = c2.id WHERE NOT c2.is_closed AND c2.automation_mode != 'closed'), 0) AS total_outstanding_gap,
  0 AS total_unreleased_depreciation,
  ROUND(
    (AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400) FILTER (WHERE NOT is_closed AND automation_mode != 'closed'))::numeric
  , 1) AS avg_days_open,
  COUNT(*) FILTER (WHERE status = 'Denied' AND NOT is_closed AND automation_mode != 'closed') AS denied_claims,
  ROUND(
    (COUNT(*) FILTER (WHERE status = 'Denied' AND NOT is_closed AND automation_mode != 'closed')::numeric /
     NULLIF(COUNT(*) FILTER (WHERE NOT is_closed AND automation_mode != 'closed'), 0) * 100), 1
  ) AS pct_at_risk
FROM claims;

DROP MATERIALIZED VIEW IF EXISTS public.portfolio_carrier_analytics;
CREATE MATERIALIZED VIEW public.portfolio_carrier_analytics AS
SELECT
  COALESCE(ic.name, c.insurance_company, 'Unknown') AS carrier,
  COUNT(*) AS total_claims,
  COUNT(*) FILTER (WHERE c.status = 'Denied') AS denied_count,
  ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - c.created_at)) / 86400)::numeric, 1) AS avg_days_open,
  COALESCE(SUM(c.claim_amount), 0) AS total_claimed,
  COALESCE(SUM(paid.total), 0) AS total_paid
FROM claims c
LEFT JOIN insurance_companies ic ON ic.id = c.insurance_company_id
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(cc.amount), 0) AS total FROM claim_checks cc WHERE cc.claim_id = c.id
) paid ON true
WHERE NOT c.is_closed AND c.automation_mode != 'closed'
GROUP BY COALESCE(ic.name, c.insurance_company, 'Unknown')
ORDER BY total_claims DESC;

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

CREATE OR REPLACE FUNCTION public.get_portfolio_carrier_analytics()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') AND NOT public.has_role(auth.uid(), 'staff') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT jsonb_agg(row_to_json(pca.*)) INTO result FROM public.portfolio_carrier_analytics pca;
  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;
