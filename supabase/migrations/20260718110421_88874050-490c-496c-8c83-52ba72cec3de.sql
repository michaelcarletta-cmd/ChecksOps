
ALTER TABLE public.mortgage_handling_requests
  ADD COLUMN IF NOT EXISTS invoice_url text,
  ADD COLUMN IF NOT EXISTS invoice_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS invoice_recipient_email text,
  ADD COLUMN IF NOT EXISTS invoice_services_cents integer,
  ADD COLUMN IF NOT EXISTS invoice_shipping_cents integer,
  ADD COLUMN IF NOT EXISTS invoice_shipping_description text,
  ADD COLUMN IF NOT EXISTS invoice_notes text,
  ADD COLUMN IF NOT EXISTS invoice_number text;
