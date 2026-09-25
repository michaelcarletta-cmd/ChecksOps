-- AWS RDS: Mortgage Ops usage on the consolidated monthly tenant invoice (additive).
-- Staging / local only in this phase. Do not apply to production from this change.
--
-- Narrow extension of SQL 44:
--   tenants gains Mortgage Ops first/additional rates
--   check_billing_events remains the usage ledger
--   tenant_maintenance_payments remains the invoice / collection occurrence
--   no new general accounting subsystem
--   no historical Mortgage Ops backfill
--
-- Billable milestone is the existing Accept transition:
--   mortgage_handling_requests.status requested -> in_progress
--   accepted_at set by accept_mortgage_handling_request
--
-- Does not change CheckAlt, OCR, endorsement, Cognito, Messages, email,
-- tenant onboarding, branding, rail-router, or general Moov transfer
-- lifecycle. Instant remains schema-compatible but inactive / non-billable.
-- The fail-closed bill-mortgage-handling Stripe stub is unchanged.

-- ---------------------------------------------------------------------------
-- 1) Tenant-facing Mortgage Ops rates (defaults: first $10, additional $5)
--    Explicit 0 is FREE and must not fall back to the default.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS mortgage_ops_initial_rate_cents integer NOT NULL DEFAULT 1000;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS mortgage_ops_additional_rate_cents integer NOT NULL DEFAULT 500;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_mortgage_ops_initial_rate_cents_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_mortgage_ops_initial_rate_cents_check
  CHECK (mortgage_ops_initial_rate_cents >= 0);

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_mortgage_ops_additional_rate_cents_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_mortgage_ops_additional_rate_cents_check
  CHECK (mortgage_ops_additional_rate_cents >= 0);

COMMENT ON COLUMN public.tenants.mortgage_ops_initial_rate_cents IS
  'Tenant-facing first qualifying Mortgage Ops check for a claim, in cents. Snapshotted at Accept. Default 1000. Explicit 0 is free.';
COMMENT ON COLUMN public.tenants.mortgage_ops_additional_rate_cents IS
  'Tenant-facing additional qualifying Mortgage Ops check for the same claim, in cents. Snapshotted at Accept. Default 500. Explicit 0 is free.';

-- ---------------------------------------------------------------------------
-- 2) Usage ledger identity for Mortgage Ops
-- ---------------------------------------------------------------------------
ALTER TABLE public.check_billing_events
  ADD COLUMN IF NOT EXISTS claim_id uuid;

ALTER TABLE public.check_billing_events
  ADD COLUMN IF NOT EXISTS mortgage_request_id uuid;

COMMENT ON COLUMN public.check_billing_events.claim_id IS
  'Claim used to classify Mortgage Ops first vs additional check. Null for non-mortgage events.';
COMMENT ON COLUMN public.check_billing_events.mortgage_request_id IS
  'mortgage_handling_requests.id that produced this Mortgage Ops usage event.';

-- One qualifying Mortgage Ops CHECK → at most one Mortgage Ops charge
-- (retries / re-accepts / second request on the same check do not rebill).
CREATE UNIQUE INDEX IF NOT EXISTS check_billing_events_mortgage_ops_check_uidx
  ON public.check_billing_events (check_intake_item_id)
  WHERE event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
    AND check_intake_item_id IS NOT NULL;

-- At most one initial charge per tenant + claim.
CREATE UNIQUE INDEX IF NOT EXISTS check_billing_events_mortgage_ops_initial_claim_uidx
  ON public.check_billing_events (tenant_id, claim_id)
  WHERE event_type = 'mortgage_ops_initial'
    AND claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS check_billing_events_mortgage_ops_claim_idx
  ON public.check_billing_events (tenant_id, claim_id, event_type)
  WHERE event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check');

