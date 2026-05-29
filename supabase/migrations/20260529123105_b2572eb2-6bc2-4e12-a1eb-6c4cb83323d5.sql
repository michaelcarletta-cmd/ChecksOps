CREATE OR REPLACE FUNCTION public.advance_check_on_endorsement_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_remaining int;
  v_check_id uuid;
BEGIN
  v_check_id := COALESCE(NEW.check_id, OLD.check_id);
  IF v_check_id IS NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_remaining FROM check_endorsements
  WHERE check_id = v_check_id AND status NOT IN ('signed','waived','manual_required');

  IF v_remaining = 0 THEN
    UPDATE check_intake_items
      SET check_stage = 'ready_for_deposit',
          status = CASE
            WHEN status IN ('deposited','approved_for_deposit','branch_deposit_required') THEN status
            ELSE 'approved_for_deposit'
          END,
          updated_at = now()
      WHERE id = v_check_id AND check_stage <> 'deposited';
    UPDATE claim_checks
      SET check_stage = 'ready_for_deposit', updated_at = now()
      WHERE check_intake_item_id = v_check_id AND check_stage <> 'deposited';
  END IF;
  RETURN NEW;
END;
$$;

-- Backfill: any check whose stage is ready_for_deposit but status is still a blocked label
UPDATE public.check_intake_items
SET status = 'approved_for_deposit', updated_at = now()
WHERE check_stage = 'ready_for_deposit'
  AND status IN ('loss_draft_required','endorsing','endorsements_in_progress','endorsements_complete','needs_review');