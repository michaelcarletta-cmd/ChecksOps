
-- ============================================================
-- Darwin Intelligence Stack: Core Tables
-- ============================================================

-- 1. Estimate Intelligence Engine
CREATE TABLE public.claim_estimate_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  analysis_type TEXT NOT NULL DEFAULT 'comparison', -- comparison, gap, supplement_rec
  carrier_estimate_file_id UUID REFERENCES public.claim_files(id),
  contractor_estimate_file_id UUID REFERENCES public.claim_files(id),
  carrier_total NUMERIC,
  contractor_total NUMERIC,
  darwin_recommended_total NUMERIC,
  difference_amount NUMERIC,
  scope_gaps JSONB DEFAULT '[]'::jsonb,         -- [{item, category, amount, evidence}]
  quantity_gaps JSONB DEFAULT '[]'::jsonb,       -- [{item, carrier_qty, correct_qty, basis}]
  pricing_gaps JSONB DEFAULT '[]'::jsonb,        -- [{item, carrier_rate, market_rate, source}]
  code_upgrade_gaps JSONB DEFAULT '[]'::jsonb,   -- [{code_ref, requirement, missing_from}]
  op_gaps JSONB DEFAULT '[]'::jsonb,             -- [{trade, basis, amount}]
  supplement_recommendations JSONB DEFAULT '[]'::jsonb,
  rebuttal_narrative TEXT,
  structured_findings JSONB DEFAULT '{}'::jsonb,
  confidence_score NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

CREATE INDEX idx_claim_estimate_analysis_claim ON public.claim_estimate_analysis(claim_id);

-- 2. Photo Intelligence Engine
CREATE TABLE public.claim_photo_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  photo_id UUID,
  photo_url TEXT,
  finding_type TEXT NOT NULL, -- causation, scope, repairability, full_replacement, code_trigger, carrier_contradiction
  material_type TEXT,
  damage_description TEXT,
  severity TEXT, -- minor, moderate, severe, critical
  area TEXT,
  causation_link TEXT,         -- how this links to cause of loss
  scope_relevance TEXT,        -- repair vs replace justification
  code_trigger_ref TEXT,       -- building code triggered
  carrier_contradiction TEXT,  -- contradicts carrier position
  evidence_strength TEXT,      -- weak, moderate, strong
  confidence NUMERIC,
  structured_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_analysis_id TEXT
);

CREATE INDEX idx_claim_photo_findings_claim ON public.claim_photo_findings(claim_id);
CREATE INDEX idx_claim_photo_findings_type ON public.claim_photo_findings(finding_type);

-- 3. War Room Strategy Simulations
CREATE TABLE public.claim_strategy_simulations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  strategy_type TEXT NOT NULL, -- supplement, reinspection, appraisal, doi_complaint, litigation_referral, demand_letter
  score NUMERIC NOT NULL DEFAULT 0,
  recommended_action TEXT NOT NULL,
  predicted_recovery_delta NUMERIC,
  predicted_timeline_days INTEGER,
  required_missing_evidence JSONB DEFAULT '[]'::jsonb,
  rationale TEXT NOT NULL,
  claim_facts_snapshot JSONB DEFAULT '{}'::jsonb,
  evidence_completeness_pct NUMERIC,
  carrier_behavior_factors JSONB DEFAULT '{}'::jsonb,
  cross_claim_support JSONB DEFAULT '{}'::jsonb,  -- similar outcomes from learning
  risk_level TEXT, -- low, medium, high
  is_recommended BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

CREATE INDEX idx_claim_strategy_simulations_claim ON public.claim_strategy_simulations(claim_id);
CREATE INDEX idx_claim_strategy_simulations_recommended ON public.claim_strategy_simulations(claim_id, is_recommended) WHERE is_recommended = true;

