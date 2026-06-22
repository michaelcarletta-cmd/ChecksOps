-- Two places independently mapped local lifecycle -> partner_status:
-- sync_partner_status_from_local() (BEFORE trigger, has the "never regress"
-- rank guard, but was missing disputed/lost) and the push-status-to-freedom
-- edge function's mapToPartnerStatus() (had disputed/lost, but no rank guard
-- and no loss_draft_required). Because notify_freedom_status_change() pushed
-- raw status/check_stage/deposit_recommendation instead of the already-mapped
-- partner_status, the AFTER trigger could re-derive and forward a regressed or
-- differently-mapped value even when the BEFORE trigger had correctly blocked
-- it locally. Fix: complete the BEFORE trigger's mapping (add disputed/lost)
-- and have the AFTER trigger forward that single mapped value instead of
-- re-deriving its own.

CREATE OR REPLACE FUNCTION public.sync_partner_status_from_local()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_stage text := lower(coalesce(NEW.check_stage::text, ''));
  v_status text := lower(coalesce(NEW.status, ''));
  v_dep text := lower(coalesce(NEW.deposit_recommendation, ''));
  v_key text;
  v_label text;
  v_local_rank int;
  v_partner_rank int;
BEGIN
  IF v_stage LIKE '%deposit%complete%' OR v_stage = 'deposited' OR v_status = 'deposited' THEN
    v_key := 'released'; v_label := 'Released';
  ELSIF v_stage LIKE '%ready_for_deposit%' OR v_status = 'approved_for_deposit' THEN
    v_key := 'endorsed'; v_label := 'Endorsed - Ready for Deposit';
  ELSIF v_stage LIKE '%endorse%complete%' THEN
    v_key := 'endorsed'; v_label := 'Endorsed';
  ELSIF v_stage LIKE '%endorse%' OR v_status = 'endorsements_in_progress' THEN
    v_key := 'endorsement_pending'; v_label := 'Endorsement Pending';
  ELSIF v_stage LIKE '%review%' OR v_status = 'needs_review' THEN
    v_key := 'in_review'; v_label := 'In Review';
  ELSIF v_stage LIKE '%loss_draft%' OR v_status = 'loss_draft_required' THEN
    v_key := 'loss_draft_required'; v_label := 'Loss Draft Required';
  ELSIF v_stage LIKE '%dispute%' OR v_status = 'disputed' THEN
    v_key := 'disputed'; v_label := 'Disputed';
  ELSIF v_stage LIKE '%lost%' OR v_status = 'lost' THEN
    v_key := 'lost'; v_label := 'Lost';
  ELSIF v_stage LIKE '%hold%' OR v_status = 'held' THEN
    v_key := 'held'; v_label := 'Held';
  ELSIF v_stage LIKE '%void%' OR v_status = 'voided' THEN
    v_key := 'voided'; v_label := 'Voided';
  ELSIF v_stage LIKE '%return%' OR v_status = 'returned' THEN
    v_key := 'returned'; v_label := 'Returned';
  ELSE
    RETURN NEW;
  END IF;

  -- Lifecycle ranks (higher = further along / harder exception state).
  v_local_rank := CASE v_key
    WHEN 'received' THEN 10
    WHEN 'in_review' THEN 20
    WHEN 'loss_draft_required' THEN 25
    WHEN 'endorsement_pending' THEN 30
    WHEN 'endorsed' THEN 40
    WHEN 'released' THEN 50
    WHEN 'held' THEN 16
    WHEN 'disputed' THEN 17
    WHEN 'voided' THEN 5
    WHEN 'returned' THEN 5
    WHEN 'lost' THEN 4
    ELSE 0
  END;

  v_partner_rank := CASE lower(coalesce(NEW.partner_status, ''))
    WHEN 'received' THEN 10
    WHEN 'in_review' THEN 20
    WHEN 'loss_draft_required' THEN 25
    WHEN 'endorsements_in_progress' THEN 30
    WHEN 'endorsement_pending' THEN 30
    WHEN 'endorsed' THEN 40
    WHEN 'released' THEN 50
    WHEN 'deposited' THEN 50
    WHEN 'held' THEN 16
    WHEN 'disputed' THEN 17
    WHEN 'voided' THEN 5
    WHEN 'returned' THEN 5
    WHEN 'lost' THEN 4
    ELSE -1
  END;

  -- Only advance forward; never regress a partner status that's already further along.
  IF v_local_rank > v_partner_rank THEN
    NEW.partner_status := v_key;
    NEW.partner_status_label := v_label;
    NEW.partner_status_updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

-- Forward the already-mapped partner_status/partner_status_label instead of
-- raw status fields. The trigger fires on every UPDATE (partner_status is set
-- by the BEFORE trigger, not by the application's SET list, so a column-scoped
-- "UPDATE OF partner_status" trigger would never fire); the WHEN clause below
-- skips the network call whenever the BEFORE trigger didn't actually advance it.
CREATE OR REPLACE FUNCTION public.notify_freedom_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_source_app TEXT;
  v_source_check_id TEXT;
  v_url TEXT;
BEGIN
  v_source_app := NEW.external_origin->>'source_app';
  v_source_check_id := NEW.external_origin->>'source_check_id';

  IF v_source_app IS DISTINCT FROM 'freedom_crm' OR v_source_check_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_url := 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/push-status-to-freedom';

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'source_check_id', v_source_check_id,
      'partner_status', NEW.partner_status,
      'partner_status_label', NEW.partner_status_label,
      'check_number', NEW.check_number,
      'carrier_name', NEW.carrier_name,
      'amount', NEW.amount
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block the row update if outbound push fails
  RAISE WARNING 'notify_freedom_status_change failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_freedom_status_change ON public.check_intake_items;
CREATE TRIGGER trg_notify_freedom_status_change
AFTER UPDATE ON public.check_intake_items
FOR EACH ROW
WHEN (NEW.partner_status IS DISTINCT FROM OLD.partner_status)
EXECUTE FUNCTION public.notify_freedom_status_change();
