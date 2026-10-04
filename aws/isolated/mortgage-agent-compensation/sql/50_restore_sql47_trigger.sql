-- Exact SQL 47 paid-immutability trigger. Restore this before COMMIT.
-- Not a new capability. paid → anything remains forbidden.

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

  IF OLD.status = 'paid' AND NEW.status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION 'compensation_paid_immutable';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
