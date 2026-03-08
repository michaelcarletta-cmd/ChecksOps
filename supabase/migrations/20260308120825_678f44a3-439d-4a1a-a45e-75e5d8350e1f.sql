
-- 1. Create esign_event_logs table
CREATE TABLE public.esign_event_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  request_id uuid REFERENCES public.signature_requests(id) ON DELETE SET NULL,
  signer_id uuid REFERENCES public.signature_signers(id) ON DELETE SET NULL,
  claim_id uuid REFERENCES public.claims(id) ON DELETE SET NULL,
  stage text NOT NULL,
  status text NOT NULL,
  message text,
  payload jsonb
);

ALTER TABLE public.esign_event_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage esign event logs"
  ON public.esign_event_logs FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role));

CREATE INDEX idx_esign_event_logs_request_id ON public.esign_event_logs(request_id);
CREATE INDEX idx_esign_event_logs_claim_id ON public.esign_event_logs(claim_id);

-- 2. Update signature_requests
ALTER TABLE public.signature_requests
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS last_provider_response text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz;
-- completed_at already exists

-- 3. Update signature_signers
ALTER TABLE public.signature_signers
  ADD COLUMN IF NOT EXISTS delivery_status text,
  ADD COLUMN IF NOT EXISTS delivery_error text,
  ADD COLUMN IF NOT EXISTS email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_provider_message_id text;
