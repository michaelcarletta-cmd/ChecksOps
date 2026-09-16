-- Official Endorsement Adjuster persist columns for CheckAlt artifact generation.
-- Does not GRANT amount, status, check_stage, deposited_at, or any provider table.
-- RLS remains the authorization boundary.

GRANT UPDATE (
  back_image_deposit_path,
  endorsement_render_status,
  endorsement_render_meta,
  endorsement_override
) ON TABLE public.check_intake_items TO checksops, authenticated;
