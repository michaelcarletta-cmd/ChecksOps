-- SQL 50 — staging-prepared audited exclude for compensation entries.
-- Does not delete ledger rows. Does not rewrite earning facts ($10/$5).
-- Does not touch mortgage_handling_requests or check_billing_events.
-- Does not reference Moov / ACH / Stripe / wallet.
-- Paid history (payment_reference, paid_at) remains on the row.

CREATE OR REPLACE FUNCTION public.tg_protect_mortgage_agent_compensation_facts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'paid' THEN
      RAISE EXCEPTION 'compensation_paid_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.agent_user_id IS DISTINCT FROM NEW.agent_user_id
     OR OLD.mortgage_request_id IS DISTINCT FROM NEW.mortgage_request_id
     OR OLD.check_intake_item_id IS DISTINCT FROM NEW.check_intake_item_id
     OR OLD.claim_id IS DISTINCT FROM NEW.claim_id
     OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.classification IS DISTINCT FROM NEW.classification
     OR OLD.amount_cents IS DISTINCT FROM NEW.amount_cents
     OR OLD.accepted_at IS DISTINCT FROM NEW.accepted_at
     OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
     OR OLD.earned_at IS DISTINCT FROM NEW.earned_at
     OR OLD.pay_period IS DISTINCT FROM NEW.pay_period
  THEN
    RAISE EXCEPTION 'compensation_facts_immutable';
  END IF;

  IF OLD.status = 'paid'
     AND NEW.status IS DISTINCT FROM 'paid'
     AND NEW.status NOT IN ('voided', 'excluded')
  THEN
    RAISE EXCEPTION 'compensation_paid_immutable';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.exclude_mortgage_agent_compensation(
  p_entry_ids uuid[],
  p_reason text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_count integer := 0;
  v_id uuid;
  v_from text;
  v_request uuid;
BEGIN
  IF NOT public.aws_can_admin_mortgage_agent_compensation() THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
  END IF;
  IF p_entry_ids IS NULL OR array_length(p_entry_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  FOREACH v_id IN ARRAY p_entry_ids LOOP
    SELECT status, mortgage_request_id
      INTO v_from, v_request
    FROM public.mortgage_agent_compensation_entries
    WHERE id = v_id
    FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    IF v_from IN ('voided', 'excluded') THEN
      CONTINUE;
    END IF;

    UPDATE public.mortgage_agent_compensation_entries
       SET status = 'excluded',
           exclusion_reason = p_reason
     WHERE id = v_id
       AND status NOT IN ('voided', 'excluded');

    IF FOUND THEN
      v_count := v_count + 1;
      INSERT INTO public.mortgage_agent_compensation_audit (
        entry_id, actor_id, action, from_status, to_status, payload
      ) VALUES (
        v_id,
        auth.uid(),
        'exclude',
        v_from,
        'excluded',
        jsonb_build_object('reason', p_reason, 'mortgage_request_id', v_request)
      );
      IF v_request IS NOT NULL THEN
        INSERT INTO public.mortgage_agent_compensation_exclusions (mortgage_request_id, reason)
        VALUES (v_request, p_reason)
        ON CONFLICT (mortgage_request_id) DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.exclude_mortgage_agent_compensation(uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exclude_mortgage_agent_compensation(uuid[], text) TO checksops, authenticated;
