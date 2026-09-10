-- Staging-only identity mapping. Do not run against production or database postgres.
-- application_user_id is the existing ChecksOps UUID (profiles.id / tenant_users.user_id /
-- user_roles.user_id). cognito_sub is a login identifier only and must stay unique.
-- One row per application user and one Cognito sub per row: PK(application_user_id),
-- UNIQUE(cognito_sub), UNIQUE(lower(email)). Do not add a second sub for the same user.
-- Do not FK application_user_id to profiles(id): one of the 9 restored users has roles
-- and no profiles row. Logical parent is this table.

CREATE TABLE IF NOT EXISTS public.identity_accounts (
  application_user_id uuid PRIMARY KEY,
  cognito_sub text UNIQUE,
  email text,
  status text NOT NULL DEFAULT 'pending',
  linked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_accounts_status_check
    CHECK (status IN ('pending', 'active', 'isolated_test')),
  CONSTRAINT identity_accounts_sub_when_linked
    CHECK (
      (status = 'pending' AND cognito_sub IS NULL)
      OR (status IN ('active', 'isolated_test') AND cognito_sub IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS identity_accounts_email_lower_key
  ON public.identity_accounts (lower(email))
  WHERE email IS NOT NULL;

COMMENT ON TABLE public.identity_accounts IS
  'Cognito sub -> existing ChecksOps application_user_id. Never store sub in profiles.id or audit columns.';
COMMENT ON COLUMN public.identity_accounts.application_user_id IS
  'Existing ChecksOps user UUID. Same value as profiles.id when a profile exists.';
COMMENT ON COLUMN public.identity_accounts.cognito_sub IS
  'Cognito JWT sub. Unique. NULL while status=pending (user not invited).';

REVOKE ALL ON TABLE public.identity_accounts FROM PUBLIC;
GRANT SELECT ON TABLE public.identity_accounts TO checksops;
