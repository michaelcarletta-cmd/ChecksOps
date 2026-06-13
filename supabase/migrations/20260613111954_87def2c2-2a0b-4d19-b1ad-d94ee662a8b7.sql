
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS legal_business_name text,
  ADD COLUMN IF NOT EXISTS ein text,
  ADD COLUMN IF NOT EXISTS business_address text,
  ADD COLUMN IF NOT EXISTS business_phone text,
  ADD COLUMN IF NOT EXISTS beneficial_owner_name text,
  ADD COLUMN IF NOT EXISTS beneficial_owner_dob date,
  ADD COLUMN IF NOT EXISTS beneficial_owner_id_url text,
  ADD COLUMN IF NOT EXISTS kyc_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_completed_by uuid,
  ADD COLUMN IF NOT EXISTS ach_policy_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS ach_policy_acknowledged_by uuid,
  ADD COLUMN IF NOT EXISTS ach_policy_version text;
