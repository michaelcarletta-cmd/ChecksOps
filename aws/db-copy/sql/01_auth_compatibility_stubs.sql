-- Compatibility stubs so public function bodies that call auth.uid() can restore onto RDS.
-- PREPARATION ONLY: do not run yet.
-- This is NOT a Supabase Auth migration and does NOT create Cognito users.
-- Live catalog: 9 auth.users, 0 public FKs to auth.users, 40 public functions reference auth.uid().
-- First copy does NOT load Auth user rows. Do not store password hashes, sessions, refresh tokens, or MFA factors.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text,
  created_at timestamptz,
  invited_at timestamptz,
  last_sign_in_at timestamptz,
  raw_user_meta_data jsonb,
  raw_app_meta_data jsonb
);

COMMENT ON TABLE auth.users IS 'Empty stub for function compilation. First copy does not load Auth users. Not Cognito.';

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULL::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULL::text;
$$;

CREATE OR REPLACE FUNCTION auth.email()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULL::text;
$$;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT '{}'::jsonb;
$$;
