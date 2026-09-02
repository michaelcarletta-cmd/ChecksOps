-- Revoke Tranche 5 grants only. Leaves T1–T3 grants in place.

REVOKE INSERT ON TABLE public.check_intake_items FROM checksops, authenticated;
REVOKE UPDATE (
  status,
  check_stage,
  reviewed_by,
  reviewed_at,
  review_notes,
  ocr_needs_verification,
  mortgage_monitoring_type,
  mortgage_sent_at,
  mortgage_tracking_number,
  mortgage_received_at
) ON TABLE public.check_intake_items FROM checksops, authenticated;
REVOKE DELETE ON TABLE public.check_intake_items FROM checksops, authenticated;

-- Restore T2 review_notes / updated_at update (revoked above as part of the list).
GRANT UPDATE (
  review_notes,
  updated_at
) ON TABLE public.check_intake_items TO checksops, authenticated;

REVOKE ALL ON TABLE public.loss_draft_tracking FROM checksops, authenticated;
GRANT SELECT ON TABLE public.loss_draft_tracking TO checksops, authenticated;

REVOKE ALL ON TABLE public.mortgage_handling_requests FROM checksops, authenticated;
GRANT SELECT ON TABLE public.mortgage_handling_requests TO checksops, authenticated;

REVOKE ALL ON TABLE public.loss_draft_audit_log FROM checksops, authenticated;
GRANT SELECT ON TABLE public.loss_draft_audit_log TO checksops, authenticated;

REVOKE DELETE ON TABLE public.loss_draft_documents FROM checksops, authenticated;
REVOKE DELETE ON TABLE public.check_review_decisions FROM checksops, authenticated;
REVOKE DELETE ON TABLE public.check_status_audit FROM checksops, authenticated;
