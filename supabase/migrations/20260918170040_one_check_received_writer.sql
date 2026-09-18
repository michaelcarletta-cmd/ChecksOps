-- UNAPPLIED. Repo artifact only. Do not apply from this PR.
--
-- Restore one authoritative homeowner check_received writer:
-- hle_on_check_intake_insert / trg_hle_check_intake_insert (ac131c4ff).
--
-- The later sync_homeowner_ledger_from_check INSERT stacked a second
-- check_received writer. Keep its status-transition events only.
--
-- Late link (NULL → A) and relink (A → B) are handled by the SAME function.
-- Relink updates the existing physical-check event instead of inserting another.

CREATE OR REPLACE FUNCTION public.hle_on_check_intake_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_existing uuid;
BEGIN
  IF COALESCE(NEW.check_source, 'insurance') <> 'insurance' THEN
    RETURN NEW;
  END IF;

  IF NEW.claim_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.claim_id IS NOT DISTINCT FROM OLD.claim_id THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_existing
  FROM public.homeowner_ledger_events
  WHERE check_id = NEW.id
    AND event_type = 'check_received'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE public.homeowner_ledger_events
    SET claim_id = NEW.claim_id,
        tenant_id = COALESCE(NEW.tenant_id, tenant_id),
        amount = COALESCE(NEW.amount, amount)
    WHERE id = v_existing
      AND (
        claim_id IS DISTINCT FROM NEW.claim_id
        OR (NEW.tenant_id IS NOT NULL AND tenant_id IS DISTINCT FROM NEW.tenant_id)
      );
    RETURN NEW;
  END IF;

  INSERT INTO public.homeowner_ledger_events (
    tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json
  )
  SELECT
    NEW.tenant_id,
    NEW.claim_id,
    NEW.id,
    'check_received',
    COALESCE(NEW.issue_date::timestamptz, NEW.created_at, now()),
    NEW.amount,
    NEW.carrier_name,
    jsonb_build_object(
      'check_number', NEW.check_number,
      'payee_line', NEW.payee_line,
      'source', 'hle_on_check_intake_insert'
    )
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.homeowner_ledger_events
    WHERE check_id = NEW.id
      AND event_type = 'check_received'
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hle_check_intake_insert ON public.check_intake_items;
CREATE TRIGGER trg_hle_check_intake_insert
  AFTER INSERT OR UPDATE OF claim_id ON public.check_intake_items
  FOR EACH ROW
  EXECUTE FUNCTION public.hle_on_check_intake_insert();

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

  -- INSERT no longer writes check_received. That belongs to hle_on_check_intake_insert.
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

DROP TRIGGER IF EXISTS trg_sync_homeowner_ledger_ins ON public.check_intake_items;
