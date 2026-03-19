
DO $$
DECLARE
  target_id uuid := '7e235a13-b703-413f-a85e-dc8a2adaea93';
BEGIN
  DELETE FROM public.check_endorsement_events WHERE check_id = target_id;
  DELETE FROM public.check_endorsements WHERE check_id = target_id;
  DELETE FROM public.check_payees WHERE check_id = target_id;
  DELETE FROM public.check_audit_log WHERE check_id = target_id;
  DELETE FROM public.check_eligibility_results WHERE check_id = target_id;
  DELETE FROM public.check_review_decisions WHERE check_id = target_id;
  DELETE FROM public.check_reissue_requests WHERE check_id = target_id;
  DELETE FROM public.claim_checks WHERE check_intake_item_id = target_id;
  DELETE FROM public.check_intake_items WHERE id = target_id;
END $$;
