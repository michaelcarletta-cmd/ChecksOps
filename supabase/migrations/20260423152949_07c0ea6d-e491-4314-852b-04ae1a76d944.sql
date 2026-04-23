
-- Add mortgage monitoring columns to claim_checks
ALTER TABLE public.claim_checks
  ADD COLUMN IF NOT EXISTS mortgage_monitoring_type text DEFAULT 'not_set',
  ADD COLUMN IF NOT EXISTS mortgage_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS mortgage_tracking_number text,
  ADD COLUMN IF NOT EXISTS mortgage_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS mortgage_final_released_at timestamptz;

-- Create table for mortgage draw records (monitored checks)
CREATE TABLE public.claim_check_mortgage_draws (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES public.claim_checks(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  draw_number int NOT NULL DEFAULT 1,
  draw_type text NOT NULL DEFAULT 'draw_request',
  amount numeric,
  status text NOT NULL DEFAULT 'requested',
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.claim_check_mortgage_draws ENABLE ROW LEVEL SECURITY;

-- RLS policies for authenticated users
CREATE POLICY "Authenticated users can view mortgage draws"
  ON public.claim_check_mortgage_draws FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert mortgage draws"
  ON public.claim_check_mortgage_draws FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update mortgage draws"
  ON public.claim_check_mortgage_draws FOR UPDATE TO authenticated USING (true);

-- Trigger for updated_at
CREATE TRIGGER update_claim_check_mortgage_draws_updated_at
  BEFORE UPDATE ON public.claim_check_mortgage_draws
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
