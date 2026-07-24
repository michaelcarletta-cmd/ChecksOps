
CREATE TABLE public.payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  stakeholder_account_id uuid NOT NULL REFERENCES public.stakeholder_accounts(id),
  disbursement_batch_id uuid REFERENCES public.disbursement_batches(id),
  amount numeric NOT NULL CHECK (amount > 0),
  speed text NOT NULL DEFAULT 'next_day' CHECK (speed IN ('next_day','same_day','instant')),
  memo text,
  initiated_by uuid NOT NULL REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','completed','failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.payroll_runs TO authenticated;
GRANT ALL ON public.payroll_runs TO service_role;

ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;

-- Admin-only, tenant-scoped
CREATE POLICY "payroll_runs_admin_select" ON public.payroll_runs
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id = auth.uid() AND tu.tenant_id = payroll_runs.tenant_id
  )
);

CREATE POLICY "payroll_runs_admin_insert" ON public.payroll_runs
FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'admin'::app_role)
  AND initiated_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id = auth.uid() AND tu.tenant_id = payroll_runs.tenant_id
  )
);

CREATE POLICY "payroll_runs_admin_update" ON public.payroll_runs
FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id = auth.uid() AND tu.tenant_id = payroll_runs.tenant_id
  )
);

CREATE INDEX payroll_runs_tenant_created_idx ON public.payroll_runs (tenant_id, created_at DESC);
CREATE INDEX payroll_runs_stakeholder_idx ON public.payroll_runs (stakeholder_account_id);

CREATE TRIGGER payroll_runs_set_updated_at
BEFORE UPDATE ON public.payroll_runs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
