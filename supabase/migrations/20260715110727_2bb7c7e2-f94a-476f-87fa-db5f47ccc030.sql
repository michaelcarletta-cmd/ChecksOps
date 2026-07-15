
-- Singleton config table for mortgage desk
CREATE TABLE public.mortgage_desk_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  default_flat_fee_cents integer NOT NULL DEFAULT 1500 CHECK (default_flat_fee_cents > 0),
  notification_email text,
  charge_immediately boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.mortgage_desk_config TO authenticated;
GRANT ALL ON public.mortgage_desk_config TO service_role;
ALTER TABLE public.mortgage_desk_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated can read mortgage desk config"
  ON public.mortgage_desk_config FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins can update mortgage desk config"
  ON public.mortgage_desk_config FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "admins can insert mortgage desk config"
  ON public.mortgage_desk_config FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.mortgage_desk_config (id) VALUES (true) ON CONFLICT DO NOTHING;

-- Main queue table
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  check_intake_item_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  claim_id uuid,
  mortgage_company text,
  mortgage_servicer text,
  loan_number text,
  note text,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','in_progress','completed','cancelled')),
  assigned_employee_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  work_notes text,
  -- billing fields (used in Phase 3, safe to create now)
  flat_fee_cents integer,
  billed_at timestamptz,
  stripe_invoice_item_id text,
  billing_status text NOT NULL DEFAULT 'unbilled'
    CHECK (billing_status IN ('unbilled','billed','failed')),
  billing_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Prevent two open requests for the same check
CREATE UNIQUE INDEX mortgage_handling_requests_one_open_per_check
  ON public.mortgage_handling_requests (check_intake_item_id)
  WHERE status IN ('requested','in_progress');

CREATE INDEX mortgage_handling_requests_tenant_idx
  ON public.mortgage_handling_requests (tenant_id, status);
CREATE INDEX mortgage_handling_requests_status_idx
  ON public.mortgage_handling_requests (status, created_at);
CREATE INDEX mortgage_handling_requests_assigned_idx
  ON public.mortgage_handling_requests (assigned_employee_id, status);

GRANT SELECT, INSERT, UPDATE ON public.mortgage_handling_requests TO authenticated;
GRANT ALL ON public.mortgage_handling_requests TO service_role;

ALTER TABLE public.mortgage_handling_requests ENABLE ROW LEVEL SECURITY;

-- Tenant users: read own tenant rows
CREATE POLICY "tenant can read own mortgage handling requests"
  ON public.mortgage_handling_requests FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR tenant_id IN (
      SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid()
    )
  );

-- Tenant users: insert for own tenant only
CREATE POLICY "tenant can create mortgage handling requests"
  ON public.mortgage_handling_requests FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id IN (
      SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid()
    )
    AND requested_by = auth.uid()
  );

-- Admins update everything; tenants may cancel their own still-requested rows
CREATE POLICY "admins can update all mortgage handling requests"
  ON public.mortgage_handling_requests FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "tenant can cancel own requested rows"
  ON public.mortgage_handling_requests FOR UPDATE TO authenticated
  USING (
    status = 'requested'
    AND tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid())
  )
  WITH CHECK (
    status IN ('requested','cancelled')
    AND tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid())
  );

-- updated_at trigger
CREATE TRIGGER mortgage_handling_requests_set_updated_at
  BEFORE UPDATE ON public.mortgage_handling_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER mortgage_desk_config_set_updated_at
  BEFORE UPDATE ON public.mortgage_desk_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
