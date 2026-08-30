ALTER TABLE public.mortgage_handling_requests
  ADD COLUMN IF NOT EXISTS mail_to_name text,
  ADD COLUMN IF NOT EXISTS mail_to_address text,
  ADD COLUMN IF NOT EXISTS shipping_label_path text,
  ADD COLUMN IF NOT EXISTS shipping_label_name text,
  ADD COLUMN IF NOT EXISTS shipping_label_carrier text,
  ADD COLUMN IF NOT EXISTS shipping_label_tracking text,
  ADD COLUMN IF NOT EXISTS shipping_label_uploaded_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS shipping_label_uploaded_by uuid;