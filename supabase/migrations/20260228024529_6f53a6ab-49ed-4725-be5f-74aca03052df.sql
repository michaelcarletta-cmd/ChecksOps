
-- 1. Quarterly Model Snapshot (version control for intelligence)
CREATE TABLE public.autopilot_model_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  snapshot_type text NOT NULL DEFAULT 'quarterly',
  scoring_weights jsonb NOT NULL DEFAULT '{}',
  resistance_thresholds jsonb NOT NULL DEFAULT '{}',
  health_parameters jsonb NOT NULL DEFAULT '{}',
  confidence_adjustments jsonb NOT NULL DEFAULT '{}',
  escalation_governance jsonb NOT NULL DEFAULT '{}',
  drift_analytics_summary jsonb NOT NULL DEFAULT '{}',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.autopilot_model_snapshot ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read model snapshots"
  ON public.autopilot_model_snapshot FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service role can insert model snapshots"
  ON public.autopilot_model_snapshot FOR INSERT
  WITH CHECK (true);

-- 2. Claim Performance Attribution
CREATE TABLE public.claim_performance_attribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  revenue_captured numeric DEFAULT 0,
  gap_recovery_pct numeric DEFAULT 0,
  days_to_recovery integer,
  escalation_used boolean DEFAULT false,
  escalation_types text[] DEFAULT '{}',
  resistance_peak_score integer DEFAULT 0,
  strategy_used text,
  carrier_name text,
  loss_type text,
  state_code text,
  final_velocity numeric DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(claim_id)
);

ALTER TABLE public.claim_performance_attribution ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read performance attribution"
  ON public.claim_performance_attribution FOR SELECT
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

CREATE POLICY "Service role can manage performance attribution"
  ON public.claim_performance_attribution FOR ALL
  USING (true) WITH CHECK (true);

-- 3. Strategy Outcome Tracking
CREATE TABLE public.strategy_outcome_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  strategy_type text NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  gap_at_execution numeric DEFAULT 0,
  gap_pct_at_execution numeric DEFAULT 0,
  resistance_at_execution text,
  payment_30d_after numeric,
  gap_reduction_pct_30d numeric,
  resistance_change text,
  outcome_measured boolean DEFAULT false,
  outcome_measured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.strategy_outcome_tracking ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read strategy outcomes"
  ON public.strategy_outcome_tracking FOR SELECT
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

CREATE POLICY "Service role can manage strategy outcomes"
  ON public.strategy_outcome_tracking FOR ALL
  USING (true) WITH CHECK (true);

-- 4. Cash Flow Forecast (portfolio-level, recomputed periodically)
CREATE TABLE public.cash_flow_forecast (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_date date NOT NULL DEFAULT CURRENT_DATE,
  expected_30d_recovery numeric DEFAULT 0,
  expected_60d_recovery numeric DEFAULT 0,
  expected_90d_exposure numeric DEFAULT 0,
  total_outstanding_gap numeric DEFAULT 0,
  total_claims_active integer DEFAULT 0,
  avg_payment_velocity numeric DEFAULT 0,
  avg_resistance_score numeric DEFAULT 0,
  methodology_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(forecast_date)
);

ALTER TABLE public.cash_flow_forecast ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read cash flow forecasts"
  ON public.cash_flow_forecast FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service role can manage cash flow forecasts"
  ON public.cash_flow_forecast FOR ALL
  USING (true) WITH CHECK (true);
