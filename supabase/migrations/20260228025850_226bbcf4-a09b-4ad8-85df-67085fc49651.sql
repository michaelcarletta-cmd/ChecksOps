
-- Recovery analytics: avg recovery % by carrier
CREATE OR REPLACE VIEW public.recovery_by_carrier AS
SELECT 
  carrier_name,
  COUNT(*) AS total_claims,
  ROUND(AVG(gap_recovery_pct)::numeric, 1) AS avg_recovery_pct,
  ROUND(AVG(days_to_recovery)::numeric, 0) AS avg_days_to_recovery,
  ROUND(AVG(final_velocity)::numeric, 2) AS avg_velocity,
  SUM(CASE WHEN escalation_used THEN 1 ELSE 0 END) AS escalation_count,
  ROUND(AVG(resistance_peak_score)::numeric, 0) AS avg_resistance
FROM public.claim_performance_attribution
WHERE carrier_name IS NOT NULL
GROUP BY carrier_name;

-- Recovery analytics: avg recovery % by loss type
CREATE OR REPLACE VIEW public.recovery_by_loss_type AS
SELECT 
  loss_type,
  COUNT(*) AS total_claims,
  ROUND(AVG(gap_recovery_pct)::numeric, 1) AS avg_recovery_pct,
  ROUND(AVG(days_to_recovery)::numeric, 0) AS avg_days_to_recovery,
  ROUND(AVG(final_velocity)::numeric, 2) AS avg_velocity,
  SUM(CASE WHEN escalation_used THEN 1 ELSE 0 END) AS escalation_count
FROM public.claim_performance_attribution
WHERE loss_type IS NOT NULL
GROUP BY loss_type;

-- Recovery analytics: with escalation vs without
CREATE OR REPLACE VIEW public.recovery_by_escalation AS
SELECT 
  escalation_used,
  COUNT(*) AS total_claims,
  ROUND(AVG(gap_recovery_pct)::numeric, 1) AS avg_recovery_pct,
  ROUND(AVG(days_to_recovery)::numeric, 0) AS avg_days_to_recovery,
  ROUND(AVG(final_velocity)::numeric, 2) AS avg_velocity,
  ROUND(AVG(resistance_peak_score)::numeric, 0) AS avg_resistance
FROM public.claim_performance_attribution
GROUP BY escalation_used;

-- Weekly Command Review RPC
CREATE OR REPLACE FUNCTION public.get_weekly_command_review()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  result jsonb;
  portfolio jsonb;
  carrier_analytics jsonb;
  recovery_carrier jsonb;
  recovery_loss jsonb;
  recovery_esc jsonb;
  forecast jsonb;
  drift_flags jsonb;
  escalations_triggered int;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') AND NOT public.has_role(auth.uid(), 'staff') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Portfolio intelligence
  SELECT row_to_json(pi.*) INTO portfolio FROM public.portfolio_intelligence pi LIMIT 1;

  -- Top carrier resistance
  SELECT jsonb_agg(row_to_json(pca.*)) INTO carrier_analytics 
  FROM public.portfolio_carrier_analytics pca;

  -- Recovery by carrier
  SELECT jsonb_agg(row_to_json(rc.*)) INTO recovery_carrier 
  FROM public.recovery_by_carrier rc;

  -- Recovery by loss type
  SELECT jsonb_agg(row_to_json(rl.*)) INTO recovery_loss 
  FROM public.recovery_by_loss_type rl;

  -- Recovery by escalation
  SELECT jsonb_agg(row_to_json(re.*)) INTO recovery_esc 
  FROM public.recovery_by_escalation re;

  -- Latest forecast
  SELECT row_to_json(cf.*) INTO forecast
  FROM public.cash_flow_forecast cf
  ORDER BY cf.forecast_date DESC LIMIT 1;

  -- Drift misalignment flags
  SELECT jsonb_agg(row_to_json(da.*)) INTO drift_flags
  FROM public.autopilot_drift_analytics da
  WHERE da.flagged_misalignment = true;

  -- Escalations triggered last 7 days
  SELECT COUNT(*) INTO escalations_triggered
  FROM public.strategy_outcome_tracking
  WHERE strategy_type = 'escalation_recommended'
  AND executed_at >= (NOW() - INTERVAL '7 days');

  result := jsonb_build_object(
    'portfolio', COALESCE(portfolio, '{}'::jsonb),
    'carrier_analytics', COALESCE(carrier_analytics, '[]'::jsonb),
    'recovery_by_carrier', COALESCE(recovery_carrier, '[]'::jsonb),
    'recovery_by_loss_type', COALESCE(recovery_loss, '[]'::jsonb),
    'recovery_by_escalation', COALESCE(recovery_esc, '[]'::jsonb),
    'cash_flow_forecast', COALESCE(forecast, '{}'::jsonb),
    'drift_misalignments', COALESCE(drift_flags, '[]'::jsonb),
    'escalations_triggered_7d', escalations_triggered
  );

  RETURN result;
END;
$$;
