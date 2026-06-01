
-- Allow signature_requests to attach to a shared check_intake_items row
-- when no claim exists in this project (cross-project shared checks).

ALTER TABLE public.signature_requests
  ALTER COLUMN claim_id DROP NOT NULL;

ALTER TABLE public.signature_requests
  ADD COLUMN IF NOT EXISTS check_intake_item_id uuid
    REFERENCES public.check_intake_items(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_signature_requests_intake_item
  ON public.signature_requests(check_intake_item_id);

ALTER TABLE public.signature_requests
  DROP CONSTRAINT IF EXISTS signature_requests_target_present;

ALTER TABLE public.signature_requests
  ADD CONSTRAINT signature_requests_target_present
    CHECK (claim_id IS NOT NULL OR check_intake_item_id IS NOT NULL);
