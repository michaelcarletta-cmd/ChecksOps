-- Backfill: any check that completed endorsements but landed in legacy 'ready' status
-- should be promoted to 'approved_for_deposit' so it appears in the Ready for Deposit tab.
UPDATE public.check_intake_items
SET status = 'approved_for_deposit',
    deposit_recommendation = 'ready_for_deposit',
    updated_at = now()
WHERE status = 'ready'
  AND deposit_recommendation = 'ready_for_deposit';