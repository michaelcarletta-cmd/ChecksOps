GRANT SELECT, INSERT ON public.tenant_usage_logs TO authenticated;
GRANT ALL ON public.tenant_usage_logs TO service_role;
ALTER TABLE public.tenant_usage_logs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON public.tenants TO authenticated;
GRANT ALL ON public.tenants TO service_role;