-- The four live function definitions SQL 160 replaces, verbatim (pg_get_functiondef) from the read-only production
-- billing trigger inspect of 2026-11-12 (main 63e62457d87271b5d52c3e3bb6e0d0ae74cf22d1, transfer run 43296012333;
-- SSM e8a9bc4e-e469-4399-b52b-a00d39798488 for accrue_mortgage_ops_billing and tg_record_mortgage_handling_billing,
-- main a2559c3 SSM ff854910-d025-4e14-ad0f-3a4d598172cc for record_check_billing_event, 20bbce56-14db-4ace-835c-ba7ff47a8c40
-- for earn_mortgage_agent_compensation; every run printed the same report sha256 per session). Test fixture only:
-- aws/tests/sql160-billing-additional-check-pg.test.mjs loads it as the pre-state. Never applied anywhere.

-- public.record_check_billing_event()
CREATE OR REPLACE FUNCTION public.record_check_billing_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET row_security TO 'off'
AS $function$
DECLARE
  v_enabled boolean;
  v_rate integer;
  v_price integer;
BEGIN
  IF NEW.status = 'deposited'
     AND OLD.status IS DISTINCT FROM 'deposited'
     AND NEW.tenant_id IS NOT NULL THEN

    SELECT t.per_check_billing_enabled, t.per_check_rate_cents
      INTO v_enabled, v_rate
      FROM public.tenants t
     WHERE t.id = NEW.tenant_id;

    IF v_enabled IS TRUE AND v_rate IS NOT NULL THEN
      v_price := v_rate;
    ELSIF v_enabled IS NOT TRUE AND NOT public.aws_check_billing_charges_when_per_check_off() THEN
      -- Owner question (b) answered "off means no per-check fee".
      RETURN NEW;
    ELSE
      v_price := public.aws_check_billing_default_price_cents();
    END IF;

    IF v_price IS NULL THEN
      RAISE WARNING 'record_check_billing_event: no active check_billing_config row; check % not billed', NEW.id;
      RETURN NEW;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.check_billing_events e
       WHERE e.check_intake_item_id = NEW.id
         AND e.event_type = 'check_processing'
    ) THEN
      INSERT INTO public.check_billing_events (
        tenant_id, check_intake_item_id, unit_price_cents, currency, status, event_type
      ) VALUES (
        NEW.tenant_id, NEW.id, v_price, 'usd', 'recorded', 'check_processing'
      )
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

-- public.accrue_mortgage_ops_billing(uuid)
CREATE OR REPLACE FUNCTION public.accrue_mortgage_ops_billing(p_request_id uuid)
 RETURNS public.check_billing_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- public.earn_mortgage_agent_compensation(uuid)
CREATE OR REPLACE FUNCTION public.earn_mortgage_agent_compensation(p_request_id uuid)
 RETURNS public.mortgage_agent_compensation_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET row_security TO 'off'
AS $function$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_existing public.mortgage_agent_compensation_entries%ROWTYPE;
  v_inserted public.mortgage_agent_compensation_entries%ROWTYPE;
  v_event_id uuid;
  v_event_type text;
  v_event_cents integer;
  v_classification text;
  v_amount integer;
  v_initial integer;
  v_additional integer;
  v_prior integer;
  v_period text;
