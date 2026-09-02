-- Isolated RLS probe table only. Do not ENABLE ROW LEVEL SECURITY on restored tables.

CREATE TABLE IF NOT EXISTS public._aws_rls_probe_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  label text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public._aws_rls_probe_items IS
  'Staging-only RLS isolation probe. Not application data. Safe to drop after cutover.';

REVOKE ALL ON TABLE public._aws_rls_probe_items FROM PUBLIC;
GRANT SELECT ON TABLE public._aws_rls_probe_items TO checksops;

ALTER TABLE public._aws_rls_probe_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aws_rls_probe_select ON public._aws_rls_probe_items;
CREATE POLICY aws_rls_probe_select ON public._aws_rls_probe_items
  FOR SELECT
  TO authenticated
  USING (tenant_id IN (SELECT public.aws_user_tenant_ids()));

-- No INSERT/UPDATE/DELETE policies: writes are denied by RLS default.

INSERT INTO public._aws_rls_probe_items (tenant_id, label)
VALUES
  ('2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', 'freedom-probe-visible'),
  ('4f172140-f57a-4744-8050-95f4f07b13b4', 'c1c-probe-hidden'),
  ('fd77533e-6e72-4f28-a22d-cf026b392a4f', 'barzzini-probe-hidden')
ON CONFLICT (label) DO UPDATE SET tenant_id = EXCLUDED.tenant_id;
