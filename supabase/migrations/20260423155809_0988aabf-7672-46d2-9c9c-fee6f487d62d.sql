
ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS mortgage_monitoring_type text NOT NULL DEFAULT 'not_set',
  ADD COLUMN IF NOT EXISTS mortgage_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS mortgage_tracking_number text,
  ADD COLUMN IF NOT EXISTS mortgage_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS mortgage_final_released_at timestamptz;

CREATE TABLE IF NOT EXISTS public.check_intake_mortgage_draws (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  draw_number integer NOT NULL DEFAULT 1,
  draw_type text NOT NULL DEFAULT 'draw_request',
  amount numeric,
  status text NOT NULL DEFAULT 'requested',
  notes text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.check_intake_mortgage_draws ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage mortgage draws"
  ON public.check_intake_mortgage_draws
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
