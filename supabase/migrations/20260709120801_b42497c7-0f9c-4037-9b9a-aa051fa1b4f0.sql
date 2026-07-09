ALTER TABLE public.homeowner_intro_requests
  ADD COLUMN IF NOT EXISTS access_token text UNIQUE
    DEFAULT encode(gen_random_bytes(24), 'hex') NOT NULL,
  ADD COLUMN IF NOT EXISTS dtp_signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dtp_signature_name text,
  ADD COLUMN IF NOT EXISTS dtp_signature_ip text,
  ADD COLUMN IF NOT EXISTS dtp_signature_user_agent text,
  ADD COLUMN IF NOT EXISTS dtp_insurance_carrier text,
  ADD COLUMN IF NOT EXISTS dtp_claim_number text,
  ADD COLUMN IF NOT EXISTS dtp_policy_number text,
  ADD COLUMN IF NOT EXISTS dtp_property_address text;

UPDATE public.homeowner_intro_requests
   SET access_token = encode(gen_random_bytes(24), 'hex')
 WHERE access_token IS NULL;

CREATE INDEX IF NOT EXISTS homeowner_intro_requests_access_token_idx
  ON public.homeowner_intro_requests (access_token);