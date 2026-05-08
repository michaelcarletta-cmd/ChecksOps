ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS payment_classification text,
  ADD COLUMN IF NOT EXISTS payee_address text;