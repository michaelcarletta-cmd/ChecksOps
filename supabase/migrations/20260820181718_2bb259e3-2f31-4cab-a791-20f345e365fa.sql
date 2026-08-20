UPDATE public.checkalt_deposits
SET status = 'rejected',
    reject_code = '1680',
    reject_notes = 'IQA: Image Unreadable - Cannot read check. Please retake photo.',
    updated_at = now()
WHERE check_intake_item_id = '1db86248-ddae-46dd-a2fc-5694680834e3'
  AND status = 'submitted';

UPDATE public.check_intake_items
SET check_stage = 'ready_for_deposit',
    status = 'approved_for_deposit',
    deposit_recommendation = 'ready_for_deposit',
    deposited_at = NULL,
    updated_at = now()
WHERE id = '1db86248-ddae-46dd-a2fc-5694680834e3';

UPDATE public.claim_checks
SET deposit_status = 'rejected'
WHERE check_intake_item_id = '1db86248-ddae-46dd-a2fc-5694680834e3';