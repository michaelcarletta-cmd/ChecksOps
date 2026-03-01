-- Add age resolver columns to claim_home_inventory
ALTER TABLE public.claim_home_inventory
  ADD COLUMN IF NOT EXISTS purchase_date_best date,
  ADD COLUMN IF NOT EXISTS purchase_date_low date,
  ADD COLUMN IF NOT EXISTS purchase_date_high date,
  ADD COLUMN IF NOT EXISTS age_confidence_score integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS evidence_json jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS needs_age_review boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS label_photo_path text;

-- Backfill purchase_date_best from existing original_purchase_date where available
UPDATE public.claim_home_inventory
SET purchase_date_best = original_purchase_date,
    age_confidence_score = 80,
    needs_age_review = false,
    evidence_json = jsonb_build_array(jsonb_build_object('type', 'user_entered', 'date', original_purchase_date, 'weight', 15))
WHERE original_purchase_date IS NOT NULL AND purchase_date_best IS NULL;

-- Create index for items needing age review
CREATE INDEX IF NOT EXISTS idx_inventory_needs_age_review 
ON public.claim_home_inventory (claim_id, needs_age_review) 
WHERE needs_age_review = true;