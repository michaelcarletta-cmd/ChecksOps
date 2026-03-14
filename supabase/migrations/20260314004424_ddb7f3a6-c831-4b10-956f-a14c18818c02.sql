
-- Add latest_signature_request_id to claims for unified signature tracking
ALTER TABLE public.claims 
ADD COLUMN IF NOT EXISTS latest_signature_request_id UUID REFERENCES public.signature_requests(id) ON DELETE SET NULL;

-- Add last_attempted_at to signature_requests for tracking retry timing
ALTER TABLE public.signature_requests 
ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ;
