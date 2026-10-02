-- Narrow column grant so write-capable CheckAlt preflight / official-rear
-- upload-url can persist checkalt_rear_fingerprint on existing JPEGs.
-- Does not GRANT amount, status, check_stage, deposit paths, or routing.
-- Does not GRANT to PUBLIC / anon. HTTP /data/write still denies this column
-- via INTAKE_PROHIBITED_COLUMNS. RLS remains the authorization boundary.
-- Does not apply financial activation (SQL 64).

GRANT UPDATE (endorsement_render_meta)
  ON TABLE public.check_intake_items TO checksops;
