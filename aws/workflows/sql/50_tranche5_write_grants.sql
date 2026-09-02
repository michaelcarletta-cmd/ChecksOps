-- Tranche 5: column-scoped DML for new-check intake, internal status/stage
-- transitions, and mortgage/loss-draft metadata.
-- Does not GRANT amount/deposit/routing on check_intake_items (except INSERT
-- of optional amount with claim_id left null by the application).
-- Does not GRANT mortgage_final_released_at, signed endorsement columns,
-- or any financial/provider table.
-- RLS remains the authorization boundary.

GRANT SELECT ON TABLE public.check_intake_items TO checksops, authenticated;
GRANT INSERT (
  id,
  tenant_id,
  uploaded_by,
  status,
  check_stage,
  ocr_status,
  front_image_path,
  back_image_path,
  ocr_needs_verification,
  carrier_name,
  check_number,
  payee_line,
  property_address,
  funds_type,
  review_notes,
  payee_address,
  expiration_days,
  is_multi_payee,
  issue_date,
  amount
) ON TABLE public.check_intake_items TO checksops, authenticated;

GRANT UPDATE (
  status,
  check_stage,
  reviewed_by,
  reviewed_at,
  review_notes,
  ocr_needs_verification,
  mortgage_monitoring_type,
  mortgage_sent_at,
  mortgage_tracking_number,
  mortgage_received_at,
  updated_at
) ON TABLE public.check_intake_items TO checksops, authenticated;

GRANT DELETE ON TABLE public.check_intake_items TO checksops, authenticated;

GRANT SELECT, INSERT, DELETE ON TABLE public.loss_draft_tracking TO checksops, authenticated;
GRANT UPDATE (
  mortgage_servicer,
  mortgage_company_id,
  loan_number,
  lender_website_url,
  loss_draft_contact,
  loss_draft_email,
  loss_draft_phone,
  loss_draft_fax,
  notes,
  monitoring_type,
  escrow_status,
  tracking_number_sent,
  tracking_number_return,
  shipping_method_sent,
  shipping_method_return,
  check_sent_date,
  check_received_date,
  check_received_back_date,
  follow_up_date,
  last_contact_at,
  updated_at
) ON TABLE public.loss_draft_tracking TO checksops, authenticated;

GRANT SELECT, INSERT, DELETE ON TABLE public.mortgage_handling_requests TO checksops, authenticated;
GRANT UPDATE (
  mortgage_company,
  mortgage_servicer,
  loan_number,
  note,
  work_notes,
  property_address,
  claim_number,
  insurance_company,
  homeowner_name,
  homeowner_email,
  homeowner_phone,
  status,
  updated_at
) ON TABLE public.mortgage_handling_requests TO checksops, authenticated;

GRANT SELECT, INSERT, DELETE ON TABLE public.loss_draft_audit_log TO checksops, authenticated;
GRANT SELECT, DELETE ON TABLE public.loss_draft_documents TO checksops, authenticated;
GRANT SELECT, DELETE ON TABLE public.check_review_decisions TO checksops, authenticated;
GRANT SELECT, DELETE ON TABLE public.check_status_audit TO checksops, authenticated;

-- Cleanup helpers already granted in T2/T3 for payees/messages/files/audit.
GRANT DELETE ON TABLE public.check_payees TO checksops, authenticated;
GRANT DELETE ON TABLE public.check_endorsements TO checksops, authenticated;
GRANT DELETE ON TABLE public.check_messages TO checksops, authenticated;
GRANT DELETE ON TABLE public.check_audit_log TO checksops, authenticated;
GRANT DELETE ON TABLE public.check_files TO checksops, authenticated;
GRANT DELETE ON TABLE public.check_endorsement_events TO checksops, authenticated;
GRANT DELETE ON TABLE public.check_message_reads TO checksops, authenticated;
