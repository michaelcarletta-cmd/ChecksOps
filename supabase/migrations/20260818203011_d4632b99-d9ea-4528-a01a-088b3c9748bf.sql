DO $$
BEGIN
  IF position('needs_review' IN pg_get_functiondef('public.tg_record_mortgage_handling_billing()'::regprocedure)) > 0
     OR position('loss_draft_required' IN pg_get_functiondef('public.tg_record_mortgage_handling_billing()'::regprocedure)) > 0
  THEN
    RAISE EXCEPTION 'Obsolete check-stage names remain in MortgageOps billing trigger';
  END IF;
END;
$$;