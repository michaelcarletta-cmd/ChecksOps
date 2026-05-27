
-- Remove all checks except Andrew Schneller's intake items
DO $$
DECLARE
  keep_ids uuid[] := ARRAY[
    'c7ab0325-989e-4194-bb00-670e1bbe641e'::uuid,
    'd5cb0aa4-ad64-4862-abbe-219b21b51c01'::uuid,
    'f9755fe2-f7b5-454a-ac62-beaec1090397'::uuid
  ];
  keep_claim_check_ids uuid[];
BEGIN
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO keep_claim_check_ids
    FROM claim_checks
   WHERE check_intake_item_id = ANY(keep_ids);

  -- Null/remove non-cascading references first (claim_checks side)
  DELETE FROM claim_disbursements WHERE check_id <> ALL(keep_claim_check_ids);
  UPDATE mortgage_releases SET check_id = NULL WHERE check_id IS NOT NULL AND check_id <> ALL(keep_claim_check_ids);
  DELETE FROM claim_check_mortgage_draws WHERE check_id <> ALL(keep_claim_check_ids);
  DELETE FROM check_payment_directions WHERE check_id <> ALL(keep_claim_check_ids);

  -- Delete claim_checks themselves (except any tied to Andrew)
  DELETE FROM claim_checks WHERE id <> ALL(keep_claim_check_ids);

  -- Now clean up non-cascading FKs on check_intake_items
  DELETE FROM deposit_items WHERE check_id <> ALL(keep_ids);
  DELETE FROM disbursement_batches WHERE check_intake_item_id IS NOT NULL AND check_intake_item_id <> ALL(keep_ids);
  DELETE FROM claim_check_payments WHERE check_intake_item_id IS NOT NULL AND check_intake_item_id <> ALL(keep_ids);
  UPDATE loss_draft_tracking SET check_intake_item_id = NULL WHERE check_intake_item_id IS NOT NULL AND check_intake_item_id <> ALL(keep_ids);
  UPDATE claim_payments SET check_intake_item_id = NULL WHERE check_intake_item_id IS NOT NULL AND check_intake_item_id <> ALL(keep_ids);

  -- Finally delete intake items (cascades to payees, endorsements, messages, audit, etc.)
  DELETE FROM check_intake_items WHERE id <> ALL(keep_ids);
END $$;
