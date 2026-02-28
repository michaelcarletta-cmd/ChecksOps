
-- Portfolio intelligence materialized view (no depreciation column)
CREATE MATERIALIZED VIEW IF NOT EXISTS public.portfolio_intelligence AS
SELECT
  COUNT(*) AS total_claims,
  COUNT(*) FILTER (WHERE NOT c.is_closed AND c.status NOT IN ('Claim Settled', 'Dead File')) AS active_claims,
  COALESCE(SUM(c.claim_amount), 0) AS total_claimed,
  COALESCE(SUM(chk.total_paid), 0) AS total_paid,
  COALESCE(SUM(c.claim_amount) - SUM(COALESCE(chk.total_paid, 0)), 0) AS total_outstanding_gap,
  CASE WHEN SUM(GREATEST(1, EXTRACT(EPOCH FROM now() - c.created_at) / 86400)) > 0
    THEN ROUND(SUM(COALESCE(chk.total_paid, 0))::numeric / NULLIF(SUM(GREATEST(1, EXTRACT(EPOCH FROM now() - c.created_at) / 86400)), 0), 2)
    ELSE 0 END AS avg_payment_velocity,
  COUNT(*) FILTER (
    WHERE NOT c.is_closed 
    AND c.status NOT IN ('Claim Settled', 'Dead File')
    AND ms.state_json->>'health' = 'red'
  ) AS at_risk_count,
  CASE WHEN COUNT(*) FILTER (WHERE NOT c.is_closed AND c.status NOT IN ('Claim Settled', 'Dead File')) > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE NOT c.is_closed AND c.status NOT IN ('Claim Settled', 'Dead File') AND ms.state_json->>'health' = 'red')::numeric * 100.0 
      / COUNT(*) FILTER (WHERE NOT c.is_closed AND c.status NOT IN ('Claim Settled', 'Dead File')), 1)
    ELSE 0 END AS at_risk_pct,
  now() AS computed_at
FROM public.claims c
LEFT JOIN LATERAL (
  SELECT SUM(amount) AS total_paid FROM public.claim_checks WHERE claim_id = c.id
) chk ON true
LEFT JOIN public.claim_master_state ms ON ms.claim_id = c.id;

-- Carrier-level portfolio analytics
CREATE MATERIALIZED VIEW IF NOT EXISTS public.portfolio_carrier_analytics AS
SELECT
  COALESCE(c.insurance_company, 'Unknown') AS carrier_name,
  COUNT(*) AS total_claims,
  COUNT(*) FILTER (WHERE NOT c.is_closed AND c.status NOT IN ('Claim Settled', 'Dead File')) AS active_claims,
  COALESCE(SUM(c.claim_amount) - SUM(COALESCE(chk.total_paid, 0)), 0) AS total_gap,
  CASE WHEN COUNT(*) FILTER (WHERE NOT c.is_closed) > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE ms.state_json->>'resistance' = 'high')::numeric * 100.0 
      / NULLIF(COUNT(*) FILTER (WHERE NOT c.is_closed), 0), 1)
    ELSE 0 END AS high_resistance_pct,
  CASE WHEN SUM(GREATEST(1, EXTRACT(EPOCH FROM now() - c.created_at) / 86400)) > 0
    THEN ROUND(SUM(COALESCE(chk.total_paid, 0))::numeric / NULLIF(SUM(GREATEST(1, EXTRACT(EPOCH FROM now() - c.created_at) / 86400)), 0), 2)
    ELSE 0 END AS avg_payment_velocity,
  now() AS computed_at
FROM public.claims c
LEFT JOIN LATERAL (
  SELECT SUM(amount) AS total_paid FROM public.claim_checks WHERE claim_id = c.id
) chk ON true
LEFT JOIN public.claim_master_state ms ON ms.claim_id = c.id
GROUP BY COALESCE(c.insurance_company, 'Unknown');

-- Functions for secure access
CREATE OR REPLACE FUNCTION public.get_portfolio_intelligence()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') AND NOT public.has_role(auth.uid(), 'staff') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT row_to_json(pi.*) INTO result FROM public.portfolio_intelligence pi LIMIT 1;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_portfolio_carrier_analytics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') AND NOT public.has_role(auth.uid(), 'staff') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT jsonb_agg(row_to_json(pca.*)) INTO result FROM public.portfolio_carrier_analytics pca;
  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_portfolio_views()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.portfolio_intelligence;
  REFRESH MATERIALIZED VIEW public.portfolio_carrier_analytics;
END;
$$;
