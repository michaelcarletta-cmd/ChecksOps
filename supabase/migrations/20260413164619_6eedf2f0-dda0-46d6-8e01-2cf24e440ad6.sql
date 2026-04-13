
-- Table 1: Reusable requirement rules per normalized line item
CREATE TABLE public.line_item_requirement_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  normalized_item TEXT NOT NULL,
  trade TEXT NOT NULL DEFAULT 'roofing',
  manufacturer_family TEXT,
  manufacturer_requirement_text TEXT,
  code_requirement_text TEXT,
  policy_theory TEXT,
  evidence_required TEXT[] DEFAULT '{}',
  common_pushback TEXT,
  rebuttal_template TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_lirr_normalized_trade ON public.line_item_requirement_rules (normalized_item, trade);

ALTER TABLE public.line_item_requirement_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read requirement rules"
  ON public.line_item_requirement_rules FOR SELECT
  TO authenticated USING (true);

-- Table 2: Per-claim justification results
CREATE TABLE public.claim_line_item_justifications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  estimate_line_id TEXT,
  normalized_item TEXT NOT NULL,
  manufacturer_support JSONB DEFAULT '{}',
  code_support JSONB DEFAULT '{}',
  policy_support JSONB DEFAULT '{}',
  support_strength TEXT DEFAULT 'inferred' CHECK (support_strength IN ('direct', 'inferred', 'needs_evidence')),
  confidence_score INTEGER DEFAULT 50 CHECK (confidence_score >= 0 AND confidence_score <= 100),
  missing_evidence_json JSONB DEFAULT '[]',
  carrier_facing_text TEXT,
  inline_note TEXT,
  output_mode TEXT DEFAULT 'inline' CHECK (output_mode IN ('inline', 'full_report', 'carrier_facing')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_clij_claim ON public.claim_line_item_justifications (claim_id);

ALTER TABLE public.claim_line_item_justifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage justifications for their claims"
  ON public.claim_line_item_justifications FOR ALL
  TO authenticated USING (true) WITH CHECK (true);

-- Timestamp triggers
CREATE TRIGGER update_lirr_updated_at
  BEFORE UPDATE ON public.line_item_requirement_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_clij_updated_at
  BEFORE UPDATE ON public.claim_line_item_justifications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
