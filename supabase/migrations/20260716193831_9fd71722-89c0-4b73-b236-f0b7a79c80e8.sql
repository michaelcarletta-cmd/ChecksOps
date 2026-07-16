
ALTER TABLE public.mortgage_handling_requests
  ADD COLUMN IF NOT EXISTS endorsement_order integer,
  ADD COLUMN IF NOT EXISTS predecessor_request_id uuid REFERENCES public.mortgage_handling_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS total_mortgagees integer,
  ADD COLUMN IF NOT EXISTS check_sent_date timestamptz,
  ADD COLUMN IF NOT EXISTS check_received_back_date timestamptz;

CREATE INDEX IF NOT EXISTS idx_mhr_predecessor ON public.mortgage_handling_requests(predecessor_request_id);
CREATE INDEX IF NOT EXISTS idx_mhr_check_intake_item ON public.mortgage_handling_requests(check_intake_item_id);
