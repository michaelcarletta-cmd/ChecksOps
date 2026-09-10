-- =============================================================================
-- NOT APPLIED — proposed additive migration only.
-- Do not run this file against staging or production as part of this PR.
-- Do not include it in supabase/migrations until a separately approved deploy.
--
-- Purpose: tenant-owned SES sending-domain uniqueness, optional SES metadata,
-- and durable per-tenant/user/action rate limits.
-- Existing tenant_email_settings columns are reused. These changes are additive.
-- The entire file is one transaction: any failure rolls back all statements.
-- =============================================================================

BEGIN;

-- Read-only duplicate preflight (same query is documented in
-- aws/docs/tenant-ses-email-domain.md). Lists only normalized domains and
-- counts — no tenant names, emails, or other PII. Does not delete, merge,
-- or rewrite rows.
DO $$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(format('%s (%s)', domain, cnt), ', ' ORDER BY domain)
  INTO dupes
  FROM (
    SELECT lower(btrim(sending_domain)) AS domain, count(*)::int AS cnt
    FROM public.tenant_email_settings
    WHERE sending_domain IS NOT NULL AND btrim(sending_domain) <> ''
    GROUP BY 1
    HAVING count(*) > 1
  ) d;

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_email_settings duplicate sending_domain values: %', dupes;
  END IF;
END $$;

-- Unique sending domain across tenants (one tenant cannot claim another’s domain).
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

-- Durable rate limits for mutating / SES-check actions.
-- Scoped by tenant + application user + action. Server clock only (now()).
-- Not exposed through the generic data API. No PII, domains, or tokens.
CREATE TABLE IF NOT EXISTS public.tenant_email_action_rate_limits (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  action text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (tenant_id, user_id, action)
);

COMMENT ON TABLE public.tenant_email_action_rate_limits IS
  'Atomic sliding-window counters for tenant email-domain APIs. API-only. Do not store emails, DKIM, or ARNs.';

ALTER TABLE public.tenant_email_action_rate_limits ENABLE ROW LEVEL SECURITY;

COMMIT;
