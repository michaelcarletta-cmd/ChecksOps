-- Staging-safe financial_stepup_log.
-- Mirrors production table from supabase/migrations/20260901202134_*.sql
-- (added after the Sept. 1 dump). Used by StepUpDialog after TOTP.
--
-- Does not migrate passkey credential tables.
-- Does not add the Cognito-replaced profile login-preference column.
-- Does not GRANT DML on money-movement tables.
-- Does not apply production financial activation grants.
-- Does not change DNS, Auth, webhooks, or provider execution flags.

CREATE TABLE IF NOT EXISTS public.financial_stepup_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  tenant_id UUID,
  action_key TEXT NOT NULL,
  factor_type TEXT NOT NULL DEFAULT 'totp',
  succeeded BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_financial_stepup_log_user
  ON public.financial_stepup_log (user_id);
CREATE INDEX IF NOT EXISTS idx_financial_stepup_log_tenant
  ON public.financial_stepup_log (tenant_id);

COMMENT ON TABLE public.financial_stepup_log IS
  'Append-only TOTP step-up audit for money-movement confirmation. Not a financial ledger.';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
GRANT authenticated TO checksops;

GRANT SELECT, INSERT ON TABLE public.financial_stepup_log TO checksops, authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.financial_stepup_log TO service_role;
  END IF;
END $$;

ALTER TABLE public.financial_stepup_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users record own step-up events" ON public.financial_stepup_log;
DROP POLICY IF EXISTS "Users view own step-up events" ON public.financial_stepup_log;
DROP POLICY IF EXISTS "Tenant admins view tenant step-up events" ON public.financial_stepup_log;
DROP POLICY IF EXISTS aws_select_financial_stepup_log ON public.financial_stepup_log;
DROP POLICY IF EXISTS aws_write_financial_stepup_log ON public.financial_stepup_log;

CREATE POLICY aws_select_financial_stepup_log ON public.financial_stepup_log
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.aws_is_cross_tenant_reader()
    OR (
      tenant_id IS NOT NULL
      AND public.aws_can_access_tenant(tenant_id)
      AND public.has_role(auth.uid(), 'admin'::public.app_role)
    )
  );

CREATE POLICY aws_write_financial_stepup_log ON public.financial_stepup_log
  FOR INSERT TO authenticated
  WITH CHECK (public.aws_is_authenticated() AND user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.set_updated_at_generic()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_financial_stepup_log_updated_at ON public.financial_stepup_log;
CREATE TRIGGER trg_financial_stepup_log_updated_at
  BEFORE UPDATE ON public.financial_stepup_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_generic();
