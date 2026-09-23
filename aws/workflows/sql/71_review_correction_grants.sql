-- Narrow Review-correction column grants for AWS staging.
-- MICR, deposit lock, claim link, raw OCR, and provider tables stay ungranted.
-- Does not add amount to generic /data/write.

GRANT UPDATE (amount, detected_claim_number)
  ON TABLE public.check_intake_items
  TO checksops, authenticated;
