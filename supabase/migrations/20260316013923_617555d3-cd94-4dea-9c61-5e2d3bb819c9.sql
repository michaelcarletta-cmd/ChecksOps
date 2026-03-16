
ALTER TABLE public.darwin_declared_positions
  ADD COLUMN IF NOT EXISTS observed_damage_condition text,
  ADD COLUMN IF NOT EXISTS primary_loss_mechanism text,
  ADD COLUMN IF NOT EXISTS coverage_trigger_theory text,
  ADD COLUMN IF NOT EXISTS specific_carrier_failure text,
  ADD COLUMN IF NOT EXISTS decisive_contradiction text,
  ADD COLUMN IF NOT EXISTS requested_remedy text,
  ADD COLUMN IF NOT EXISTS key_supporting_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS policy_standard_support jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS carrier_evidence_rebutted jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS known_weaknesses jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS missing_proof_needed jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS position_strength_score integer,
  ADD COLUMN IF NOT EXISTS position_strength_label text,
  ADD COLUMN IF NOT EXISTS drift_risk text,
  ADD COLUMN IF NOT EXISTS lock_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS master_position_statement text,
  ADD COLUMN IF NOT EXISTS strategic_notes text,
  ADD COLUMN IF NOT EXISTS claim_type text,
  ADD COLUMN IF NOT EXISTS provisional_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'darwin_declared_positions_lock_status_check'
  ) THEN
    ALTER TABLE public.darwin_declared_positions
      ADD CONSTRAINT darwin_declared_positions_lock_status_check
      CHECK (lock_status IN ('draft', 'strategic_lock', 'litigation_grade'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'darwin_declared_positions_strength_label_check'
  ) THEN
    ALTER TABLE public.darwin_declared_positions
      ADD CONSTRAINT darwin_declared_positions_strength_label_check
      CHECK (position_strength_label IS NULL OR position_strength_label IN ('fragile', 'moderate', 'strong'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'darwin_declared_positions_drift_risk_check'
  ) THEN
    ALTER TABLE public.darwin_declared_positions
      ADD CONSTRAINT darwin_declared_positions_drift_risk_check
      CHECK (drift_risk IS NULL OR drift_risk IN ('low', 'medium', 'high'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_darwin_declared_positions_claim_id
  ON public.darwin_declared_positions (claim_id);
