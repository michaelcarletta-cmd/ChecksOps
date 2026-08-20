ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS invoice_accent_color text,
  ADD COLUMN IF NOT EXISTS invoice_theme text NOT NULL DEFAULT 'light';