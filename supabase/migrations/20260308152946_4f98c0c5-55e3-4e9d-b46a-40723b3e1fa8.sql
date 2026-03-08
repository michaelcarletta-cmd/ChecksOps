
-- Add new status values to check_intake_items
ALTER TABLE public.check_intake_items DROP CONSTRAINT IF EXISTS check_intake_items_status_check;
ALTER TABLE public.check_intake_items ADD CONSTRAINT check_intake_items_status_check
  CHECK (status IN ('uploaded','ocr_complete','endorsements_in_progress','endorsements_complete','manual_review_required','ready','needs_review','deposited','voided'));

-- Add new deposit recommendation values
ALTER TABLE public.check_intake_items DROP CONSTRAINT IF EXISTS check_intake_items_deposit_recommendation_check;
ALTER TABLE public.check_intake_items ADD CONSTRAINT check_intake_items_deposit_recommendation_check
  CHECK (deposit_recommendation IN ('ready_for_deposit','endorsements_pending','endorsements_complete','manual_review_required','branch_deposit_recommended','request_reissue'));

-- Same for eligibility results
ALTER TABLE public.check_eligibility_results DROP CONSTRAINT IF EXISTS check_eligibility_results_recommendation_check;
ALTER TABLE public.check_eligibility_results ADD CONSTRAINT check_eligibility_results_recommendation_check
  CHECK (recommendation IN ('ready_for_deposit','endorsements_pending','endorsements_complete','manual_review_required','branch_deposit_recommended','request_reissue'));

-- Unique constraint: one OCR-completed record per check_number + carrier to prevent dupes
CREATE UNIQUE INDEX IF NOT EXISTS idx_check_payees_check_name ON public.check_payees(check_id, payee_name);

-- Idempotency: prevent duplicate audit log entries within same second
CREATE UNIQUE INDEX IF NOT EXISTS idx_check_audit_idempotent ON public.check_audit_log(check_id, event_type, created_at);
