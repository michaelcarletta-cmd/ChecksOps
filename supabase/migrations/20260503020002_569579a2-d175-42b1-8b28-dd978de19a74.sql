-- ============================================================
-- CheckAlt (FinCapture RDC) integration — Phase 1 foundation
-- Single ChecksOps-wide account model
-- ============================================================

-- 1) System-wide CheckAlt configuration (single row enforced by unique constant)
CREATE TABLE IF NOT EXISTS public.checkalt_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true,
  base_url text,
  business_unit text,
  depositor_account_id text,
  default_enabled boolean NOT NULL DEFAULT false,
  webhook_secret text,
  -- cached JWT (refreshed by edge function)
  cached_jwt text,
  cached_jwt_expires_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT checkalt_config_singleton_uq UNIQUE (singleton)
);

ALTER TABLE public.checkalt_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view checkalt config"
  ON public.checkalt_config FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update checkalt config"
  ON public.checkalt_config FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert checkalt config"
  ON public.checkalt_config FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Seed empty singleton row so admins can edit immediately
INSERT INTO public.checkalt_config (singleton, default_enabled)
VALUES (true, false)
ON CONFLICT (singleton) DO NOTHING;

-- 2) Per-check CheckAlt deposit tracking
CREATE TABLE IF NOT EXISTS public.checkalt_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_intake_item_id uuid REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  claim_check_id uuid,
  tenant_id uuid,
  checkalt_reference text UNIQUE,
  status text NOT NULL DEFAULT 'pending',
    -- pending | submitted | pending_approval | cleared | returned | rejected | error
  return_reason text,
  amount numeric,
  submitted_at timestamptz,
  cleared_at timestamptz,
  returned_at timestamptz,
  last_status_payload jsonb,
  last_polled_at timestamptz,
  submitted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkalt_deposits_check_intake
  ON public.checkalt_deposits (check_intake_item_id);
CREATE INDEX IF NOT EXISTS idx_checkalt_deposits_status
  ON public.checkalt_deposits (status);
CREATE INDEX IF NOT EXISTS idx_checkalt_deposits_tenant
  ON public.checkalt_deposits (tenant_id);

ALTER TABLE public.checkalt_deposits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view their checkalt deposits"
  ON public.checkalt_deposits FOR SELECT
  TO authenticated
  USING (
    tenant_id IS NULL
    OR public.user_belongs_to_tenant(auth.uid(), tenant_id)
    OR public.has_role(auth.uid(), 'admin')
  );

-- writes only via service-role (edge functions)
CREATE POLICY "Service role manages checkalt deposits"
  ON public.checkalt_deposits FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- 3) Inbound webhook event log (audit only)
CREATE TABLE IF NOT EXISTS public.checkalt_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text,
  checkalt_reference text,
  raw_payload jsonb NOT NULL,
  signature_valid boolean,
  processed boolean NOT NULL DEFAULT false,
  processed_at timestamptz,
  process_error text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkalt_webhook_events_ref
  ON public.checkalt_webhook_events (checkalt_reference);
CREATE INDEX IF NOT EXISTS idx_checkalt_webhook_events_received
  ON public.checkalt_webhook_events (received_at DESC);

ALTER TABLE public.checkalt_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins view webhook events"
  ON public.checkalt_webhook_events FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service role writes webhook events"
  ON public.checkalt_webhook_events FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- 4) Add deposit_method + linkage to claim_checks (additive, default keeps current behavior)
ALTER TABLE public.claim_checks
  ADD COLUMN IF NOT EXISTS deposit_method text NOT NULL DEFAULT 'branch',
  ADD COLUMN IF NOT EXISTS checkalt_deposit_id uuid REFERENCES public.checkalt_deposits(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_claim_checks_deposit_method
  ON public.claim_checks (deposit_method);

-- 5) updated_at trigger for new tables (reuses existing helper)
DROP TRIGGER IF EXISTS update_checkalt_config_updated_at ON public.checkalt_config;
CREATE TRIGGER update_checkalt_config_updated_at
  BEFORE UPDATE ON public.checkalt_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_checkalt_deposits_updated_at ON public.checkalt_deposits;
CREATE TRIGGER update_checkalt_deposits_updated_at
  BEFORE UPDATE ON public.checkalt_deposits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();