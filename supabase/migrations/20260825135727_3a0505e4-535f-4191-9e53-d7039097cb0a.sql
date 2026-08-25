-- Backfill: move checks with fully settled disbursement splits out of the
-- Deposited / Ready for Deposit lanes into Funds Released.
-- Reuses the same recompute function the disbursement triggers call, so the
-- backfill matches live behavior exactly (only flips when every split on the
-- check is in a settled/sent state, and never touches checks in other lanes).
DO $$
DECLARE
  r RECORD;
  v_updated int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT b.check_intake_item_id AS cid
    FROM public.disbursement_batches b
    WHERE b.check_intake_item_id IS NOT NULL
  LOOP
    PERFORM public.recompute_check_release_stage(r.cid);
    v_updated := v_updated + 1;
  END LOOP;
  RAISE NOTICE 'Recomputed release stage for % checks with disbursement batches', v_updated;
END $$;