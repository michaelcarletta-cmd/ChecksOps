
-- Drop the partial unique index that ON CONFLICT can't use
DROP INDEX IF EXISTS idx_claim_checks_intake_item;

-- Create a proper unique constraint on check_intake_item_id
ALTER TABLE public.claim_checks ADD CONSTRAINT claim_checks_check_intake_item_id_unique UNIQUE (check_intake_item_id);
