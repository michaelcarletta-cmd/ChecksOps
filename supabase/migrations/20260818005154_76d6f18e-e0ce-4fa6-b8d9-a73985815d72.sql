CREATE TABLE IF NOT EXISTS public.payment_sweep_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  wallet_id uuid REFERENCES public.payment_wallets(id) ON DELETE SET NULL,
  provider_account_id text,
  provider_wallet_id text,
  provider_sweep_config_id text,
  status text NOT NULL DEFAULT 'disabled',
  push_payment_method_id text,
  push_rail text,
  pull_payment_method_id text,
  pull_rail text,
  minimum_balance_cents integer NOT NULL DEFAULT 0,
  statement_descriptor text,
  provider_created_at timestamptz,
  provider_updated_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_sweep_configs_status_check CHECK (status IN ('enabled','disabled')),
  CONSTRAINT payment_sweep_configs_min_balance_check CHECK (minimum_balance_cents >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_sweep_configs_unique_wallet
  ON public.payment_sweep_configs (tenant_id, provider, environment, COALESCE(provider_wallet_id, ''));

CREATE UNIQUE INDEX IF NOT EXISTS payment_sweep_configs_unique_provider_id
  ON public.payment_sweep_configs (provider, environment, provider_sweep_config_id)
  WHERE provider_sweep_config_id IS NOT NULL;

GRANT SELECT ON public.payment_sweep_configs TO authenticated;
GRANT ALL ON public.payment_sweep_configs TO service_role;

ALTER TABLE public.payment_sweep_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read sweep configs"
  ON public.payment_sweep_configs FOR SELECT TO authenticated
  USING (is_tenant_member(auth.uid(), tenant_id) OR has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins manage sweep configs"
  ON public.payment_sweep_configs FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER set_payment_sweep_configs_updated_at
  BEFORE UPDATE ON public.payment_sweep_configs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();