-- Align the isolated probe table with tenant-membership + platform-owner helpers.

DROP POLICY IF EXISTS aws_rls_probe_select ON public._aws_rls_probe_items;
CREATE POLICY aws_rls_probe_select ON public._aws_rls_probe_items
  FOR SELECT
  TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));
