
-- Sync partner_status when local check lifecycle advances past the mirrored partner state.
-- Fixes the disconnect where mirrored checks finish endorsements locally but still display
-- the stale partner_status to both the local UI and partner-shared-checks consumers.

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
  -- Map local lifecycle to the same vocabulary push-status-to-freedom uses.
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
  ELSIF v_stage LIKE '%hold%' OR v_status = 'held' THEN
    v_key := 'held'; v_label := 'Held';
  ELSIF v_stage LIKE '%void%' OR v_status = 'voided' THEN
    v_key := 'voided'; v_label := 'Voided';
  ELSIF v_stage LIKE '%return%' OR v_status = 'returned' THEN
    v_key := 'returned'; v_label := 'Returned';
  ELSE
    RETURN NEW;
  END IF;

  -- Lifecycle ranks (higher = further along).
  v_local_rank := CASE v_key
    WHEN 'received' THEN 10
    WHEN 'in_review' THEN 20
    WHEN 'loss_draft_required' THEN 25
    WHEN 'endorsement_pending' THEN 30
    WHEN 'endorsed' THEN 40
    WHEN 'released' THEN 50
    WHEN 'held' THEN 15
    WHEN 'voided' THEN 5
    WHEN 'returned' THEN 5
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
    WHEN 'held' THEN 15
    WHEN 'voided' THEN 5
    WHEN 'returned' THEN 5
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

DROP TRIGGER IF EXISTS trg_sync_partner_status_from_local ON public.check_intake_items;
CREATE TRIGGER trg_sync_partner_status_from_local
  BEFORE UPDATE OF status, check_stage, deposit_recommendation ON public.check_intake_items
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status
        OR NEW.check_stage IS DISTINCT FROM OLD.check_stage
        OR NEW.deposit_recommendation IS DISTINCT FROM OLD.deposit_recommendation)
  EXECUTE FUNCTION public.sync_partner_status_from_local();
