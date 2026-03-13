
-- Add pinning support to claim_events
ALTER TABLE public.claim_events ADD COLUMN IF NOT EXISTS is_pinned boolean DEFAULT false;
ALTER TABLE public.claim_events ADD COLUMN IF NOT EXISTS importance_score integer DEFAULT 0;

-- Add reason tags and carrier comparison to estimate lines
ALTER TABLE public.darwin_estimate_lines ADD COLUMN IF NOT EXISTS reason_tag text;
ALTER TABLE public.darwin_estimate_lines ADD COLUMN IF NOT EXISTS rationale text;
ALTER TABLE public.darwin_estimate_lines ADD COLUMN IF NOT EXISTS carrier_quantity numeric;
ALTER TABLE public.darwin_estimate_lines ADD COLUMN IF NOT EXISTS carrier_unit_price numeric;
ALTER TABLE public.darwin_estimate_lines ADD COLUMN IF NOT EXISTS carrier_total numeric GENERATED ALWAYS AS (COALESCE(carrier_quantity, 0) * COALESCE(carrier_unit_price, 0)) STORED;
ALTER TABLE public.darwin_estimate_lines ADD COLUMN IF NOT EXISTS variance_amount numeric GENERATED ALWAYS AS ((quantity * unit_price) - (COALESCE(carrier_quantity, 0) * COALESCE(carrier_unit_price, 0))) STORED;
