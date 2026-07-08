
CREATE TABLE IF NOT EXISTS public.tenant_billing_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,
  nickname TEXT,
  account_holder_name TEXT NOT NULL,
  routing_number TEXT NOT NULL,
  account_number_last4 TEXT NOT NULL,
  account_number_encrypted TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'checking' CHECK (account_type IN ('checking','savings')),
  entity_type TEXT NOT NULL DEFAULT 'business' CHECK (entity_type IN ('business','consumer')),
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','admin_override','failed')),
  actum_consumer_unique TEXT,
  ach_authorized_at TIMESTAMPTZ,
  ach_authorized_by UUID REFERENCES auth.users(id),
  auto_debit_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_billing_accounts TO authenticated;
GRANT ALL ON public.tenant_billing_accounts TO service_role;

ALTER TABLE public.tenant_billing_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admin manages all billing accounts"
ON public.tenant_billing_accounts FOR ALL
TO authenticated
USING (auth.uid() IN (SELECT id FROM auth.users WHERE email = 'mcarletta@freedomadj.com'))
WITH CHECK (auth.uid() IN (SELECT id FROM auth.users WHERE email = 'mcarletta@freedomadj.com'));

CREATE POLICY "Tenant users view own billing account"
ON public.tenant_billing_accounts FOR SELECT
TO authenticated
USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE POLICY "Tenant users manage own billing account"
ON public.tenant_billing_accounts FOR INSERT
TO authenticated
WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE POLICY "Tenant users update own billing account"
ON public.tenant_billing_accounts FOR UPDATE
TO authenticated
USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()))
WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE TRIGGER update_tenant_billing_accounts_updated_at
  BEFORE UPDATE ON public.tenant_billing_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Extend maintenance payments
ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','pending','submitted','failed','returned','cleared')),
  ADD COLUMN IF NOT EXISTS actum_order_id TEXT,
  ADD COLUMN IF NOT EXISTS actum_history_id TEXT,
  ADD COLUMN IF NOT EXISTS actum_consumer_unique TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS idempotence_key TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
