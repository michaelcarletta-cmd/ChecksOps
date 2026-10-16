-- AWS: Mortgage Agent compensation Adjust (SQL 85).
-- Immutable, append-only compensation adjustments on top of the Mortgage Agent
-- compensation ledger (Cursor SQL 47, aws/isolated/mortgage-agent-compensation/
-- sql/47_mortgage_agent_compensation.sql, sha256 bdbdccbc...). Does NOT rewrite
-- or reapply SQL 47. Independent of SQL 84 (either order works). Refuses to run
-- (55000 sql47_prerequisite_missing) when the SQL 47 objects it uses are absent.
--
-- Provenance: Cursor SQL 49 (aws/isolated/mortgage-agent-compensation/sql/
-- 49_adjust_mortgage_agent_compensation.sql, sha256 3bda6740..., branch
-- cursor/mortgage-agent-lambda-prod-ad99 b73e976be), renumbered to 85 to
-- follow SQL 84.
--
-- Changes from SQL 49:
--   * Platform owner only. The caller must satisfy public.is_platform_owner()
--     (the predicate main's API uses, IS_PLATFORM_OWNER_SQL in data.mjs).
--     SQL 49 used aws_can_admin_mortgage_agent_compensation(), which also
--     admits any global user_roles 'admin'. Tenant owners/admins, platform
--     admins, staff and Mortgage Agents are refused (42501 not_authorized).
--   * The hardcoded request UUID (the accidental Freedom Accept) is removed.
--     Exclusions come only from public.mortgage_agent_compensation_exclusions,
--     where SQL 47 seeds that request. Behaviour changes only if that
--     exclusion row is deleted: its entries would then be adjustable (SQL 47
--     never earns an entry for an excluded request, so none should exist).
--   * Bounded amounts (22023):
--       - 0 is refused (invalid_adjustment);
--       - abs(amount) may not exceed the parent entry's amount_cents
--         (adjustment_exceeds_parent);
--       - any debit to the parent's agent (a negative single adjustment, or the
--         debit side of a wrong-agent pair) may not exceed that agent's net on
--         the file: parent amount plus that agent's non-voided, non-excluded
--         children of this parent (adjustment_exceeds_net).
--   * Idempotency: optional p_idempotency_key (1-200 chars). It is stored on
--     the adjust batch (unique among adjust batches). A repeat with the same
--     key returns the original result (idempotent_replay true) and writes
--     nothing; a repeat with a different parent, amount, counterparty,
--     reason or pay_period is refused (P0001 idempotency_key_conflict). This adds a sixth
--     argument, so the SQL 49 / five-argument function is dropped first.
--   * The counterparty must be an active Mortgage Agent
--     (public.aws_is_active_mortgage_agent, SQL 47).
--   * Children leave payment_batch_id NULL, so SQL 47's approve (which keeps an
--     existing payment_batch_id) and mark_paid attribute their own batches.
--     The adjust batch is linked through the audit rows' batch_id.
--   * pay_period must be a real month (YYYY-01..YYYY-12); SQL 49 accepted
--     any YYYY-NN.
--   * REVOKE ALL ... FROM PUBLIC before the grant.
--
-- Children use the existing parent_entry_id. Parent facts and status are never
-- rewritten (the SQL 47 fact-protection trigger also refuses it). Adjustments
-- are new 'earned' bookkeeping entries only: no approval, no payment, no rate
-- change, no tenant billing event, no provider money rail, no clawback.
--
-- Transactions: like main's other aws/workflows/sql files this has no
-- BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction, so
-- a failure keeps nothing. Run by hand, use psql --single-transaction.
--
-- Idempotent DDL: safe to run more than once.

DO $$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.mortgage_agent_compensation_entries', to_regclass('public.mortgage_agent_compensation_entries')::oid),
      ('public.mortgage_agent_compensation_batches', to_regclass('public.mortgage_agent_compensation_batches')::oid),
      ('public.mortgage_agent_compensation_exclusions', to_regclass('public.mortgage_agent_compensation_exclusions')::oid),
      ('public.mortgage_agent_compensation_audit', to_regclass('public.mortgage_agent_compensation_audit')::oid),
      ('public.user_roles', to_regclass('public.user_roles')::oid),
      ('public.is_platform_owner()', to_regprocedure('public.is_platform_owner()')::oid),
      ('public.aws_is_active_mortgage_agent(uuid)', to_regprocedure('public.aws_is_active_mortgage_agent(uuid)')::oid),
      ('auth.uid()', to_regprocedure('auth.uid()')::oid)
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql47_prerequisite_missing: SQL 85 needs SQL 47 (and the identity helpers) applied first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE public.mortgage_agent_compensation_entries
  ADD COLUMN IF NOT EXISTS adjustment_reason text;

