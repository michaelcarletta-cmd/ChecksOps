-- AWS staging role shim. Supabase policies use TO authenticated / TO anon.
-- checksops is the only login role the API uses. Do not create a login role
-- named service_role. Do not GRANT anon TO checksops.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END
$$;

GRANT authenticated TO checksops;

COMMENT ON ROLE authenticated IS
  'NOLOGIN shim so restored/proposed RLS policies TO authenticated apply to checksops.';
