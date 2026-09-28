-- Moov generally available for every existing and future ChecksOps tenant.
-- Removes Freedom-only / pilot allowlist gating. Does not touch CheckAlt
-- deposit workflows, and does not waive identity/KYB, ToS, bank
-- verification, wallet, or capability requirements.

-- Existing tenants can begin/complete Moov onboarding without a manual allowlist.
UPDATE public.tenants
SET moov_allowlisted = true
WHERE moov_allowlisted IS DISTINCT FROM true;

UPDATE public.tenants
SET payment_provider = 'moov'
WHERE payment_provider IS NULL OR btrim(payment_provider) = '';

-- Live tenants that have not started Moov onboarding use production credentials.
UPDATE public.tenants t
SET moov_environment = 'production'
WHERE COALESCE(t.is_test_account, false) = false
  AND lower(COALESCE(t.moov_environment, '')) IS DISTINCT FROM 'production'
  AND NOT EXISTS (
    SELECT 1
    FROM public.payment_provider_accounts p
    WHERE p.tenant_id = t.id
      AND p.provider = 'moov'
  );

-- Test accounts that have not started Moov stay on the sandbox ledger.
UPDATE public.tenants t
SET moov_environment = 'sandbox'
WHERE t.is_test_account = true
  AND lower(COALESCE(t.moov_environment, '')) IS DISTINCT FROM 'sandbox'
  AND NOT EXISTS (
    SELECT 1
    FROM public.payment_provider_accounts p
    WHERE p.tenant_id = t.id
      AND p.provider = 'moov'
  );

ALTER TABLE public.tenants ALTER COLUMN moov_allowlisted SET DEFAULT true;
ALTER TABLE public.tenants ALTER COLUMN payment_provider SET DEFAULT 'moov';
ALTER TABLE public.tenants ALTER COLUMN moov_environment SET DEFAULT 'production';

CREATE OR REPLACE FUNCTION public.apply_tenant_moov_ga_defaults()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.moov_allowlisted := true;
  IF NEW.payment_provider IS NULL OR btrim(NEW.payment_provider) = '' THEN
    NEW.payment_provider := 'moov';
  END IF;
  IF COALESCE(NEW.is_test_account, false) THEN
    NEW.moov_environment := 'sandbox';
  ELSIF NEW.moov_environment IS NULL OR btrim(NEW.moov_environment) = '' THEN
    NEW.moov_environment := 'production';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_tenant_moov_ga_defaults ON public.tenants;
CREATE TRIGGER trg_apply_tenant_moov_ga_defaults
  BEFORE INSERT ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.apply_tenant_moov_ga_defaults();
