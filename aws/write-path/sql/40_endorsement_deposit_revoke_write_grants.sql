-- Inverse of 39_endorsement_deposit_write_grants.sql.

REVOKE UPDATE (
  back_image_deposit_path,
  endorsement_render_status,
  endorsement_render_meta,
  endorsement_override
) ON TABLE public.check_intake_items FROM checksops, authenticated;
