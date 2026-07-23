GRANT SELECT ON public.tenants TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants TO authenticated;
GRANT ALL ON public.tenants TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_users TO authenticated;
GRANT ALL ON public.tenant_users TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenants'
      AND policyname = 'Public can view active tenants for login routing'
  ) THEN
    CREATE POLICY "Public can view active tenants for login routing"
    ON public.tenants
    FOR SELECT
    TO anon
    USING (subscription_status = 'active');
  END IF;
END $$;