-- SQL 49 — Immutable Mortgage Agent compensation adjustments.
-- Additive overlay. Do not edit or reapply SQL 47.
-- Staging / local only in this phase. Do not apply to production.
--
-- Children use existing parent_entry_id. Parent facts are never rewritten.
-- No Moov / Stripe / ACH / wallet / clawback / money movement.

ALTER TABLE public.mortgage_agent_compensation_entries
  ADD COLUMN IF NOT EXISTS adjustment_reason text;

CREATE INDEX IF NOT EXISTS mortgage_agent_compensation_entries_parent_idx
  ON public.mortgage_agent_compensation_entries (parent_entry_id)
  WHERE parent_entry_id IS NOT NULL;

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

CREATE OR REPLACE FUNCTION public.adjust_mortgage_agent_compensation(
  p_parent_entry_id uuid,
  p_amount_cents integer,
  p_reason text,
  p_counterparty_agent_id uuid DEFAULT NULL,
  p_pay_period text DEFAULT NULL
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
  v_amount integer;
  v_debit public.mortgage_agent_compensation_entries%ROWTYPE;
  v_credit public.mortgage_agent_compensation_entries%ROWTYPE;
  v_batch_id uuid;
  v_pair boolean;
BEGIN
  IF NOT public.aws_can_admin_mortgage_agent_compensation() THEN
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
  ELSIF v_period !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'invalid_pay_period' USING ERRCODE = '22023';
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
  ) OR v_parent.mortgage_request_id = '5b20db20-13e1-4919-9528-06388d8661d2'::uuid THEN
    RAISE EXCEPTION 'request_excluded' USING ERRCODE = '42501';
  END IF;

  v_pair := p_counterparty_agent_id IS NOT NULL;
  IF v_pair THEN
    IF p_counterparty_agent_id = v_parent.agent_user_id THEN
      RAISE EXCEPTION 'invalid_counterparty' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = p_counterparty_agent_id
        AND ur.role = 'mortgage_agent'::public.app_role
    ) THEN
      RAISE EXCEPTION 'invalid_counterparty' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.mortgage_agent_compensation_batches (
    pay_period, agent_user_id, action, note, created_by
  ) VALUES (
    v_period, v_parent.agent_user_id, 'adjust', v_reason, auth.uid()
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
      payment_batch_id,
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
      v_batch_id,
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
      payment_batch_id,
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
      v_batch_id,
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
      payment_batch_id,
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
      v_batch_id,
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
      'amount_cents', CASE WHEN v_pair THEN -abs(p_amount_cents) ELSE p_amount_cents END,
      'counterparty_agent_id', p_counterparty_agent_id,
      'debit_entry_id', v_debit.id,
      'credit_entry_id', v_credit.id,
      'pay_period', v_period,
      'paired', v_pair
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
    'debit', to_jsonb(v_debit),
    'credit', to_jsonb(v_credit)
  );
END;
$$;

COMMENT ON FUNCTION public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text) IS
  'Append-only compensation adjustment. Never rewrites parent facts. Optional wrong-agent pair is atomic (-A / +B). Bookkeeping only.';

GRANT EXECUTE ON FUNCTION public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text)
  TO checksops, authenticated;
