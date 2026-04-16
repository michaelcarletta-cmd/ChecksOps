-- Learned rule candidates: discovered patterns awaiting review/activation
CREATE TABLE public.learned_rule_candidates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rule_type TEXT NOT NULL,
  trigger_pattern TEXT NOT NULL,
  normalized_pattern TEXT NOT NULL,
  source_phrase TEXT,
  weakness_category TEXT,
  rebuttal_strategy TEXT,
  evidence_request TEXT,
  source_document_type TEXT,
  carrier TEXT,
  state TEXT,
  trade TEXT,
  material TEXT,
  dispute_type TEXT,
  supporting_claim_count INT NOT NULL DEFAULT 0,
  win_count INT NOT NULL DEFAULT 0,
  loss_count INT NOT NULL DEFAULT 0,
  confidence_score NUMERIC NOT NULL DEFAULT 0,
  activation_status TEXT NOT NULL DEFAULT 'candidate',
  created_from_claim_ids UUID[] NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_learned_rule_candidates_dedupe
  ON public.learned_rule_candidates(rule_type, normalized_pattern, COALESCE(carrier,''), COALESCE(state,''), COALESCE(trade,''), COALESCE(material,''), COALESCE(dispute_type,''));
CREATE INDEX idx_learned_rule_candidates_status ON public.learned_rule_candidates(activation_status);
CREATE INDEX idx_learned_rule_candidates_score ON public.learned_rule_candidates(confidence_score DESC);

-- Active learned rules: approved + promoted, used in live analysis
CREATE TABLE public.learned_rules_active (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  candidate_id UUID NOT NULL REFERENCES public.learned_rule_candidates(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  trigger_pattern TEXT NOT NULL,
  normalized_pattern TEXT NOT NULL,
  weakness_category TEXT,
  rebuttal_strategy TEXT,
  evidence_request TEXT,
  carrier TEXT,
  state TEXT,
  trade TEXT,
  material TEXT,
  dispute_type TEXT,
  confidence_score NUMERIC NOT NULL DEFAULT 0,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_learned_rules_active_lookup ON public.learned_rules_active(rule_type, is_enabled);
CREATE INDEX idx_learned_rules_active_context ON public.learned_rules_active(carrier, state, trade);

-- RLS: internal-only tables; allow authenticated read, restrict writes to service role
ALTER TABLE public.learned_rule_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learned_rules_active ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read rule candidates"
  ON public.learned_rule_candidates FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can read active learned rules"
  ON public.learned_rules_active FOR SELECT
  TO authenticated USING (true);

-- Reuse the existing timestamp trigger function
CREATE TRIGGER trg_learned_rule_candidates_updated
  BEFORE UPDATE ON public.learned_rule_candidates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();