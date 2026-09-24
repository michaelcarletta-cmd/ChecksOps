-- Staging operator SQL: allow platform-owner tenant INSERT.
-- Complements the /data/write allowlist repair. Does not rewrite Freedom rows.
-- Does not grant UPDATE of Moov/CheckAlt/bank/provider columns.
-- Do not apply automatically from CI. Operator review required.

GRANT INSERT ON TABLE public.tenants TO checksops;

DROP POLICY IF EXISTS aws_insert_tenants_platform_owner ON public.tenants;
CREATE POLICY aws_insert_tenants_platform_owner ON public.tenants
  FOR INSERT TO authenticated
  WITH CHECK (
    COALESCE(public.is_master_owner(), false)
    OR COALESCE(public.is_platform_owner(), false)
  );

COMMENT ON POLICY aws_insert_tenants_platform_owner ON public.tenants IS
  'Platform owner only. Tenant members cannot create tenants.';
