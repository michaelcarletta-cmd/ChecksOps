
-- Add final_pdf_path to signature_requests for completed signed documents
ALTER TABLE public.signature_requests 
ADD COLUMN IF NOT EXISTS final_pdf_path TEXT;

-- Add viewed_at to signature_signers for first-view tracking
ALTER TABLE public.signature_signers 
ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ;

-- Add IP and user agent capture for audit trail on signature_signers
ALTER TABLE public.signature_signers 
ADD COLUMN IF NOT EXISTS ip_address TEXT;

ALTER TABLE public.signature_signers 
ADD COLUMN IF NOT EXISTS user_agent TEXT;

-- Add indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_signature_signers_access_token 
ON public.signature_signers (access_token);

CREATE INDEX IF NOT EXISTS idx_signature_signers_request_id 
ON public.signature_signers (signature_request_id);

CREATE INDEX IF NOT EXISTS idx_signature_requests_claim_id 
ON public.signature_requests (claim_id);

CREATE INDEX IF NOT EXISTS idx_signature_requests_status 
ON public.signature_requests (status);

CREATE INDEX IF NOT EXISTS idx_esign_event_logs_request_id 
ON public.esign_event_logs (request_id);

CREATE INDEX IF NOT EXISTS idx_esign_event_logs_claim_id 
ON public.esign_event_logs (claim_id);
