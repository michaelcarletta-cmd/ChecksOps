-- AWS RDS: consolidated monthly tenant billing (additive).
-- Staging / local only in Phase 2. Do not apply to production from this change.
--
-- Narrow extension of the existing monthly collector:
--   tenant_maintenance_payments remains the invoice / collection occurrence
--   check_billing_events remains the usage ledger
--   no new general accounting subsystem
--
-- Does not change CheckAlt, OCR, endorsement, Cognito, Messages, email,
-- tenant onboarding, branding, rail-router, or general Moov transfer
-- lifecycle. Instant remains schema-compatible but inactive / non-billable.

-- ---------------------------------------------------------------------------
-- 1) Tenant-facing speed rates (defaults: next-day 75¢, same-day 100¢)
--    Per-check rate already lives on tenants.per_check_rate_cents (reuse).
--    Instant has NO active rate column and is not generated.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS next_day_rate_cents integer NOT NULL DEFAULT 75;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS same_day_rate_cents integer NOT NULL DEFAULT 100;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_next_day_rate_cents_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_next_day_rate_cents_check
  CHECK (next_day_rate_cents >= 0);

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_same_day_rate_cents_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_same_day_rate_cents_check
  CHECK (same_day_rate_cents >= 0);

COMMENT ON COLUMN public.tenants.next_day_rate_cents IS
  'Tenant-facing ChecksOps next-day/standard ACH fee in cents. Snapshotted onto usage lines. Default 75.';
COMMENT ON COLUMN public.tenants.same_day_rate_cents IS
  'Tenant-facing ChecksOps same-day ACH fee in cents. Snapshotted onto usage lines. Default 100.';

-- ---------------------------------------------------------------------------
-- 2) Usage ledger columns on check_billing_events
-- ---------------------------------------------------------------------------
ALTER TABLE public.check_billing_events
  ADD COLUMN IF NOT EXISTS payment_transfer_id uuid;

ALTER TABLE public.check_billing_events
  ADD COLUMN IF NOT EXISTS billing_period text;

ALTER TABLE public.check_billing_events
  ADD COLUMN IF NOT EXISTS invoice_id uuid;

ALTER TABLE public.check_billing_events
  ADD COLUMN IF NOT EXISTS source_kind text;

ALTER TABLE public.check_billing_events
  ADD COLUMN IF NOT EXISTS source_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'check_billing_events_invoice_id_fkey'
  ) THEN
    ALTER TABLE public.check_billing_events
      ADD CONSTRAINT check_billing_events_invoice_id_fkey
      FOREIGN KEY (invoice_id)
      REFERENCES public.tenant_maintenance_payments(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

COMMENT ON COLUMN public.check_billing_events.payment_transfer_id IS
  'Source payment_transfers.id for moov_next_day / moov_same_day usage. Null for check_processing.';
COMMENT ON COLUMN public.check_billing_events.invoice_id IS
  'At most one monthly invoice allocation. Failed/returned invoices keep this pointer.';
COMMENT ON COLUMN public.check_billing_events.billing_period IS
  'UTC YYYY-MM of the usage event (accrual month), not the collection calendar month.';

-- One qualifying check → at most one check_processing charge.
CREATE UNIQUE INDEX IF NOT EXISTS check_billing_events_check_processing_uidx
  ON public.check_billing_events (check_intake_item_id)
  WHERE event_type = 'check_processing'
    AND check_intake_item_id IS NOT NULL;

-- One qualifying Moov transfer → at most one applicable speed-fee charge.
CREATE UNIQUE INDEX IF NOT EXISTS check_billing_events_transfer_fee_uidx
  ON public.check_billing_events (payment_transfer_id, event_type)
  WHERE payment_transfer_id IS NOT NULL
    AND event_type IN ('moov_next_day', 'moov_same_day', 'moov_instant');

-- Equivalent immutable source uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS check_billing_events_source_fee_uidx
  ON public.check_billing_events (source_kind, source_id, event_type)
  WHERE source_id IS NOT NULL
    AND source_kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS check_billing_events_invoice_idx
  ON public.check_billing_events (invoice_id)
  WHERE invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS check_billing_events_period_idx
  ON public.check_billing_events (tenant_id, billing_period, event_type);

-- ---------------------------------------------------------------------------
-- 3) Invoice / collection occurrence subtotals
--    amount_cents remains the complete consolidated total.
--    (tenant_id, billing_period) uniqueness already exists in SQL 43.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS maintenance_net_cents integer;

ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS check_usage_cents integer NOT NULL DEFAULT 0;

ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS next_day_usage_cents integer NOT NULL DEFAULT 0;

ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS same_day_usage_cents integer NOT NULL DEFAULT 0;

ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS usage_total_cents integer NOT NULL DEFAULT 0;

ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS check_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS next_day_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS same_day_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.tenant_maintenance_payments.amount_cents IS
  'Complete consolidated invoice total: maintenance_net + check + next-day + same-day usage.';

