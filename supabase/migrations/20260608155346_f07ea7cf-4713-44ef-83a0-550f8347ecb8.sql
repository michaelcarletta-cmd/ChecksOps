ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS actum_sub_id_ppd TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS actum_sub_id_ccd TEXT;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants TO authenticated;
GRANT ALL ON public.tenants TO service_role;