ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS actum_parent_id TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS actum_sub_id TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS actum_webhook_secret TEXT;

COMMENT ON COLUMN public.tenants.actum_parent_id IS 'Actum Processing Parent ID for the tenant';
COMMENT ON COLUMN public.tenants.actum_sub_id IS 'Actum Processing Sub ID for the tenant';
COMMENT ON COLUMN public.tenants.actum_webhook_secret IS 'Secret key for validating Actum webhooks for this tenant';

-- Grant access to authenticated users (admin logic handles actual access control in app)
GRANT SELECT, UPDATE ON public.tenants TO authenticated;
GRANT ALL ON public.tenants TO service_role;