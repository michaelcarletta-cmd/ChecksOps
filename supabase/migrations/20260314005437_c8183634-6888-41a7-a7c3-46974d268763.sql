
-- 1. Add token_hash and expires_at to signature_signers
ALTER TABLE public.signature_signers
  ADD COLUMN IF NOT EXISTS token_hash text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Index for fast hash lookups (replaces access_token lookups)
CREATE INDEX IF NOT EXISTS idx_signature_signers_token_hash
  ON public.signature_signers (token_hash);

-- 2. Create normalized signature_fields table
CREATE TABLE IF NOT EXISTS public.signature_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signature_request_id uuid NOT NULL REFERENCES public.signature_requests(id) ON DELETE CASCADE,
  signer_index int NOT NULL DEFAULT 0,
  field_type text NOT NULL, -- signature, date, text, checkbox
  label text,
  page int NOT NULL DEFAULT 1,
  x numeric NOT NULL DEFAULT 0,
  y numeric NOT NULL DEFAULT 0,
  width numeric NOT NULL DEFAULT 200,
  height numeric NOT NULL DEFAULT 50,
  required boolean NOT NULL DEFAULT true,
  placeholder text,
  checkbox_label text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.signature_fields ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on signature_fields"
  ON public.signature_fields FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can view signature_fields"
  ON public.signature_fields FOR SELECT
  TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_signature_fields_request
  ON public.signature_fields (signature_request_id);

-- 3. Create normalized signature_field_values table
CREATE TABLE IF NOT EXISTS public.signature_field_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id uuid NOT NULL REFERENCES public.signature_fields(id) ON DELETE CASCADE,
  signer_id uuid NOT NULL REFERENCES public.signature_signers(id) ON DELETE CASCADE,
  value text, -- text/date value, or base64 data URI for signatures
  checked boolean DEFAULT false, -- for checkbox fields
  submitted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.signature_field_values ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on signature_field_values"
  ON public.signature_field_values FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can view signature_field_values"
  ON public.signature_field_values FOR SELECT
  TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_signature_field_values_field
  ON public.signature_field_values (field_id);

CREATE INDEX IF NOT EXISTS idx_signature_field_values_signer
  ON public.signature_field_values (signer_id);

-- 4. Add completion_status for retryable completion
ALTER TABLE public.signature_requests
  ADD COLUMN IF NOT EXISTS completion_status text DEFAULT 'pending';
-- Values: pending, completed, failed (for post-processing PDF generation)
