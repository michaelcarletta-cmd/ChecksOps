-- NOT APPLIED.
-- Versions the live production Cognito identity table and documents the
-- environment split. Do not run against production or database postgres
-- unless a later approved apply is explicitly authorized.
--
-- Staging identities stay on public.identity_accounts (one row per
-- application user; cognito_sub unique). Production identities stay on
-- public.identity_production_cognito_locks (one row per application user;
-- cognito_sub unique). The resolver selects exactly one table from trusted
-- CHECKSOPS_ENV + verified Cognito pool. It does not rewrite either table
-- during login.

CREATE TABLE IF NOT EXISTS public.identity_production_cognito_locks (
  application_user_id uuid PRIMARY KEY,
  cognito_sub text NOT NULL UNIQUE
);

COMMENT ON TABLE public.identity_production_cognito_locks IS
  'Production Cognito sub -> existing ChecksOps application_user_id. Isolated from identity_accounts (staging).';
COMMENT ON COLUMN public.identity_production_cognito_locks.application_user_id IS
  'Existing ChecksOps user UUID. Same value as identity_accounts.application_user_id.';
COMMENT ON COLUMN public.identity_production_cognito_locks.cognito_sub IS
  'Production Cognito JWT sub. Unique. Never used to resolve a staging token.';

COMMENT ON TABLE public.identity_accounts IS
  'Staging Cognito sub -> existing ChecksOps application_user_id. Production tokens must not be resolved from this table.';

REVOKE ALL ON TABLE public.identity_production_cognito_locks FROM PUBLIC;
GRANT SELECT ON TABLE public.identity_production_cognito_locks TO checksops;
