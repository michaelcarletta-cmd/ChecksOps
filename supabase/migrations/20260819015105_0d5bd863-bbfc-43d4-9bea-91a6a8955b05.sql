CREATE TABLE IF NOT EXISTS public.moov_invoice_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  environment text NOT NULL DEFAULT 'sandbox',
  display_name text NOT NULL,
  email text NOT NULL,
  phone text,
  customer_type text NOT NULL DEFAULT 'business',
  moov_account_id text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS moov_invoice_customers_tenant_email_uidx
  ON public.moov_invoice_customers (tenant_id, environment, lower(email));

CREATE TABLE IF NOT EXISTS public.moov_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  environment text NOT NULL DEFAULT 'sandbox',
  moov_account_id text NOT NULL,
  moov_invoice_id text,
  invoice_number text,
  customer_id uuid REFERENCES public.moov_invoice_customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_moov_account_id text,
  description text,
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_amount numeric(12,2) NOT NULL DEFAULT 0,
  paid_amount numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  invoice_date date,
  due_date date,
  payment_link_url text,
  sent_at timestamptz,
  paid_at timestamptz,
  claim_id uuid,
  last_synced_at timestamptz,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS moov_invoices_provider_uidx
  ON public.moov_invoices (moov_invoice_id) WHERE moov_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS moov_invoices_tenant_idx ON public.moov_invoices (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.moov_invoices TO authenticated;
GRANT ALL ON public.moov_invoices TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moov_invoice_customers TO authenticated;
GRANT ALL ON public.moov_invoice_customers TO service_role;

ALTER TABLE public.moov_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moov_invoice_customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members manage their invoices"
  ON public.moov_invoices FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = moov_invoices.tenant_id AND tu.user_id = auth.uid())
    OR public.has_role(auth.uid(), 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = moov_invoices.tenant_id AND tu.user_id = auth.uid())
    OR public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "Tenant members manage their invoice customers"
  ON public.moov_invoice_customers FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = moov_invoice_customers.tenant_id AND tu.user_id = auth.uid())
    OR public.has_role(auth.uid(), 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = moov_invoice_customers.tenant_id AND tu.user_id = auth.uid())
    OR public.has_role(auth.uid(), 'admin')
  );

CREATE TRIGGER moov_invoices_set_updated_at BEFORE UPDATE ON public.moov_invoices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER moov_invoice_customers_set_updated_at BEFORE UPDATE ON public.moov_invoice_customers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();