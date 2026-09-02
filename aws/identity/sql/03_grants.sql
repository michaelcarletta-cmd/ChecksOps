-- Least-privilege grants so role checksops can resolve auth.uid() during a request.
-- Do not grant SELECT on auth.users. Do not grant INSERT/UPDATE/DELETE on identity_accounts.
-- Do not GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public.

GRANT USAGE ON SCHEMA auth TO checksops;
GRANT EXECUTE ON FUNCTION auth.uid() TO checksops;
GRANT EXECUTE ON FUNCTION auth.role() TO checksops;
GRANT EXECUTE ON FUNCTION auth.email() TO checksops;
GRANT EXECUTE ON FUNCTION auth.jwt() TO checksops;

GRANT SELECT ON TABLE public.identity_accounts TO checksops;
