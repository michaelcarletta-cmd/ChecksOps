ALTER TABLE public.tenants 
ADD COLUMN IF NOT EXISTS actum_syspass TEXT,
ADD COLUMN IF NOT EXISTS actum_username TEXT,
ADD COLUMN IF NOT EXISTS actum_password TEXT;

COMMENT ON COLUMN public.tenants.actum_syspass IS 'The API secret key provided by Actum (Syspass).';
COMMENT ON COLUMN public.tenants.actum_username IS 'The API username provided by Actum.';
COMMENT ON COLUMN public.tenants.actum_password IS 'The API password provided by Actum.';