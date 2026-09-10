-- =============================================================================
-- NOT APPLIED — proposed additive migration only.
-- Do not run this file against staging or production as part of this PR.
-- Do not include it in supabase/migrations until a separately approved deploy.
--
-- Purpose: tenant-owned SES sending-domain uniqueness + optional SES metadata.
-- Existing tenant_email_settings columns are reused. These changes are additive.
-- =============================================================================

-- Unique sending domain across tenants (one tenant cannot claim another’s domain).
-- Disabled/unverified rows with a NULL sending_domain are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_email_settings_sending_domain_unique
  ON public.tenant_email_settings (lower(sending_domain))
  WHERE sending_domain IS NOT NULL AND btrim(sending_domain) <> '';

-- Expand domain_status for SES lifecycle (verifying / disabled).
ALTER TABLE public.tenant_email_settings
  DROP CONSTRAINT IF EXISTS tenant_email_settings_domain_status_check;

ALTER TABLE public.tenant_email_settings
  ADD CONSTRAINT tenant_email_settings_domain_status_check
  CHECK (domain_status IN (
    'unverified',
    'pending',
    'verifying',
    'verified',
    'failed',
    'disabled'
  ));

-- Optional SES metadata. Never store AWS credentials here.
ALTER TABLE public.tenant_email_settings
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS ses_identity_name text,
  ADD COLUMN IF NOT EXISTS custom_sending_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mail_from_domain text,
  ADD COLUMN IF NOT EXISTS mail_from_records jsonb;

COMMENT ON COLUMN public.tenant_email_settings.ses_identity_name IS
  'SES EmailIdentity name last created/checked for this tenant. Must match sending_domain. Not an ARN.';
COMMENT ON COLUMN public.tenant_email_settings.custom_sending_enabled IS
  'Server-controlled. True only while custom From is allowed; disable mapping without deleting SES.';
COMMENT ON COLUMN public.tenant_email_settings.mail_from_domain IS
  'Optional custom MAIL FROM (e.g. bounce.notify.example.com). Not required for v1.';
