
CREATE OR REPLACE FUNCTION public.whoami() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT current_user::text || '/' || session_user::text $$;
GRANT EXECUTE ON FUNCTION public.whoami() TO anon, authenticated, public;
