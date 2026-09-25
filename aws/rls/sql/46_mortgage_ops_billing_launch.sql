-- Additive: prospective Mortgage Ops usage-billing launch boundary.
-- Does not backfill historical acceptances. Does not create billing events.
-- Does not alter SQL 44 or SQL 45 schema. Does not touch destination/Moov/CheckAlt.
--
-- Invariant:
--   accepted_at < launched_at  => never automatically accrued
--   accepted_at >= launched_at => eligible for normal $10/$5 snapshot accrual
--
-- Fail-closed: if the singleton launch row is absent, accrue returns NULL.

CREATE TABLE IF NOT EXISTS public.mortgage_ops_billing_launch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  launched_at timestamptz NOT NULL,
  environment text NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mortgage_ops_billing_launch IS
  'Singleton auditable launch boundary for Mortgage Ops usage billing. Acceptances before launched_at are never automatically accrued.';

GRANT SELECT ON TABLE public.mortgage_ops_billing_launch TO checksops, authenticated;

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
  v_cutoff timestamptz;
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

  SELECT launched_at INTO v_cutoff
  FROM public.mortgage_ops_billing_launch
  WHERE singleton IS TRUE
  LIMIT 1;

  IF v_cutoff IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_req.accepted_at < v_cutoff THEN
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
  'Accrues a Mortgage Ops usage event at Accept only when accepted_at >= mortgage_ops_billing_launch.launched_at. Snapshots the current tenant rate. Idempotent per check. Fail-closed if the launch row is absent.';
