CREATE INDEX IF NOT EXISTS idx_claim_photos_claim_id_created_at
ON public.claim_photos (claim_id, created_at DESC);