CREATE INDEX IF NOT EXISTS check_billing_events_mortgage_request_idx
  ON public.check_billing_events (mortgage_request_id)
  WHERE mortgage_request_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) Invoice / collection occurrence Mortgage Ops subtotals
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS mortgage_ops_initial_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS mortgage_ops_initial_amount_cents integer NOT NULL DEFAULT 0;

ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS mortgage_ops_additional_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS mortgage_ops_additional_amount_cents integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.tenant_maintenance_payments.amount_cents IS
  'Complete consolidated invoice total: maintenance_net + check + next-day + same-day + Mortgage Ops usage.';
COMMENT ON COLUMN public.tenant_maintenance_payments.mortgage_ops_initial_amount_cents IS
  'Snapshotted first-check Mortgage Ops usage allocated to this invoice.';
COMMENT ON COLUMN public.tenant_maintenance_payments.mortgage_ops_additional_amount_cents IS
  'Snapshotted additional-check Mortgage Ops usage allocated to this invoice.';

-- ---------------------------------------------------------------------------
-- 4) Expand allocation fee/source checks (drop + recreate; table stays)
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_invoice_allocations
  DROP CONSTRAINT IF EXISTS tenant_invoice_allocations_fee_type_check;
ALTER TABLE public.tenant_invoice_allocations
  ADD CONSTRAINT tenant_invoice_allocations_fee_type_check
  CHECK (fee_type IN (
    'check_processing',
    'moov_next_day',
    'moov_same_day',
    'moov_instant',
    'mortgage_ops_initial',
    'mortgage_ops_additional_check'
  ));

ALTER TABLE public.tenant_invoice_allocations
  DROP CONSTRAINT IF EXISTS tenant_invoice_allocations_source_kind_check;
ALTER TABLE public.tenant_invoice_allocations
  ADD CONSTRAINT tenant_invoice_allocations_source_kind_check
  CHECK (source_kind IN (
    'check_processing',
    'moov_next_day',
    'moov_same_day',
    'moov_instant',
    'mortgage_ops_initial',
    'mortgage_ops_additional_check'
  ));

-- ---------------------------------------------------------------------------
-- 5) Accrual-time snapshot on Accept (existing workflow, no new lifecycle)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accrue_mortgage_ops_billing(
  p_request_id uuid
) RETURNS public.check_billing_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_claim_id uuid;
  v_lock_claim text;
  v_has_prior boolean;
  v_event_type text;
  v_rate integer;
  v_initial_rate integer;
  v_additional_rate integer;
  v_period text;
  v_existing public.check_billing_events%ROWTYPE;
  v_inserted public.check_billing_events%ROWTYPE;
