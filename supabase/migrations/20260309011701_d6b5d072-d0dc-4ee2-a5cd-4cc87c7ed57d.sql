ALTER TABLE public.check_intake_items 
  DROP CONSTRAINT IF EXISTS check_intake_items_status_check;

ALTER TABLE public.check_intake_items 
  ADD CONSTRAINT check_intake_items_status_check 
  CHECK (status = ANY (ARRAY[
    'uploaded', 'processing', 'ocr_complete', 'endorsements_in_progress',
    'endorsements_complete', 'manual_review_required', 'ready', 'needs_review',
    'deposited', 'voided', 'approved_for_deposit', 'branch_deposit_required', 
    'reissue_requested', 'loss_draft_required'
  ]));