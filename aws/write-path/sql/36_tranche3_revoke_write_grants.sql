-- Revoke Tranche 3 grants only. Leaves Tranche 1 and Tranche 2 grants in place.

REVOKE INSERT ON TABLE public.check_messages FROM checksops, authenticated;

REVOKE UPDATE (
  front_image_path,
  back_image_path,
  back_image_original_path
) ON TABLE public.check_intake_items FROM checksops, authenticated;

REVOKE ALL ON TABLE public.check_files FROM checksops, authenticated;
GRANT SELECT ON TABLE public.check_files TO checksops, authenticated;

REVOKE UPDATE (
  carrier_name,
  check_number,
  payee_line,
  notes,
  check_date,
  received_date,
  ocr_needs_verification,
  updated_at
) ON TABLE public.claim_checks FROM checksops, authenticated;
