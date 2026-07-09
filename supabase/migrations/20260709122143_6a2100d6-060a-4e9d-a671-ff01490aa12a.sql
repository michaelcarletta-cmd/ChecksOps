ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS lead_id uuid
  REFERENCES public.homeowner_intro_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_check_intake_items_lead_id
  ON public.check_intake_items(lead_id)
  WHERE lead_id IS NOT NULL;