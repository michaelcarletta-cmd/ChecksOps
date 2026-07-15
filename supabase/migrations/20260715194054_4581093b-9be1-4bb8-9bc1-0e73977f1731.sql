ALTER TABLE public.mortgage_handling_requests
  ADD COLUMN IF NOT EXISTS policy_number text,
  ADD COLUMN IF NOT EXISTS claim_number text,
  ADD COLUMN IF NOT EXISTS insurance_company text,
  ADD COLUMN IF NOT EXISTS loss_type text,
  ADD COLUMN IF NOT EXISTS date_of_loss date,
  ADD COLUMN IF NOT EXISTS homeowner_name text,
  ADD COLUMN IF NOT EXISTS homeowner_email text,
  ADD COLUMN IF NOT EXISTS homeowner_phone text,
  ADD COLUMN IF NOT EXISTS property_address text;