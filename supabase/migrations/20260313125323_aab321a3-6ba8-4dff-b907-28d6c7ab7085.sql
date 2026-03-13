
ALTER TABLE public.claim_events 
ADD COLUMN IF NOT EXISTS dispute_tag text,
ADD COLUMN IF NOT EXISTS supports_escalation boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS supports_rebuttal boolean DEFAULT false;

ALTER TABLE public.darwin_estimate_lines
ADD COLUMN IF NOT EXISTS used_in_rebuttal boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS recovery_impact_rank integer,
ADD COLUMN IF NOT EXISTS rebuttal_strength_score integer;

COMMENT ON COLUMN public.claim_events.dispute_tag IS 'Links event as evidence for a specific dispute/argument';
COMMENT ON COLUMN public.darwin_estimate_lines.used_in_rebuttal IS 'Whether this line item has been cited in rebuttal/supplement language';
COMMENT ON COLUMN public.darwin_estimate_lines.recovery_impact_rank IS 'Rank by variance amount for prioritization';
