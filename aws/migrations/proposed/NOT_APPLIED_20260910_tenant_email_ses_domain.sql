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
-- Direct table DML is denied to the staging API role (checksops). The API
-- consumes counters only via consume_tenant_email_action_rate_limit.
CREATE TABLE IF NOT EXISTS public.tenant_email_action_rate_limits (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  action text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (tenant_id, user_id, action)
);

COMMENT ON TABLE public.tenant_email_action_rate_limits IS
  'Atomic sliding-window counters for tenant email-domain APIs. Not on the generic data API. Consume only via consume_tenant_email_action_rate_limit. Do not store emails, DKIM, or ARNs.';

ALTER TABLE public.tenant_email_action_rate_limits OWNER TO checksops_admin;
ALTER TABLE public.tenant_email_action_rate_limits ENABLE ROW LEVEL SECURITY;

-- No RLS policy for checksops: default-deny for the API role. No SELECT /
-- INSERT / UPDATE / DELETE grants. Default privileges must not re-expose this
-- table through PostgREST / allowed-tables.json.
REVOKE ALL ON TABLE public.tenant_email_action_rate_limits FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_email_action_rate_limits FROM checksops;

-- Narrow SECURITY DEFINER consume path. Runs as checksops_admin (table owner)
-- so INSERT … ON CONFLICT can proceed without granting table DML to checksops.
-- auth.uid() is schema-qualified (search_path does not include auth).
CREATE OR REPLACE FUNCTION public.consume_tenant_email_action_rate_limit(
  p_tenant_id uuid,
  p_user_id uuid,
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS TABLE(allowed boolean, count integer, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz;
  v_window interval;
  v_window_started_at timestamptz;
  v_count integer;
  v_allowed boolean;
  v_retry integer;
BEGIN
  IF p_tenant_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_rate_limit_identity'
      USING ERRCODE = '22023';
  END IF;

  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'rate_limit_caller_mismatch'
      USING ERRCODE = '42501';
  END IF;

  IF p_action IS NULL OR p_action NOT IN (
    'domain_start',
    'domain_check',
    'domain_save',
    'domain_disable',
    'domain_delete'
  ) THEN
    RAISE EXCEPTION 'invalid_rate_limit_action'
      USING ERRCODE = '22023';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_rate_limit_bound'
      USING ERRCODE = '22023';
  END IF;

  IF p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'invalid_rate_limit_window'
      USING ERRCODE = '22023';
  END IF;

  v_now := now();
  v_window := make_interval(secs => p_window_seconds);

  INSERT INTO public.tenant_email_action_rate_limits AS rl
    (tenant_id, user_id, action, window_started_at, request_count)
  VALUES
    (p_tenant_id, p_user_id, p_action, v_now, 1)
  ON CONFLICT (tenant_id, user_id, action)
  DO UPDATE SET
    window_started_at = CASE
      WHEN rl.window_started_at <= (EXCLUDED.window_started_at - v_window)
      THEN EXCLUDED.window_started_at
      ELSE rl.window_started_at
    END,
    request_count = CASE
      WHEN rl.window_started_at <= (EXCLUDED.window_started_at - v_window)
      THEN 1
      ELSE rl.request_count + 1
    END
  RETURNING rl.window_started_at, rl.request_count
  INTO v_window_started_at, v_count;

  v_allowed := v_count <= p_limit;
  IF v_allowed THEN
    v_retry := 0;
  ELSE
    v_retry := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM ((v_window_started_at + v_window) - v_now)))::integer
    );
  END IF;

  RETURN QUERY SELECT v_allowed, v_count, v_retry;
END;
$$;

COMMENT ON FUNCTION public.consume_tenant_email_action_rate_limit(uuid, uuid, text, integer, integer) IS
  'Atomic tenant email-domain rate-limit consume. SECURITY DEFINER. Returns allowed/count/retry_after_seconds only. Retry is computed from Postgres now() and window_started_at.';

ALTER FUNCTION public.consume_tenant_email_action_rate_limit(uuid, uuid, text, integer, integer)
  OWNER TO checksops_admin;

REVOKE ALL ON FUNCTION public.consume_tenant_email_action_rate_limit(uuid, uuid, text, integer, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_tenant_email_action_rate_limit(uuid, uuid, text, integer, integer)
  TO checksops;

COMMIT;
