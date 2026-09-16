-- Tenant CheckAlt Auto-Deposit policy + append-only decision audit.
-- Default OFF. Threshold is integer cents. No money-movement grants.
-- Does not reuse auto_approve_* (those mean CheckAlt status-40 auto-approve).

CREATE TABLE IF NOT EXISTS public.checkalt_tenant_deposit_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  auto_deposit_enabled boolean NOT NULL DEFAULT false,
  auto_deposit_max_cents bigint,
  auto_deposit_updated_at timestamptz,
  auto_deposit_updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkalt_tenant_deposit_settings_max_cents_chk
    CHECK (auto_deposit_max_cents IS NULL OR auto_deposit_max_cents >= 0)
);

CREATE TABLE IF NOT EXISTS public.checkalt_auto_deposit_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  check_intake_item_id uuid,
  amount_cents bigint,
  auto_deposit_enabled boolean,
  auto_deposit_max_cents bigint,
  eligible boolean NOT NULL,
  reason text NOT NULL,
  trigger text NOT NULL,
  actor text NOT NULL DEFAULT 'system:auto_deposit',
  deposit_id uuid,
  checkalt_reference text,
  submit_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkalt_auto_deposit_decisions_check
  ON public.checkalt_auto_deposit_decisions (check_intake_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkalt_auto_deposit_decisions_tenant
  ON public.checkalt_auto_deposit_decisions (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.checkalt_auto_deposit_settings_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  stepup_id uuid,
  previous_enabled boolean,
  previous_max_cents bigint,
  new_enabled boolean NOT NULL,
  new_max_cents bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkalt_auto_deposit_settings_audit_tenant
  ON public.checkalt_auto_deposit_settings_audit (tenant_id, created_at DESC);

COMMENT ON TABLE public.checkalt_tenant_deposit_settings IS
  'Tenant CheckAlt Auto-Deposit policy. Default OFF. Distinct from auto_approve_* status-40 helpers.';
COMMENT ON TABLE public.checkalt_auto_deposit_decisions IS
  'Append-only Auto-Deposit eligibility and execution audit. Never a second process POST source.';
COMMENT ON TABLE public.checkalt_auto_deposit_settings_audit IS
  'Append-only Auto-Deposit configuration changes. Requires financial TOTP on write.';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
GRANT authenticated TO checksops;

GRANT SELECT ON TABLE public.checkalt_tenant_deposit_settings TO checksops, authenticated;
GRANT INSERT, UPDATE ON TABLE public.checkalt_tenant_deposit_settings TO checksops;
GRANT SELECT ON TABLE public.checkalt_auto_deposit_decisions TO checksops, authenticated;
GRANT INSERT ON TABLE public.checkalt_auto_deposit_decisions TO checksops;
GRANT SELECT ON TABLE public.checkalt_auto_deposit_settings_audit TO checksops, authenticated;
GRANT INSERT ON TABLE public.checkalt_auto_deposit_settings_audit TO checksops;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.checkalt_tenant_deposit_settings TO service_role;
    GRANT ALL ON TABLE public.checkalt_auto_deposit_decisions TO service_role;
    GRANT ALL ON TABLE public.checkalt_auto_deposit_settings_audit TO service_role;
  END IF;
END $$;

ALTER TABLE public.checkalt_tenant_deposit_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkalt_auto_deposit_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkalt_auto_deposit_settings_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aws_select_auto_deposit_settings ON public.checkalt_tenant_deposit_settings;
DROP POLICY IF EXISTS aws_write_auto_deposit_settings ON public.checkalt_tenant_deposit_settings;
DROP POLICY IF EXISTS aws_select_auto_deposit_decisions ON public.checkalt_auto_deposit_decisions;
DROP POLICY IF EXISTS aws_insert_auto_deposit_decisions ON public.checkalt_auto_deposit_decisions;
DROP POLICY IF EXISTS aws_select_auto_deposit_settings_audit ON public.checkalt_auto_deposit_settings_audit;
DROP POLICY IF EXISTS aws_insert_auto_deposit_settings_audit ON public.checkalt_auto_deposit_settings_audit;

CREATE POLICY aws_select_auto_deposit_settings ON public.checkalt_tenant_deposit_settings
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id) OR public.aws_is_cross_tenant_reader());

CREATE POLICY aws_write_auto_deposit_settings ON public.checkalt_tenant_deposit_settings
  FOR ALL TO checksops
  USING (true)
  WITH CHECK (true);

CREATE POLICY aws_select_auto_deposit_decisions ON public.checkalt_auto_deposit_decisions
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id) OR public.aws_is_cross_tenant_reader());

CREATE POLICY aws_insert_auto_deposit_decisions ON public.checkalt_auto_deposit_decisions
  FOR INSERT TO checksops
  WITH CHECK (true);

CREATE POLICY aws_select_auto_deposit_settings_audit ON public.checkalt_auto_deposit_settings_audit
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id) OR public.aws_is_cross_tenant_reader());

CREATE POLICY aws_insert_auto_deposit_settings_audit ON public.checkalt_auto_deposit_settings_audit
  FOR INSERT TO checksops
  WITH CHECK (true);