CREATE INDEX IF NOT EXISTS mortgage_agent_compensation_entries_parent_idx
  ON public.mortgage_agent_compensation_entries (parent_entry_id)
  WHERE parent_entry_id IS NOT NULL;

ALTER TABLE public.mortgage_agent_compensation_batches
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS mortgage_agent_compensation_batches_adjust_idem_uidx
  ON public.mortgage_agent_compensation_batches (idempotency_key)
  WHERE action = 'adjust' AND idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.mortgage_agent_compensation_batches'::regclass
      AND conname = 'mortgage_agent_compensation_batches_action_check'
  ) THEN
    ALTER TABLE public.mortgage_agent_compensation_batches
      DROP CONSTRAINT mortgage_agent_compensation_batches_action_check;
  END IF;
  ALTER TABLE public.mortgage_agent_compensation_batches
    ADD CONSTRAINT mortgage_agent_compensation_batches_action_check
    CHECK (action IN ('approve', 'pay', 'adjust'));
END
$$;

-- The SQL 49 (and first SQL 85) five-argument body. Left in place it would
-- keep the old admin check and make five-argument calls ambiguous.
DROP FUNCTION IF EXISTS public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text);

CREATE OR REPLACE FUNCTION public.adjust_mortgage_agent_compensation(
  p_parent_entry_id uuid,
  p_amount_cents integer,
  p_reason text,
  p_counterparty_agent_id uuid DEFAULT NULL,
  p_pay_period text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_parent public.mortgage_agent_compensation_entries%ROWTYPE;
  v_reason text;
  v_period text;
  v_key text;
  v_amount integer;
  v_signed bigint;
  v_net bigint;
  v_debit public.mortgage_agent_compensation_entries%ROWTYPE;
  v_credit public.mortgage_agent_compensation_entries%ROWTYPE;
  v_batch_id uuid;
  v_prior public.mortgage_agent_compensation_audit%ROWTYPE;
  v_pair boolean;
BEGIN
  IF NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
  END IF;

  IF p_parent_entry_id IS NULL OR p_amount_cents IS NULL OR p_amount_cents = 0 THEN
    RAISE EXCEPTION 'invalid_adjustment' USING ERRCODE = '22023';
  END IF;

  v_period := btrim(COALESCE(p_pay_period, ''));
  IF v_period = '' THEN
    v_period := to_char(timezone('UTC', now()), 'YYYY-MM');
  ELSIF v_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'invalid_pay_period' USING ERRCODE = '22023';
  END IF;

  v_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  IF v_key IS NOT NULL AND length(v_key) > 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;

  v_pair := p_counterparty_agent_id IS NOT NULL;
  -- The amount booked against the parent's agent.
  -- bigint, so abs() of INT_MIN cannot overflow before the caps refuse it.
  v_signed := CASE WHEN v_pair THEN -abs(p_amount_cents::bigint) ELSE p_amount_cents::bigint END;

  IF v_key IS NOT NULL THEN
    -- Serialize same-key calls (a double-click sends two at once).
    PERFORM pg_advisory_xact_lock(hashtextextended('mortgage_agent_compensation_adjust:' || v_key, 0));
    SELECT a.* INTO v_prior
    FROM public.mortgage_agent_compensation_batches b
    JOIN public.mortgage_agent_compensation_audit a
      ON a.batch_id = b.id
     AND a.action = 'adjust'
     AND a.from_status IS NOT NULL
    WHERE b.action = 'adjust'
      AND b.idempotency_key = v_key
    LIMIT 1;
    IF FOUND THEN
      IF v_prior.entry_id IS DISTINCT FROM p_parent_entry_id
         OR (v_prior.payload->>'amount_cents')::bigint IS DISTINCT FROM v_signed
         OR (v_prior.payload->>'counterparty_agent_id')::uuid IS DISTINCT FROM p_counterparty_agent_id
         OR (v_prior.payload->>'reason') IS DISTINCT FROM v_reason
         OR (v_prior.payload->>'pay_period') IS DISTINCT FROM v_period
      THEN
        RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
      END IF;
      SELECT * INTO v_parent FROM public.mortgage_agent_compensation_entries WHERE id = v_prior.entry_id;
      SELECT * INTO v_debit FROM public.mortgage_agent_compensation_entries
        WHERE id = (v_prior.payload->>'debit_entry_id')::uuid;
      SELECT * INTO v_credit FROM public.mortgage_agent_compensation_entries
        WHERE id = (v_prior.payload->>'credit_entry_id')::uuid;
      RETURN jsonb_build_object(
        'parent_entry_id', v_parent.id,
        'parent_status', v_prior.from_status,
        'parent_amount_cents', v_parent.amount_cents,
        'parent_agent_user_id', v_parent.agent_user_id,
        'pay_period', v_prior.payload->>'pay_period',
        'paired', (v_prior.payload->>'paired')::boolean,
        'batch_id', v_prior.batch_id,
        'idempotency_key', v_key,
        'idempotent_replay', true,
        'debit', to_jsonb(v_debit),
        'credit', CASE WHEN v_credit.id IS NULL THEN NULL ELSE to_jsonb(v_credit) END
      );
    END IF;
  END IF;

  SELECT * INTO v_parent
  FROM public.mortgage_agent_compensation_entries
  WHERE id = p_parent_entry_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_parent.parent_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'parent_must_be_root' USING ERRCODE = '22023';
  END IF;

  IF v_parent.status IN ('voided', 'excluded') THEN
    RAISE EXCEPTION 'parent_not_adjustable' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.mortgage_agent_compensation_exclusions x
    WHERE x.mortgage_request_id = v_parent.mortgage_request_id
  ) THEN
    RAISE EXCEPTION 'request_excluded' USING ERRCODE = '42501';
  END IF;

  IF v_pair THEN
    IF p_counterparty_agent_id = v_parent.agent_user_id
       OR NOT COALESCE(public.aws_is_active_mortgage_agent(p_counterparty_agent_id), false)
    THEN
      RAISE EXCEPTION 'invalid_counterparty' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF abs(p_amount_cents::bigint) > abs(v_parent.amount_cents::bigint) THEN
    RAISE EXCEPTION 'adjustment_exceeds_parent'
      USING ERRCODE = '22023',
            DETAIL = format('abs(amount) %s exceeds parent amount %s', abs(p_amount_cents::bigint), v_parent.amount_cents);
  END IF;

  IF v_signed < 0 THEN
    SELECT v_parent.amount_cents::bigint + COALESCE(sum(c.amount_cents), 0)
      INTO v_net
    FROM public.mortgage_agent_compensation_entries c
    WHERE c.parent_entry_id = v_parent.id
      AND c.agent_user_id = v_parent.agent_user_id
      AND c.status NOT IN ('voided', 'excluded');
    IF abs(v_signed) > v_net THEN
      RAISE EXCEPTION 'adjustment_exceeds_net'
        USING ERRCODE = '22023',
              DETAIL = format('debit %s exceeds the agent net %s on this file', abs(v_signed), v_net);
    END IF;
  END IF;

  INSERT INTO public.mortgage_agent_compensation_batches (
    pay_period, agent_user_id, action, note, created_by, idempotency_key
  ) VALUES (
    v_period, v_parent.agent_user_id, 'adjust', v_reason, auth.uid(), v_key
  ) RETURNING id INTO v_batch_id;

  IF v_pair THEN
    v_amount := abs(p_amount_cents);
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
      status,
      parent_entry_id,
      adjustment_reason
    ) VALUES (
      v_parent.agent_user_id,
      v_parent.mortgage_request_id,
      v_parent.check_intake_item_id,
      v_parent.claim_id,
      v_parent.tenant_id,
      v_parent.classification,
      -v_amount,
      v_parent.tenant_billing_event_id,
      v_parent.tenant_billing_event_type,
      v_parent.tenant_billing_amount_cents,
      v_parent.accepted_at,
      v_parent.completed_at,
      now(),
      v_period,
      'earned',
      v_parent.id,
      v_reason
    ) RETURNING * INTO v_debit;

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
      status,
      parent_entry_id,
      adjustment_reason
    ) VALUES (
      p_counterparty_agent_id,
      v_parent.mortgage_request_id,
      v_parent.check_intake_item_id,
      v_parent.claim_id,
      v_parent.tenant_id,
      v_parent.classification,
      v_amount,
      v_parent.tenant_billing_event_id,
      v_parent.tenant_billing_event_type,
      v_parent.tenant_billing_amount_cents,
      v_parent.accepted_at,
      v_parent.completed_at,
      now(),
      v_period,
      'earned',
      v_parent.id,
      v_reason
    ) RETURNING * INTO v_credit;
  ELSE
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
      status,
      parent_entry_id,
      adjustment_reason
    ) VALUES (
      v_parent.agent_user_id,
      v_parent.mortgage_request_id,
      v_parent.check_intake_item_id,
      v_parent.claim_id,
      v_parent.tenant_id,
      v_parent.classification,
      p_amount_cents,
      v_parent.tenant_billing_event_id,
      v_parent.tenant_billing_event_type,
      v_parent.tenant_billing_amount_cents,
      v_parent.accepted_at,
      v_parent.completed_at,
      now(),
      v_period,
      'earned',
      v_parent.id,
      v_reason
    ) RETURNING * INTO v_debit;
  END IF;

  INSERT INTO public.mortgage_agent_compensation_audit (
    entry_id, batch_id, actor_id, action, from_status, to_status, payload
  ) VALUES (
    v_parent.id,
    v_batch_id,
    auth.uid(),
    'adjust',
    v_parent.status,
    v_parent.status,
    jsonb_build_object(
      'parent_entry_id', v_parent.id,
      'reason', v_reason,
      'amount_cents', v_signed,
      'counterparty_agent_id', p_counterparty_agent_id,
      'debit_entry_id', v_debit.id,
      'credit_entry_id', v_credit.id,
      'pay_period', v_period,
      'paired', v_pair,
      'idempotency_key', v_key
    )
  );

  IF v_debit.id IS NOT NULL THEN
    INSERT INTO public.mortgage_agent_compensation_audit (
      entry_id, batch_id, actor_id, action, from_status, to_status, payload
    ) VALUES (
      v_debit.id,
      v_batch_id,
      auth.uid(),
      'adjust',
      NULL,
      'earned',
      jsonb_build_object(
        'parent_entry_id', v_parent.id,
        'reason', v_reason,
        'amount_cents', v_debit.amount_cents,
        'pay_period', v_period
      )
    );
  END IF;

  IF v_credit.id IS NOT NULL THEN
    INSERT INTO public.mortgage_agent_compensation_audit (
      entry_id, batch_id, actor_id, action, from_status, to_status, payload
    ) VALUES (
      v_credit.id,
      v_batch_id,
      auth.uid(),
      'adjust',
      NULL,
      'earned',
      jsonb_build_object(
        'parent_entry_id', v_parent.id,
        'reason', v_reason,
        'amount_cents', v_credit.amount_cents,
        'pay_period', v_period
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'parent_entry_id', v_parent.id,
    'parent_status', v_parent.status,
    'parent_amount_cents', v_parent.amount_cents,
    'parent_agent_user_id', v_parent.agent_user_id,
    'pay_period', v_period,
    'paired', v_pair,
    'batch_id', v_batch_id,
    'idempotency_key', v_key,
    'idempotent_replay', false,
    'debit', to_jsonb(v_debit),
    'credit', CASE WHEN v_credit.id IS NULL THEN NULL ELSE to_jsonb(v_credit) END
  );
END;
$$;

COMMENT ON FUNCTION public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text, text) IS
  'Platform-owner-only append-only compensation adjustment, bounded by the parent amount and the agent net, idempotent per key. Never rewrites parent facts. Optional wrong-agent pair is atomic (-A / +B). Bookkeeping only.';

REVOKE ALL ON FUNCTION public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text, text)
  TO checksops, authenticated;
