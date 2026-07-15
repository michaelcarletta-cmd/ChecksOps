
ALTER TABLE public.mortgage_handling_requests
  ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (billing_status IN ('pending','billed','failed','skipped')),
  ADD COLUMN IF NOT EXISTS billed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_invoice_item_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS billing_error TEXT;

CREATE INDEX IF NOT EXISTS mortgage_handling_requests_billing_status_idx
  ON public.mortgage_handling_requests (billing_status)
  WHERE billing_status IN ('pending','failed');
