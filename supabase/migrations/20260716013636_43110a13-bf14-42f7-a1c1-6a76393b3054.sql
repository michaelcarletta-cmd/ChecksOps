
ALTER TABLE public.homeowner_ledger_events
  DROP CONSTRAINT IF EXISTS homeowner_ledger_events_event_type_check;

ALTER TABLE public.homeowner_ledger_events
  ADD CONSTRAINT homeowner_ledger_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'check_received','endorsement_requested','endorsement_signed',
    'endorsements_sent','ready_for_deposit','loss_draft_routing',
    'deposited','cleared','funds_released',
    'production_projected','production_confirmed','production_doc_uploaded',
    'supplement_check','depreciation_check','deductible_check',
    'homeowner_check_upload','homeowner_upload_attached'
  ]));

CREATE OR REPLACE FUNCTION public.sync_homeowner_ledger_from_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_type text;
BEGIN
  IF NEW.claim_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.check_source, 'insurance') <> 'insurance' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.homeowner_ledger_events
      (tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json)
    VALUES
      (NEW.tenant_id, NEW.claim_id, NEW.id, 'check_received', COALESCE(NEW.created_at, now()),
       NEW.amount, 'System', jsonb_build_object('status', NEW.status, 'source', 'check_intake_items'));
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_event_type := CASE NEW.status
      WHEN 'endorsements_in_progress' THEN 'endorsements_sent'
      WHEN 'approved_for_deposit'     THEN 'ready_for_deposit'
      WHEN 'branch_deposit_required'  THEN 'ready_for_deposit'
      WHEN 'loss_draft_required'      THEN 'loss_draft_routing'
      WHEN 'deposited'                THEN 'deposited'
      ELSE NULL
    END;
    IF v_event_type IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.homeowner_ledger_events
                        WHERE check_id = NEW.id AND event_type = v_event_type) THEN
      INSERT INTO public.homeowner_ledger_events
        (tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json)
      VALUES
        (NEW.tenant_id, NEW.claim_id, NEW.id, v_event_type, now(),
         NEW.amount, 'System',
         jsonb_build_object('status', NEW.status, 'prev_status', OLD.status, 'source', 'check_intake_items'));
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_homeowner_ledger_ins ON public.check_intake_items;
CREATE TRIGGER trg_sync_homeowner_ledger_ins
AFTER INSERT ON public.check_intake_items
FOR EACH ROW EXECUTE FUNCTION public.sync_homeowner_ledger_from_check();

DROP TRIGGER IF EXISTS trg_sync_homeowner_ledger_upd ON public.check_intake_items;
CREATE TRIGGER trg_sync_homeowner_ledger_upd
AFTER UPDATE OF status ON public.check_intake_items
FOR EACH ROW EXECUTE FUNCTION public.sync_homeowner_ledger_from_check();

-- Backfill check_received
INSERT INTO public.homeowner_ledger_events
  (tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json)
SELECT c.tenant_id, c.claim_id, c.id, 'check_received',
       COALESCE(c.created_at, now()), c.amount, 'System',
       jsonb_build_object('status', c.status, 'source', 'backfill')
  FROM public.check_intake_items c
 WHERE c.claim_id IS NOT NULL
   AND COALESCE(c.check_source, 'insurance') = 'insurance'
   AND NOT EXISTS (SELECT 1 FROM public.homeowner_ledger_events e
                    WHERE e.check_id = c.id AND e.event_type = 'check_received');

-- Backfill terminal-ish status events
INSERT INTO public.homeowner_ledger_events
  (tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json)
SELECT c.tenant_id, c.claim_id, c.id,
       CASE c.status
         WHEN 'endorsements_in_progress' THEN 'endorsements_sent'
         WHEN 'approved_for_deposit'     THEN 'ready_for_deposit'
         WHEN 'branch_deposit_required'  THEN 'ready_for_deposit'
         WHEN 'loss_draft_required'      THEN 'loss_draft_routing'
         WHEN 'deposited'                THEN 'deposited'
       END,
       COALESCE(c.updated_at, c.created_at, now()),
       c.amount, 'System',
       jsonb_build_object('status', c.status, 'source', 'backfill')
  FROM public.check_intake_items c
 WHERE c.claim_id IS NOT NULL
   AND COALESCE(c.check_source, 'insurance') = 'insurance'
   AND c.status IN ('endorsements_in_progress','approved_for_deposit','branch_deposit_required','loss_draft_required','deposited')
   AND NOT EXISTS (
     SELECT 1 FROM public.homeowner_ledger_events e
      WHERE e.check_id = c.id
        AND e.event_type = CASE c.status
              WHEN 'endorsements_in_progress' THEN 'endorsements_sent'
              WHEN 'approved_for_deposit'     THEN 'ready_for_deposit'
              WHEN 'branch_deposit_required'  THEN 'ready_for_deposit'
              WHEN 'loss_draft_required'      THEN 'loss_draft_routing'
              WHEN 'deposited'                THEN 'deposited'
            END
   );
