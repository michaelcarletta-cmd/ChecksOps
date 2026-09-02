-- Tranche 3: additive DML grants for notes, check files, descriptive claim_checks,
-- and existing-check image path columns.
-- Does not GRANT DML on homeowner_ledger_events (trigger remains SECURITY DEFINER).
-- Does not GRANT amount/deposit/mortgage/stage columns on claim_checks.
-- RLS policies remain the authorization boundary.

GRANT SELECT ON TABLE public.check_intake_items TO checksops, authenticated;
GRANT UPDATE (
  front_image_path,
  back_image_path,
  back_image_original_path
) ON TABLE public.check_intake_items TO checksops, authenticated;

GRANT SELECT ON TABLE public.check_messages TO checksops, authenticated;
GRANT INSERT ON TABLE public.check_messages TO checksops, authenticated;
GRANT UPDATE (is_deleted, updated_at) ON TABLE public.check_messages TO checksops, authenticated;

GRANT SELECT, INSERT, DELETE ON TABLE public.check_files TO checksops, authenticated;
GRANT UPDATE (
  file_name,
  file_path,
  file_type,
  file_size,
  category,
  source,
  description
) ON TABLE public.check_files TO checksops, authenticated;

GRANT SELECT ON TABLE public.claim_checks TO checksops, authenticated;
GRANT UPDATE (
  carrier_name,
  check_number,
  payee_line,
  notes,
  check_date,
  received_date,
  ocr_needs_verification,
  updated_at
) ON TABLE public.claim_checks TO checksops, authenticated;