-- 4. Document/Rebuttal Intelligence (Argument Map)
CREATE TABLE public.claim_argument_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  source_file_id UUID REFERENCES public.claim_files(id),
  source_file_name TEXT,
  argument_text TEXT NOT NULL,
  argument_type TEXT NOT NULL, -- coverage_denial, scope_reduction, causation_dispute, pricing_dispute, exclusion, maintenance_defense, engineering_opinion
  argument_category TEXT,      -- policy, technical, procedural, factual
  carrier_position_summary TEXT,
  contradictions JSONB DEFAULT '[]'::jsonb,       -- [{with_doc, with_statement, explanation}]
  evidence_gaps JSONB DEFAULT '[]'::jsonb,         -- [{what_missing, why_needed, where_to_find}]
  rebuttal_strategies JSONB DEFAULT '[]'::jsonb,   -- [{rank, strategy, draft_language, citations, strength}]
  supporting_citations JSONB DEFAULT '[]'::jsonb,  -- [{source, text, relevance}]
  knowledge_base_refs JSONB DEFAULT '[]'::jsonb,   -- [{chunk_id, content_preview, relevance}]
  strength_score NUMERIC,  -- how strong is the carrier argument (0-100)
  rebuttal_confidence NUMERIC, -- how confident in our rebuttal (0-100)
  status TEXT DEFAULT 'pending', -- pending, rebutted, escalated
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_claim_argument_map_claim ON public.claim_argument_map(claim_id);
CREATE INDEX idx_claim_argument_map_type ON public.claim_argument_map(argument_type);

-- 5. Cross-Claim Learning
CREATE TABLE public.claim_outcome_learning (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  carrier TEXT,
  state_code TEXT,
  loss_type TEXT,
  denial_rationale TEXT,
  outcome TEXT, -- won, lost, partial, settled, appraisal, litigation
  resolution_timeline_days INTEGER,
  initial_carrier_offer NUMERIC,
  final_settlement NUMERIC,
  recovery_delta NUMERIC,
  winning_arguments JSONB DEFAULT '[]'::jsonb,     -- [{argument_type, summary, evidence_used}]
  evidence_patterns JSONB DEFAULT '[]'::jsonb,     -- [{evidence_type, was_effective, notes}]
  strategy_sequence JSONB DEFAULT '[]'::jsonb,     -- [{step, action, result, days_elapsed}]
  key_turning_point TEXT,
  lessons_learned TEXT,
  reusable_language JSONB DEFAULT '[]'::jsonb,     -- [{context, language, effectiveness}]
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

CREATE INDEX idx_claim_outcome_learning_carrier ON public.claim_outcome_learning(carrier);
CREATE INDEX idx_claim_outcome_learning_loss ON public.claim_outcome_learning(loss_type);
CREATE INDEX idx_claim_outcome_learning_outcome ON public.claim_outcome_learning(outcome);

-- 6. Darwin Feedback Events (Continuous Learning)
CREATE TABLE public.darwin_feedback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID REFERENCES public.claims(id) ON DELETE SET NULL,
  output_type TEXT NOT NULL, -- estimate_analysis, photo_finding, strategy_sim, rebuttal, copilot_answer, demand_package
  output_id UUID,            -- FK to the specific output row
  output_snapshot JSONB,     -- snapshot of what Darwin produced
  feedback_type TEXT NOT NULL, -- thumbs_up, thumbs_down, edit, override, used_as_is
  feedback_detail TEXT,       -- user notes on what was wrong/right
  actual_outcome TEXT,        -- what actually happened
  actual_recovery_delta NUMERIC,
  user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_darwin_feedback_claim ON public.darwin_feedback_events(claim_id);
CREATE INDEX idx_darwin_feedback_type ON public.darwin_feedback_events(output_type);

-- Enable RLS on all tables
ALTER TABLE public.claim_estimate_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_photo_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_strategy_simulations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_argument_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_outcome_learning ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.darwin_feedback_events ENABLE ROW LEVEL SECURITY;

-- RLS policies (authenticated users can CRUD)
CREATE POLICY "Auth users can manage estimate analysis" ON public.claim_estimate_analysis FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Auth users can manage photo findings" ON public.claim_photo_findings FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Auth users can manage strategy simulations" ON public.claim_strategy_simulations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Auth users can manage argument map" ON public.claim_argument_map FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Auth users can manage outcome learning" ON public.claim_outcome_learning FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Auth users can manage feedback events" ON public.darwin_feedback_events FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Service role policies for edge functions
CREATE POLICY "Service role full access estimate analysis" ON public.claim_estimate_analysis FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access photo findings" ON public.claim_photo_findings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access strategy simulations" ON public.claim_strategy_simulations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access argument map" ON public.claim_argument_map FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access outcome learning" ON public.claim_outcome_learning FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access feedback events" ON public.darwin_feedback_events FOR ALL TO service_role USING (true) WITH CHECK (true);