BEGIN
  SELECT * INTO v_req
  FROM public.mortgage_handling_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_req.accepted_at IS NULL OR v_req.status NOT IN ('in_progress', 'completed') THEN
    RETURN NULL;
  END IF;

  IF v_req.check_intake_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT e.* INTO v_existing
  FROM public.check_billing_events e
  WHERE e.check_intake_item_id = v_req.check_intake_item_id
    AND e.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
  LIMIT 1;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  v_claim_id := COALESCE(
    v_req.claim_id,
    (SELECT c.claim_id FROM public.check_intake_items c WHERE c.id = v_req.check_intake_item_id)
  );
  v_lock_claim := COALESCE(v_claim_id::text, v_req.check_intake_item_id::text);

  PERFORM pg_advisory_xact_lock(
    hashtext(v_req.tenant_id::text),
    hashtext('mortgage_ops:' || v_lock_claim)
  );

  SELECT e.* INTO v_existing
  FROM public.check_billing_events e
  WHERE e.check_intake_item_id = v_req.check_intake_item_id
    AND e.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
  LIMIT 1;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  SELECT
    CASE WHEN t.mortgage_ops_initial_rate_cents IS NULL THEN 1000 ELSE t.mortgage_ops_initial_rate_cents END,
    CASE WHEN t.mortgage_ops_additional_rate_cents IS NULL THEN 500 ELSE t.mortgage_ops_additional_rate_cents END
  INTO v_initial_rate, v_additional_rate
  FROM public.tenants t
  WHERE t.id = v_req.tenant_id;

  v_initial_rate := COALESCE(v_initial_rate, 1000);
  v_additional_rate := COALESCE(v_additional_rate, 500);

  IF v_claim_id IS NULL THEN
    v_has_prior := false;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM public.check_billing_events e
      WHERE e.tenant_id = v_req.tenant_id
        AND e.claim_id = v_claim_id
        AND e.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
        AND e.status IS DISTINCT FROM 'voided'
    ) INTO v_has_prior;
  END IF;

  IF v_has_prior THEN
    v_event_type := 'mortgage_ops_additional_check';
    v_rate := v_additional_rate;
  ELSE
    v_event_type := 'mortgage_ops_initial';
    v_rate := v_initial_rate;
  END IF;

  v_period := to_char(timezone('UTC', v_req.accepted_at), 'YYYY-MM');

  BEGIN
    INSERT INTO public.check_billing_events (
      tenant_id,
      check_intake_item_id,
      claim_id,
      mortgage_request_id,
      event_type,
      unit_price_cents,
      currency,
      status,
      billed_at,
      billing_period,
      source_kind,
      source_id
    ) VALUES (
      v_req.tenant_id,
      v_req.check_intake_item_id,
      v_claim_id,
      v_req.id,
      v_event_type,
      v_rate,
      'usd',
      'recorded',
      v_req.accepted_at,
      v_period,
      v_event_type,
      v_req.check_intake_item_id
    )
    RETURNING * INTO v_inserted;
    RETURN v_inserted;
  EXCEPTION WHEN unique_violation THEN
    IF v_event_type = 'mortgage_ops_initial' THEN
      BEGIN
        INSERT INTO public.check_billing_events (
          tenant_id,
          check_intake_item_id,
          claim_id,
          mortgage_request_id,
          event_type,
          unit_price_cents,
          currency,
          status,
          billed_at,
          billing_period,
          source_kind,
          source_id
        ) VALUES (
          v_req.tenant_id,
          v_req.check_intake_item_id,
          v_claim_id,
          v_req.id,
          'mortgage_ops_additional_check',
          v_additional_rate,
          'usd',
          'recorded',
          v_req.accepted_at,
          v_period,
          'mortgage_ops_additional_check',
          v_req.check_intake_item_id
        )
        RETURNING * INTO v_inserted;
        RETURN v_inserted;
      EXCEPTION WHEN unique_violation THEN
        SELECT e.* INTO v_existing
        FROM public.check_billing_events e
        WHERE e.check_intake_item_id = v_req.check_intake_item_id
          AND e.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
        LIMIT 1;
        RETURN v_existing;
      END;
    END IF;
    SELECT e.* INTO v_existing
    FROM public.check_billing_events e
    WHERE e.check_intake_item_id = v_req.check_intake_item_id
      AND e.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
    LIMIT 1;
    RETURN v_existing;
  END;
END;
$$;

COMMENT ON FUNCTION public.accrue_mortgage_ops_billing(uuid) IS
  'Accrues a Mortgage Ops usage event at Accept. Snapshots the current tenant rate. Idempotent per check. Serializes first vs additional per tenant+claim.';

CREATE OR REPLACE FUNCTION public.tg_accrue_mortgage_ops_billing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.accepted_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('in_progress', 'completed') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.accepted_at IS NOT NULL
     AND OLD.status IN ('in_progress', 'completed') THEN
    RETURN NEW;
  END IF;
  PERFORM public.accrue_mortgage_ops_billing(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_accrue_mortgage_ops_billing ON public.mortgage_handling_requests;
CREATE TRIGGER tr_accrue_mortgage_ops_billing
  AFTER INSERT OR UPDATE OF status, accepted_at
  ON public.mortgage_handling_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_accrue_mortgage_ops_billing();

GRANT EXECUTE ON FUNCTION public.accrue_mortgage_ops_billing(uuid) TO checksops, authenticated;
