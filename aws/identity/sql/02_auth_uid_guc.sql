-- Replace the restore-time NULL stub so public functions that call auth.uid() receive
-- the existing ChecksOps application UUID, never a Cognito sub.
-- The API sets request.app_user_id from identity_accounts.application_user_id.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw text;
BEGIN
  raw := nullif(current_setting('request.app_user_id', true), '');
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'request.app_user_id is not a uuid';
END;
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN nullif(current_setting('request.app_user_id', true), '') IS NULL THEN NULL
    ELSE 'authenticated'
  END;
$$;

CREATE OR REPLACE FUNCTION auth.email()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.email', true), '');
$$;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN nullif(current_setting('request.app_user_id', true), '') IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object(
      'sub', current_setting('request.app_user_id', true),
      'role', 'authenticated',
      'email', nullif(current_setting('request.jwt.claim.email', true), '')
    )
  END;
$$;

COMMENT ON FUNCTION auth.uid() IS
  'Returns request.app_user_id (ChecksOps application UUID). Not Cognito sub.';
