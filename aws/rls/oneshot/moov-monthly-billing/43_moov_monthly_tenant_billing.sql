-- AWS RDS: Moov monthly tenant subscription billing.
-- Do not apply this via Supabase. Does not change CheckAlt or insurance-check
-- money movement. tenant_maintenance_payments is the occurrence ledger.

CREATE TABLE IF NOT EXISTS public.tenant_billing_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  billing_enabled boolean NOT NULL DEFAULT false,
  billing_day_of_month integer NOT NULL DEFAULT 1
    CHECK (billing_day_of_month >= 1 AND billing_day_of_month <= 28),
  next_period_start date,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tenant_billing_settings IS
  'Narrow monthly subscription settings. Not a generic tenant write target.';

CREATE TABLE IF NOT EXISTS public.platform_billing_destination (
  environment text PRIMARY KEY CHECK (environment IN ('sandbox', 'production')),
  moov_account_id text NOT NULL,
  moov_payment_method_id text NOT NULL,
  label text NOT NULL DEFAULT 'ChecksOps merchant',
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.platform_billing_destination IS
  'Explicit ChecksOps approved merchant destination. Never first-wallet selection.';

ALTER TABLE public.tenant_billing_accounts
  ALTER COLUMN account_number_encrypted DROP NOT NULL,
  ALTER COLUMN routing_number DROP NOT NULL;

ALTER TABLE public.tenant_billing_accounts
  ADD COLUMN IF NOT EXISTS provider_payment_method_id text,
  ADD COLUMN IF NOT EXISTS provider_bank_account_id text,
  ADD COLUMN IF NOT EXISTS provider_account_id text,
  ADD COLUMN IF NOT EXISTS provider_environment text;

ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS monthly_rate_cents integer,
  ADD COLUMN IF NOT EXISTS discount_cents integer,
  ADD COLUMN IF NOT EXISTS billing_period text,
  ADD COLUMN IF NOT EXISTS funding_source_method_id text,
  ADD COLUMN IF NOT EXISTS destination_account_id text,
  ADD COLUMN IF NOT EXISTS destination_payment_method_id text,
  ADD COLUMN IF NOT EXISTS provider_transfer_id text,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS returned_at timestamptz,
  ADD COLUMN IF NOT EXISTS return_reason text,
  ADD COLUMN IF NOT EXISTS provider_environment text;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_maintenance_payments_tenant_period_uidx
  ON public.tenant_maintenance_payments (tenant_id, billing_period)
  WHERE billing_period IS NOT NULL;

CREATE INDEX IF NOT EXISTS tenant_maintenance_payments_provider_transfer_idx
  ON public.tenant_maintenance_payments (provider_transfer_id)
  WHERE provider_transfer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.aws_monthly_billing_job()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('request.monthly_billing_job', true) = '1';
$$;

COMMENT ON FUNCTION public.aws_monthly_billing_job() IS
  'True only when the AWS monthly billing scheduler/webhook sets request.monthly_billing_job=1.';

REVOKE ALL ON FUNCTION public.aws_monthly_billing_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_monthly_billing_job() TO checksops, authenticated;

CREATE OR REPLACE FUNCTION public.aws_can_authorize_tenant_billing(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.is_platform_owner()
      OR EXISTS (
        SELECT 1
        FROM public.tenant_users tu
        WHERE tu.user_id = auth.uid()
          AND tu.tenant_id = _tenant_id
          AND tu.role = 'admin'::public.tenant_role
      );
$$;

COMMENT ON FUNCTION public.aws_can_authorize_tenant_billing(uuid) IS
  'Platform owner or the tenant owner/admin may authorize that tenant billing source.';

REVOKE ALL ON FUNCTION public.aws_can_authorize_tenant_billing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_can_authorize_tenant_billing(uuid) TO checksops, authenticated;

ALTER TABLE public.tenant_billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_billing_destination ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aws_select_tenant_billing_settings ON public.tenant_billing_settings;
CREATE POLICY aws_select_tenant_billing_settings ON public.tenant_billing_settings
  FOR SELECT TO authenticated
  USING (
    public.aws_is_cross_tenant_reader()
    OR public.aws_can_access_tenant(tenant_id)
    OR public.aws_monthly_billing_job()
  );

DROP POLICY IF EXISTS aws_write_tenant_billing_settings ON public.tenant_billing_settings;
CREATE POLICY aws_write_tenant_billing_settings ON public.tenant_billing_settings
  FOR ALL TO authenticated
  USING (public.is_platform_owner() OR public.aws_monthly_billing_job())
  WITH CHECK (public.is_platform_owner() OR public.aws_monthly_billing_job());

DROP POLICY IF EXISTS aws_select_platform_billing_destination ON public.platform_billing_destination;
CREATE POLICY aws_select_platform_billing_destination ON public.platform_billing_destination
  FOR SELECT TO authenticated
  USING (public.is_platform_owner() OR public.aws_monthly_billing_job());

DROP POLICY IF EXISTS aws_write_platform_billing_destination ON public.platform_billing_destination;
CREATE POLICY aws_write_platform_billing_destination ON public.platform_billing_destination
  FOR ALL TO authenticated
  USING (public.is_platform_owner())
  WITH CHECK (public.is_platform_owner());

DROP POLICY IF EXISTS aws_write_tenant_billing_accounts ON public.tenant_billing_accounts;
CREATE POLICY aws_write_tenant_billing_accounts ON public.tenant_billing_accounts
  FOR ALL TO authenticated
  USING (
    public.aws_can_authorize_tenant_billing(tenant_id)
    OR public.aws_monthly_billing_job()
  )
  WITH CHECK (
    public.aws_can_authorize_tenant_billing(tenant_id)
    OR public.aws_monthly_billing_job()
  );

DROP POLICY IF EXISTS aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments;
CREATE POLICY aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments
  FOR ALL TO authenticated
  USING (
    public.is_platform_owner()
    OR public.aws_monthly_billing_job()
    OR current_setting('request.provider_webhook_apply', true) = '1'
  )
  WITH CHECK (
    public.is_platform_owner()
    OR public.aws_monthly_billing_job()
    OR current_setting('request.provider_webhook_apply', true) = '1'
  );

GRANT SELECT, INSERT, UPDATE ON public.tenant_billing_settings TO checksops, authenticated;
GRANT SELECT ON public.platform_billing_destination TO checksops, authenticated;
GRANT INSERT, UPDATE ON public.platform_billing_destination TO checksops;
GRANT SELECT, INSERT, UPDATE ON public.tenant_billing_accounts TO checksops, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tenant_maintenance_payments TO checksops, authenticated;
