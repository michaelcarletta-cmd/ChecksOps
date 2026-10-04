-- Transaction-scoped only. Hard-bound to the staging A47/A48 synthetic family.
-- Allows paid → excluded solely for those tenant/request/check/agent IDs.
-- Does not allow paid → voided. Facts and paid DELETE stay blocked.
-- Must be replaced by 50_restore_sql47_trigger.sql before COMMIT.

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
    IF NEW.status = 'excluded'
       AND OLD.tenant_id = 'a2c0fbfe-e8c5-42dc-bc32-2c4edf8f2074'
       AND OLD.mortgage_request_id IN (
         'a47cad99-0000-4000-8000-000000000021',
         'a47cad99-0000-4000-8000-000000000022',
         'a47cad99-0000-4000-8000-000000000023',
         'a48cad99-0000-4000-8000-000000000021',
         'a48cad99-0000-4000-8000-000000000024'
       )
       AND (
         OLD.check_intake_item_id IS NULL
         OR OLD.check_intake_item_id IN (
           'a47cad99-0000-4000-8000-000000000011',
           'a47cad99-0000-4000-8000-000000000012',
           'a47cad99-0000-4000-8000-000000000013',
           'a48cad99-0000-4000-8000-000000000011',
           'a48cad99-0000-4000-8000-000000000013'
         )
       )
       AND OLD.agent_user_id IN (
         'b100f05d-9e81-4a7b-b9cc-9baf173131d9',
         '4584ac20-2703-4a2f-835e-7bd574aa5376'
       )
    THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'compensation_paid_immutable';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
