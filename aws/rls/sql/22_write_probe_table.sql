-- Isolated write-authorization probe. Not application data.
-- RLS enabled. SELECT uses tenant membership; writes use aws_can_write_tenant.

CREATE TABLE IF NOT EXISTS public._aws_rls_write_probe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  label text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public._aws_rls_write_probe IS
  'Staging-only write RLS probe. Safe to drop after cutover. No financial meaning.';

REVOKE ALL ON TABLE public._aws_rls_write_probe FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public._aws_rls_write_probe TO checksops;

ALTER TABLE public._aws_rls_write_probe ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aws_rls_write_probe_select ON public._aws_rls_write_probe;
CREATE POLICY aws_rls_write_probe_select ON public._aws_rls_write_probe
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_rls_write_probe_insert ON public._aws_rls_write_probe;
CREATE POLICY aws_rls_write_probe_insert ON public._aws_rls_write_probe
  FOR INSERT TO authenticated
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_rls_write_probe_update ON public._aws_rls_write_probe;
CREATE POLICY aws_rls_write_probe_update ON public._aws_rls_write_probe
  FOR UPDATE TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_rls_write_probe_delete ON public._aws_rls_write_probe;
CREATE POLICY aws_rls_write_probe_delete ON public._aws_rls_write_probe
  FOR DELETE TO authenticated
  USING (public.aws_can_write_tenant(tenant_id));
