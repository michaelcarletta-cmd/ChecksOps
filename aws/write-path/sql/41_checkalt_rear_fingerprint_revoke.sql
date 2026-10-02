-- Inverse of 40_checkalt_rear_fingerprint_grant.sql

REVOKE UPDATE (endorsement_render_meta)
  ON TABLE public.check_intake_items FROM checksops;
