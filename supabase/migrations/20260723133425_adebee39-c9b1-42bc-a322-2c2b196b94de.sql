-- 1. Remove trigger and function that copied payees across sibling checks
DROP TRIGGER IF EXISTS trg_sync_claim_payees_on_link ON public.check_intake_items;
DROP FUNCTION IF EXISTS public.tg_sync_claim_payees_on_link() CASCADE;
DROP FUNCTION IF EXISTS public.sync_claim_payees_to_check(uuid) CASCADE;

-- 2. Clean up rows inserted by the mass backfill (single-timestamp batch).
DELETE FROM public.check_payees
WHERE created_at = '2026-07-23 13:17:08.644084+00';