
-- Add UNIQUE constraint on carrier_argument_rebuttals(claim_id, argument_type)
CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_argument_rebuttals_claim_arg 
  ON public.carrier_argument_rebuttals (claim_id, argument_type);

-- Create carrier argument queue table for job-based processing
CREATE TABLE IF NOT EXISTS public.carrier_argument_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  file_id uuid REFERENCES public.claim_files(id) ON DELETE SET NULL,
  file_name text,
  extracted_text text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX idx_carrier_argument_queue_status ON public.carrier_argument_queue (status) WHERE status = 'pending';

-- Ensure darwin_jobs has a row for this job type
INSERT INTO public.darwin_jobs (job_type, status)
VALUES ('carrier_argument_detection', 'idle')
ON CONFLICT (job_type) DO NOTHING;

-- RLS: service role only (edge functions)
ALTER TABLE public.carrier_argument_queue ENABLE ROW LEVEL SECURITY;
