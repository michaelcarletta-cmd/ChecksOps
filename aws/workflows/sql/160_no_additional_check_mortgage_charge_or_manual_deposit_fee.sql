-- SQL 160: no Mortgage Ops charge and no agent pay for an additional check on the same claim, and no $4 check fee
-- for a check deposited outside ChecksOps. AWS only: nothing under supabase/migrations changes.
--
-- Why: owner 2026-11-12: "we are removing the mortgage handling for an additional check if an additional check is on
-- the same request. There will be no more $5 charge ... do not allow that charge to occur"; agent pay for an additional
-- check: "Stop paying it"; "if a user deposits a check outside of checksops they should NOT be charged $4" (rule chosen:
-- "No fee for manual", and a check deposited with no deposit record: "yes make that free too"); the $5 mortgage_handling
-- event too ("start SQL 160 yes"). Kept: the $10 for a claim's first
-- check and SQL 153's flat $5 for a 2nd mortgage company on a check. Not changed: charges already recorded.
--
-- What this file does (CREATE OR REPLACE of four live functions; owner, grants, SECURITY DEFINER and SET options are
-- kept by CREATE OR REPLACE):
--   1) public.record_check_billing_event() (SQL 98, trigger trg_record_check_billing_event on check_intake_items): a
--      check_processing event is recorded only when the check has a deposit_items row whose provider is not
--      manual_branch. Mark as Deposited / Deposit Ops (manual_branch, written before the check becomes deposited) and a
--      check set to deposited with no deposit item are not charged.
--   2) public.accrue_mortgage_ops_billing(uuid) (live-only, no earlier repository CREATE; run by the live trigger
--      tr_accrue_mortgage_ops_billing on mortgage_handling_requests): when the claim already has a Mortgage Ops charge,
--      nothing is recorded (it recorded mortgage_ops_additional_check at the tenant's additional rate, 500 by default),
--      and a lost race for the first charge no longer records an additional-check charge in its place.
--   3) public.earn_mortgage_agent_compensation(uuid) (SQL 47, run by tr_earn_mortgage_agent_compensation): an additional
--      check (by its billing event, or a prior completed request on the claim) earns no compensation entry.
--   4) public.tg_record_mortgage_handling_billing() (trigger tr_record_mortgage_handling_billing on
--      check_intake_items): no mortgage_handling event for an additional check on the claim; the first stays 1000.
--   Each body is the live body read by the read-only production billing trigger inspect of 2026-11-12 (main 63e62457,
--   SSM e8a9bc4e / ff854910 / 20bbce56, ops/production-billing-trigger-inspect.md) with only the lines marked SQL 160
--   added or removed.
--
-- Refuses to run (55000 sql160_prerequisite_missing) without the functions, the triggers and the columns it reads, and
-- (55000 sql160_live_body_drift) when a function's live body is neither the inspected one nor SQL 160's own: a body
-- nobody has read is never replaced.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction. Idempotent: a second run finds SQL 160's bodies and replaces them with themselves. Not
-- applied by this change: staging first, then production, through the guarded SQL path (AGENTS.md).

DO $sql160_prerequisites$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_col text[];
  v_name text;
BEGIN
  FOREACH v_col SLICE 1 IN ARRAY ARRAY[
    ['public.deposit_items', 'check_id'],
    ['public.deposit_items', 'provider'],
    ['public.check_billing_events', 'event_type'],
    ['public.check_billing_events', 'check_intake_item_id'],
    ['public.mortgage_handling_requests', 'claim_id'],
    ['public.mortgage_agent_compensation_rates', 'additional_cents']
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass(v_col[1]) AND a.attname = v_col[2] AND NOT a.attisdropped
    ) THEN
      v_missing := array_append(v_missing, v_col[1] || '.' || v_col[2]);
    END IF;
  END LOOP;
  FOREACH v_name IN ARRAY ARRAY[
    'public.record_check_billing_event()',
    'public.accrue_mortgage_ops_billing(uuid)',
    'public.earn_mortgage_agent_compensation(uuid)',
    'public.tg_record_mortgage_handling_billing()'
  ] LOOP
    IF to_regprocedure(v_name) IS NULL THEN
      v_missing := array_append(v_missing, v_name);
    END IF;
  END LOOP;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'sql160_prerequisite_missing: %', array_to_string(v_missing, ', ') USING ERRCODE = '55000';
  END IF;
END
$sql160_prerequisites$;

-- The live bodies must be the ones the inspect read (prosrc sha256), or SQL 160's own (a re-run).
DO $sql160_live_bodies$
DECLARE
  v_row text[];
  v_live text;
  v_drift text[] := ARRAY[]::text[];
BEGIN
  FOREACH v_row SLICE 1 IN ARRAY ARRAY[
    ['public.record_check_billing_event()', '8319ec76fd6e2704e119429e7b481054dfa9f92b6a9ee52a1a2dda61e710a8a9', 'd08e05fbb554891d9357435fda6adf424126ac8e29f90600684a8f49b8b31dc6'],
    ['public.accrue_mortgage_ops_billing(uuid)', 'fc03a9ea7d2a0783f0398309a4500412cbf8fba49801f1eeffc690ca2f727524', '4d34f049db708a2973dfc64bbe3ee9ac8fd3d2c888f5a3330412c31880b9a4cc'],
    ['public.earn_mortgage_agent_compensation(uuid)', '6d72d6df8c41c51a2f9cfbd6145dc5cf4f25427ed2af781a925d72c660b31e8b', '9317a2ce9da03028de50fcc9aaabbc17d03f1eaaec7538dcc95bd501ed8c1bcc'],
    ['public.tg_record_mortgage_handling_billing()', 'f022f75ac73f23fdec4a92205466a0b05febdf197642ce7af85110519f2fbe1e', '12a9cceb1ccdee7a33a294d6d29d5d29af40c75f2334b17fd57447beaa289075']
  ] LOOP
    SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') INTO v_live
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_row[1]);
    IF v_live IS DISTINCT FROM v_row[2] AND v_live IS DISTINCT FROM v_row[3] THEN
      v_drift := array_append(v_drift, v_row[1]);
    END IF;
  END LOOP;
  IF array_length(v_drift, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'sql160_live_body_drift: %', array_to_string(v_drift, ', ') USING ERRCODE = '55000';
  END IF;
END
$sql160_live_bodies$;

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

    -- SQL 160 (owner 2026-11-12): a check deposited outside ChecksOps is not charged. It is charged only when it has a
    -- ChecksOps deposit item that is not a manual bank-branch deposit: Mark as Deposited and Deposit Ops write
    -- provider manual_branch before the check becomes deposited, in the same transaction (workflow-rpc.mjs
    -- mark_manual_deposit), and a check set to deposited with no deposit item at all was deposited elsewhere too
    -- (owner: "yes make that free too").
    IF NOT EXISTS (
      SELECT 1 FROM public.deposit_items di
       WHERE di.check_id = NEW.id
         AND di.provider::text <> 'manual_branch'
    ) THEN
      RETURN NEW;
    END IF;

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
    -- SQL 160 (owner 2026-11-12): no Mortgage Ops charge for an additional check on the same claim.
    RETURN NULL;
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
    -- SQL 160: a concurrent first charge won; no additional-check charge is recorded in its place.
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

  -- SQL 160 (owner 2026-11-12): no agent pay for an additional check on the same claim.
  IF v_classification = 'additional' THEN
    RETURN NULL;
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

    -- SQL 160 (owner 2026-11-12): no $5 for an additional check on the same claim; the first check stays $10.
    IF NOT v_is_first_check THEN
      RETURN NEW;
    END IF;
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
