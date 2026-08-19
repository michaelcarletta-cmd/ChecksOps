ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS invoice_letterhead_url TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS invoice_footer_note TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS invoice_default_terms TEXT;