-- ---------------------------------------------------------------------------
-- 4) Expandable invoice allocations (one usage line → at most one invoice)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_invoice_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.tenant_maintenance_payments(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  billing_period text NOT NULL,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  fee_type text NOT NULL,
  unit_price_cents integer NOT NULL,
  amount_cents integer NOT NULL,
  billed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_invoice_allocations_fee_type_check
    CHECK (fee_type IN ('check_processing', 'moov_next_day', 'moov_same_day', 'moov_instant')),
  CONSTRAINT tenant_invoice_allocations_source_kind_check
    CHECK (source_kind IN ('check_processing', 'moov_next_day', 'moov_same_day', 'moov_instant')),
  CONSTRAINT tenant_invoice_allocations_unique_source
    UNIQUE (source_kind, source_id, fee_type)
);

COMMENT ON TABLE public.tenant_invoice_allocations IS
  'Immutable invoice line items. Failed/returned collections keep these rows. Do not reallocate to a later month.';

CREATE INDEX IF NOT EXISTS tenant_invoice_allocations_invoice_idx
  ON public.tenant_invoice_allocations (invoice_id);

CREATE INDEX IF NOT EXISTS tenant_invoice_allocations_tenant_period_idx
  ON public.tenant_invoice_allocations (tenant_id, billing_period);

-- ---------------------------------------------------------------------------
-- 5) RLS / grants — same pattern as SQL 43 monthly billing job + platform owner
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_invoice_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aws_select_tenant_invoice_allocations ON public.tenant_invoice_allocations;
CREATE POLICY aws_select_tenant_invoice_allocations ON public.tenant_invoice_allocations
  FOR SELECT TO authenticated
  USING (
    public.aws_is_cross_tenant_reader()
    OR public.aws_can_access_tenant(tenant_id)
    OR public.aws_monthly_billing_job()
  );

DROP POLICY IF EXISTS aws_write_tenant_invoice_allocations ON public.tenant_invoice_allocations;
CREATE POLICY aws_write_tenant_invoice_allocations ON public.tenant_invoice_allocations
  FOR ALL TO authenticated
  USING (public.is_platform_owner() OR public.aws_monthly_billing_job())
  WITH CHECK (public.is_platform_owner() OR public.aws_monthly_billing_job());

DROP POLICY IF EXISTS aws_select_tenant_invoice_allocations_job ON public.tenant_invoice_allocations;
CREATE POLICY aws_select_tenant_invoice_allocations_job ON public.tenant_invoice_allocations
  FOR SELECT TO checksops
  USING (public.aws_monthly_billing_job() OR public.is_platform_owner());

DROP POLICY IF EXISTS aws_write_tenant_invoice_allocations_job ON public.tenant_invoice_allocations;
CREATE POLICY aws_write_tenant_invoice_allocations_job ON public.tenant_invoice_allocations
  FOR ALL TO checksops
  USING (public.aws_monthly_billing_job() OR public.is_platform_owner())
  WITH CHECK (public.aws_monthly_billing_job() OR public.is_platform_owner());

DROP POLICY IF EXISTS aws_write_check_billing_events_monthly_job ON public.check_billing_events;
CREATE POLICY aws_write_check_billing_events_monthly_job ON public.check_billing_events
  FOR ALL TO authenticated
  USING (public.is_platform_owner() OR public.aws_monthly_billing_job())
  WITH CHECK (public.is_platform_owner() OR public.aws_monthly_billing_job());

DROP POLICY IF EXISTS aws_write_check_billing_events_monthly_job_role ON public.check_billing_events;
CREATE POLICY aws_write_check_billing_events_monthly_job_role ON public.check_billing_events
  FOR ALL TO checksops
  USING (public.aws_monthly_billing_job() OR public.is_platform_owner())
  WITH CHECK (public.aws_monthly_billing_job() OR public.is_platform_owner());

GRANT SELECT, INSERT, UPDATE ON public.tenant_invoice_allocations TO checksops, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.check_billing_events TO checksops, authenticated;
