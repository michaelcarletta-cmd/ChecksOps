CREATE OR REPLACE FUNCTION public.sync_homeowner_ledger_from_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_event_type text;
BEGIN
  IF NEW.claim_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.check_source, 'insurance') <> 'insurance' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
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
       AND v_event_type <> 'endorsements_sent'
       AND v_event_type IS DISTINCT FROM 'check_received'
       AND NOT EXISTS (
         SELECT 1 FROM public.homeowner_ledger_events
         WHERE check_id = NEW.id AND event_type = v_event_type
       ) THEN
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
