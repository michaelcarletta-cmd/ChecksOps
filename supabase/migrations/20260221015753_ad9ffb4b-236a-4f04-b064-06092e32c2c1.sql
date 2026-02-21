
-- ============================================================
-- Phase 3: Carrier × Scenario Playbooks
-- ============================================================

-- A) claim_outcome_events — one row per claim close
CREATE TABLE public.claim_outcome_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  carrier TEXT NOT NULL,
  state_code TEXT,
  loss_type TEXT,
  trade TEXT,
  denial_rationales TEXT[] DEFAULT '{}',
  decision_type TEXT, -- deny / limit / scope_reduce / delay
  policy_form TEXT,
  first_offer NUMERIC,
  final_paid NUMERIC,
  delta_amount NUMERIC GENERATED ALWAYS AS (COALESCE(final_paid, 0) - COALESCE(first_offer, 0)) STORED,
  coverage_reversal BOOLEAN DEFAULT false,
  resolution_type TEXT, -- supplement / appraisal / doi / litigation / negotiation
  tactics_present TEXT[] DEFAULT '{}',
  evidence_types_present TEXT[] DEFAULT '{}',
  close_date TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_claim_outcome UNIQUE (claim_id)
);

ALTER TABLE public.claim_outcome_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read claim outcomes"
  ON public.claim_outcome_events FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Service role can manage claim outcomes"
  ON public.claim_outcome_events FOR ALL
  USING (true) WITH CHECK (true);

-- B) carrier_scenario_playbooks — rollups per scenario key
CREATE TABLE public.carrier_scenario_playbooks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_key TEXT NOT NULL UNIQUE,
  carrier TEXT NOT NULL,
  state_code TEXT,
  loss_type TEXT,
  trade TEXT,
  denial_rationale TEXT, -- primary rationale for this scenario
  decision_type TEXT,
  policy_form TEXT,
  sample_size_total INTEGER DEFAULT 0,
  sample_size_recent_12mo INTEGER DEFAULT 0,
  win_rate NUMERIC DEFAULT 0, -- 0-100
  avg_indemnity_delta NUMERIC DEFAULT 0,
  avg_time_to_resolution_days INTEGER,
  top_resolution_paths JSONB DEFAULT '[]',
  confidence_score INTEGER DEFAULT 0, -- 0-100
  confidence_label TEXT DEFAULT 'low', -- low / medium / high
  last_updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.carrier_scenario_playbooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read playbooks"
  ON public.carrier_scenario_playbooks FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Service role can manage playbooks"
  ON public.carrier_scenario_playbooks FOR ALL
  USING (true) WITH CHECK (true);

-- C) carrier_scenario_tactics — ranked tactics per scenario
CREATE TABLE public.carrier_scenario_tactics (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_key TEXT NOT NULL REFERENCES public.carrier_scenario_playbooks(scenario_key) ON DELETE CASCADE,
  tactic_type TEXT NOT NULL, -- argument / evidence / process_step
  tactic_name TEXT NOT NULL,
  support_count INTEGER DEFAULT 0,
  success_lift NUMERIC DEFAULT 0, -- relative improvement vs baseline
  median_delta_when_present NUMERIC DEFAULT 0,
  recency_weighted_score NUMERIC DEFAULT 0,
  last_updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_scenario_tactic UNIQUE (scenario_key, tactic_type, tactic_name)
);

ALTER TABLE public.carrier_scenario_tactics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read tactics"
  ON public.carrier_scenario_tactics FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Service role can manage tactics"
  ON public.carrier_scenario_tactics FOR ALL
  USING (true) WITH CHECK (true);

-- Indexes for fast lookups
CREATE INDEX idx_outcome_events_carrier ON public.claim_outcome_events(carrier);
CREATE INDEX idx_outcome_events_denial ON public.claim_outcome_events USING GIN(denial_rationales);
CREATE INDEX idx_outcome_events_close_date ON public.claim_outcome_events(close_date);
CREATE INDEX idx_playbooks_carrier ON public.carrier_scenario_playbooks(carrier);
CREATE INDEX idx_playbooks_carrier_state ON public.carrier_scenario_playbooks(carrier, state_code);
CREATE INDEX idx_playbooks_scenario_key ON public.carrier_scenario_playbooks(scenario_key);
CREATE INDEX idx_tactics_scenario ON public.carrier_scenario_tactics(scenario_key);
CREATE INDEX idx_tactics_score ON public.carrier_scenario_tactics(recency_weighted_score DESC);

-- Trigger to update updated_at on claim_outcome_events
CREATE TRIGGER update_claim_outcome_events_updated_at
  BEFORE UPDATE ON public.claim_outcome_events
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
