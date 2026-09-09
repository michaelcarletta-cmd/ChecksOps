-- DO NOT APPLY THIS FILE.
-- Reserved for a later human-approved CheckAlt production activation.
-- AWS_FINANCIAL_PERMISSIONS_ACTIVATED, AWS_PROVIDER_EXECUTION_ENABLED, and
-- AWS_CHECKALT_ENABLED must remain false until that review.
--
-- This migration does not create checksops/production/providers.
-- It does not load credentials. It does not enable provider HTTP.
--
-- When (and only when) activation is explicitly approved:
--   1. Apply this file to production RDS
--   2. Then load PROVIDER_SECRETS_ARN → checksops/production/providers
--   3. Then lift financial/provider flags in the documented sequence
--
-- Writer requirements:
-- 1. Require current_setting('request.financial_execution', true) = '1'
-- 2. Require current_setting('request.aws_financial_permissions_activated', true) = '1'
-- 3. Scope writes to the mapped tenant / owned checkalt_deposits row
-- 4. Never accept browser-supplied tenant_id, user_id, or amount as authority
-- 5. Persist idempotency_key BEFORE FinCapture HTTP

ALTER TABLE public.checkalt_deposits
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS amount_cents bigint,
  ADD COLUMN IF NOT EXISTS provider_http_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_class text,
  ADD COLUMN IF NOT EXISTS last_error text;

CREATE UNIQUE INDEX IF NOT EXISTS checkalt_deposits_tenant_idempotency_key_uq
  ON public.checkalt_deposits (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_checkalt_deposits_idempotency_key
  ON public.checkalt_deposits (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.checkalt_deposits.idempotency_key IS
  'sha256(tenant_id|checkalt_deposit|check_id|amount_cents|USD). Inserted before FinCapture HTTP.';
COMMENT ON COLUMN public.checkalt_deposits.amount_cents IS
  'Integer-cent amount derived from check_intake_items.amount. Browser amounts are not stored as authority.';
COMMENT ON COLUMN public.checkalt_deposits.provider_http_attempted_at IS
  'Set immediately before POST /fincapture/deposit/process. Presence without checkalt_reference means reconcile, do not POST again.';

CREATE OR REPLACE FUNCTION public.aws_financial_execution_active()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('request.financial_execution', true) = '1'
     AND current_setting('request.aws_financial_permissions_activated', true) = '1';
$$;

COMMENT ON FUNCTION public.aws_financial_execution_active() IS
  'True only when the AWS CheckAlt production writer bound financial GUCs. Default false.';

REVOKE ALL ON FUNCTION public.aws_financial_execution_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_financial_execution_active() TO checksops, authenticated;

-- Privileged production config read. Never returns webhook_secret, cached_jwt, or passwords.
CREATE OR REPLACE FUNCTION public.aws_checkalt_production_config()
RETURNS TABLE (
  merchant text,
  fi_key text,
  base_url text,
  default_enabled boolean,
  depositor_account_id text,
  business_unit text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF NOT public.aws_financial_execution_active() THEN
    RAISE EXCEPTION 'checkalt production config requires financial execution GUCs'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT c.merchant,
           c.fi_key,
           c.base_url,
           c.default_enabled,
           c.depositor_account_id,
           c.business_unit
    FROM public.checkalt_config c
    WHERE c.singleton IS TRUE
    LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.aws_checkalt_production_config() IS
  'Server-side CheckAlt merchant/FI/base_url. Blocked unless financial execution GUCs are set. No secrets.';

REVOKE ALL ON FUNCTION public.aws_checkalt_production_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_checkalt_production_config() TO checksops;

DROP POLICY IF EXISTS aws_financial_insert_checkalt_deposits ON public.checkalt_deposits;
CREATE POLICY aws_financial_insert_checkalt_deposits ON public.checkalt_deposits
  FOR INSERT TO authenticated
  WITH CHECK (
    public.aws_is_authenticated()
    AND public.aws_financial_execution_active()
    AND public.aws_can_access_tenant(tenant_id)
  );

DROP POLICY IF EXISTS aws_financial_update_checkalt_deposits ON public.checkalt_deposits;
CREATE POLICY aws_financial_update_checkalt_deposits ON public.checkalt_deposits
  FOR UPDATE TO authenticated
  USING (
    public.aws_is_authenticated()
    AND public.aws_financial_execution_active()
    AND public.aws_can_access_tenant(tenant_id)
  )
  WITH CHECK (
    public.aws_is_authenticated()
    AND public.aws_financial_execution_active()
    AND public.aws_can_access_tenant(tenant_id)
  );

GRANT SELECT, INSERT, UPDATE ON TABLE public.checkalt_deposits TO checksops;

SELECT 'NOT_APPLIED'::text AS aws_checkalt_production_writer;
