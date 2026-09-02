-- Tranche 2: narrow DML grants for non-money-moving check workflow.
-- Does not change default_transaction_read_only.
-- Does not GRANT INSERT on check_messages (ledger mirror trigger).
-- Does not GRANT UPDATE of financial/status/deposit columns on check_intake_items.
-- RLS policies remain the authorization boundary.

REVOKE ALL ON TABLE public.check_payees FROM PUBLIC;
REVOKE ALL ON TABLE public.check_endorsements FROM PUBLIC;
REVOKE ALL ON TABLE public.check_endorsement_events FROM PUBLIC;
REVOKE ALL ON TABLE public.check_audit_log FROM PUBLIC;

GRANT SELECT ON TABLE public.check_intake_items TO checksops, authenticated;
GRANT UPDATE (
  carrier_name,
  check_number,
  issue_date,
  payee_line,
  property_address,
  funds_type,
  review_notes,
  payee_address,
  expiration_days,
  is_multi_payee,
  updated_at
) ON TABLE public.check_intake_items TO checksops, authenticated;

GRANT SELECT ON TABLE public.check_payees TO checksops, authenticated;
GRANT INSERT, DELETE ON TABLE public.check_payees TO checksops, authenticated;
GRANT UPDATE (
  payee_name,
  payee_type,
  contact_email,
  contact_phone,
  updated_at
) ON TABLE public.check_payees TO checksops, authenticated;

GRANT SELECT ON TABLE public.check_endorsements TO checksops, authenticated;
GRANT DELETE ON TABLE public.check_endorsements TO checksops, authenticated;
GRANT UPDATE (
  payee_name,
  payee_type,
  contact_email,
  contact_phone,
  notes,
  updated_at
) ON TABLE public.check_endorsements TO checksops, authenticated;

GRANT SELECT, DELETE ON TABLE public.check_endorsement_events TO checksops, authenticated;

GRANT SELECT, INSERT ON TABLE public.check_audit_log TO checksops, authenticated;

GRANT SELECT ON TABLE public.check_messages TO checksops, authenticated;
GRANT UPDATE (is_deleted, updated_at) ON TABLE public.check_messages TO checksops, authenticated;
