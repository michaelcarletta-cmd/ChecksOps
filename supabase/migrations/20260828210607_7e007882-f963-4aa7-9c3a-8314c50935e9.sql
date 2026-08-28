ALTER TABLE public.tenants ALTER COLUMN moov_allowlisted SET DEFAULT true;
ALTER TABLE public.tenants ALTER COLUMN payment_provider SET DEFAULT 'moov';