BEGIN
  IF p_request_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_req
  FROM public.mortgage_handling_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.mortgage_agent_compensation_exclusions x
    WHERE x.mortgage_request_id = v_req.id
  ) THEN
    RETURN NULL;
  END IF;

  IF v_req.status IS DISTINCT FROM 'completed'
     OR v_req.completed_at IS NULL
     OR v_req.assigned_employee_id IS NULL
  THEN
    RETURN NULL;
  END IF;

  SELECT e.* INTO v_existing
  FROM public.mortgage_agent_compensation_entries e
  WHERE e.mortgage_request_id = v_req.id
    AND e.parent_entry_id IS NULL
    AND e.status NOT IN ('voided', 'excluded')
  LIMIT 1;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  SELECT r.initial_cents, r.additional_cents
  INTO v_initial, v_additional
  FROM public.mortgage_agent_compensation_rates r
  WHERE r.singleton IS TRUE
  LIMIT 1;
  v_initial := COALESCE(v_initial, 1000);
  v_additional := COALESCE(v_additional, 500);

  BEGIN
    SELECT e.id, e.event_type, e.unit_price_cents
    INTO v_event_id, v_event_type, v_event_cents
    FROM public.check_billing_events e
    WHERE e.check_intake_item_id IS NOT DISTINCT FROM v_req.check_intake_item_id
      AND e.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
      AND e.status IS DISTINCT FROM 'voided'
    ORDER BY e.created_at ASC
    LIMIT 1;
  EXCEPTION
    WHEN undefined_table THEN
      v_event_id := NULL;
    WHEN undefined_column THEN
      v_event_id := NULL;
  END;

  IF v_event_type = 'mortgage_ops_additional_check' THEN
    v_classification := 'additional';
  ELSIF v_event_type = 'mortgage_ops_initial' THEN
    v_classification := 'initial';
  ELSE
    v_prior := 0;
    IF v_req.claim_id IS NOT NULL AND v_req.tenant_id IS NOT NULL THEN
      SELECT count(*)::int INTO v_prior
      FROM public.mortgage_handling_requests r
      WHERE r.tenant_id = v_req.tenant_id
        AND r.claim_id = v_req.claim_id
        AND r.status = 'completed'
        AND r.completed_at IS NOT NULL
        AND r.id IS DISTINCT FROM v_req.id
        AND NOT EXISTS (
          SELECT 1
          FROM public.mortgage_agent_compensation_exclusions x
          WHERE x.mortgage_request_id = r.id
        );
    END IF;
    IF COALESCE(v_prior, 0) > 0 THEN
      v_classification := 'additional';
    ELSE
      v_classification := 'initial';
    END IF;
  END IF;

  IF v_classification = 'additional' THEN
    v_amount := v_additional;
  ELSE
    v_amount := v_initial;
  END IF;

  v_period := to_char(timezone('UTC', v_req.completed_at), 'YYYY-MM');

  INSERT INTO public.mortgage_agent_compensation_entries (
    agent_user_id,
    mortgage_request_id,
    check_intake_item_id,
    claim_id,
    tenant_id,
    classification,
    amount_cents,
    tenant_billing_event_id,
    tenant_billing_event_type,
    tenant_billing_amount_cents,
    accepted_at,
    completed_at,
    earned_at,
    pay_period,
    status
  ) VALUES (
    v_req.assigned_employee_id,
    v_req.id,
    v_req.check_intake_item_id,
    v_req.claim_id,
    v_req.tenant_id,
    v_classification,
    v_amount,
    v_event_id,
    v_event_type,
    v_event_cents,
    v_req.accepted_at,
    v_req.completed_at,
    v_req.completed_at,
    v_period,
    'earned'
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_inserted;

  IF v_inserted.id IS NULL THEN
    SELECT e.* INTO v_inserted
    FROM public.mortgage_agent_compensation_entries e
    WHERE e.mortgage_request_id = v_req.id
      AND e.parent_entry_id IS NULL
      AND e.status NOT IN ('voided', 'excluded')
    LIMIT 1;
  ELSE
    INSERT INTO public.mortgage_agent_compensation_audit (
      entry_id, actor_id, action, from_status, to_status, payload
    ) VALUES (
      v_inserted.id,
      v_req.assigned_employee_id,
      'earn',
      NULL,
      'earned',
      jsonb_build_object(
        'mortgage_request_id', v_req.id,
        'classification', v_classification,
        'amount_cents', v_amount
      )
    );
  END IF;

  RETURN v_inserted;
END;
$function$;

-- public.tg_record_mortgage_handling_billing()
CREATE OR REPLACE FUNCTION public.tg_record_mortgage_handling_billing()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id uuid;
  v_claim_id uuid;
  v_is_first_check boolean;
  v_fee_cents integer;
BEGIN
  -- check_stage uses the canonical lane names: review and loss_draft.
  -- Compare enum values only against values that exist in public.check_stage.
  IF NEW.check_stage IN (
       'review'::public.check_stage,
       'loss_draft'::public.check_stage
     )
     AND OLD.check_stage NOT IN (
       'review'::public.check_stage,
       'loss_draft'::public.check_stage
     )
     AND NEW.check_source = 'insurance'
  THEN
    SELECT c.tenant_id, c.claim_id
      INTO v_tenant_id, v_claim_id
    FROM public.check_intake_items AS c
    WHERE c.id = NEW.id;

    IF v_tenant_id IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT NOT EXISTS (
      SELECT 1
      FROM public.check_billing_events AS e
      WHERE e.tenant_id = v_tenant_id
        AND e.event_type = 'mortgage_handling'
        AND e.check_intake_item_id IN (
          SELECT c.id
          FROM public.check_intake_items AS c
          WHERE c.tenant_id = v_tenant_id
            AND c.claim_id = v_claim_id
        )
    ) INTO v_is_first_check;

    v_fee_cents := CASE WHEN v_is_first_check THEN 1000 ELSE 500 END;

    INSERT INTO public.check_billing_events (
      tenant_id,
      check_intake_item_id,
      event_type,
      unit_price_cents,
      status
    )
    VALUES (
      v_tenant_id,
      NEW.id,
      'mortgage_handling',
      v_fee_cents,
      'reported'
    )
    ON CONFLICT (tenant_id, check_intake_item_id, event_type) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;
