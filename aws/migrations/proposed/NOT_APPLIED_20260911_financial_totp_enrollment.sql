-- =============================================================================
-- NOT APPLIED — proposed additive migration only.
-- Do not run this file against staging or production as part of this PR.
-- Do not include it in supabase/migrations until a separately approved deploy.
-- Do not disable Cognito login MFA until this schema is applied,
-- the wrap key exists, and financial TOTP verification is proven.
--
-- Purpose: application-level financial TOTP enrollment, encrypted at rest,
-- independent of Cognito login MFA (EMAIL_OTP / WEB_AUTHN).
-- financial_stepup_log remains the authorization record.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.financial_totp_enrollments (
  application_user_id uuid PRIMARY KEY,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  key_id text NOT NULL,
  algorithm text NOT NULL DEFAULT 'SHA1',
  digits integer NOT NULL DEFAULT 6 CHECK (digits = 6),
  period_seconds integer NOT NULL DEFAULT 30 CHECK (period_seconds = 30),
  last_used_timestep bigint,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz
);

COMMENT ON TABLE public.financial_totp_enrollments IS
  'Encrypted financial TOTP secrets. Not Cognito login MFA. Never expose ciphertext via the generic data API.';

ALTER TABLE public.financial_totp_enrollments OWNER TO checksops_admin;
ALTER TABLE public.financial_totp_enrollments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.financial_totp_enrollments FROM PUBLIC;
REVOKE ALL ON TABLE public.financial_totp_enrollments FROM checksops;
REVOKE ALL ON TABLE public.financial_totp_enrollments FROM authenticated;

CREATE TABLE IF NOT EXISTS public.financial_totp_rate_limits (
  user_id uuid NOT NULL,
  action text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (user_id, action)
);

COMMENT ON TABLE public.financial_totp_rate_limits IS
  'Atomic counters for financial TOTP enroll/verify. Not on the generic data API.';

ALTER TABLE public.financial_totp_rate_limits OWNER TO checksops_admin;
ALTER TABLE public.financial_totp_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.financial_totp_rate_limits FROM PUBLIC;
REVOKE ALL ON TABLE public.financial_totp_rate_limits FROM checksops;
REVOKE ALL ON TABLE public.financial_totp_rate_limits FROM authenticated;

CREATE OR REPLACE FUNCTION public.consume_financial_totp_rate_limit(
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
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_rate_limit_identity'
      USING ERRCODE = '22023';
  END IF;

  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'rate_limit_caller_mismatch'
      USING ERRCODE = '42501';
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('enroll_start', 'enroll_confirm', 'step_up') THEN
    RAISE EXCEPTION 'invalid_rate_limit_action'
      USING ERRCODE = '22023';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid_rate_limit_bound'
      USING ERRCODE = '22023';
  END IF;

  IF p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid_rate_limit_window'
      USING ERRCODE = '22023';
  END IF;

  v_now := now();
  v_window := make_interval(secs => p_window_seconds);

  INSERT INTO public.financial_totp_rate_limits AS rl
    (user_id, action, window_started_at, request_count)
  VALUES
    (p_user_id, p_action, v_now, 1)
  ON CONFLICT (user_id, action)
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

COMMENT ON FUNCTION public.consume_financial_totp_rate_limit(uuid, text, integer, integer) IS
  'Atomic financial TOTP rate-limit consume. SECURITY DEFINER. Does not return secrets.';

ALTER FUNCTION public.consume_financial_totp_rate_limit(uuid, text, integer, integer)
  OWNER TO checksops_admin;

REVOKE ALL ON FUNCTION public.consume_financial_totp_rate_limit(uuid, text, integer, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_financial_totp_rate_limit(uuid, text, integer, integer)
  TO checksops;

CREATE OR REPLACE FUNCTION public.financial_totp_upsert_enrollment(
  p_user_id uuid,
  p_ciphertext bytea,
  p_nonce bytea,
  p_key_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_ciphertext IS NULL OR p_nonce IS NULL OR p_key_id IS NULL THEN
    RAISE EXCEPTION 'invalid_enrollment'
      USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'enrollment_caller_mismatch'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.financial_totp_enrollments (
    application_user_id, ciphertext, nonce, key_id, enrolled_at, verified_at,
    last_used_timestep, failed_attempts, locked_until
  ) VALUES (
    p_user_id, p_ciphertext, p_nonce, p_key_id, now(), NULL, NULL, 0, NULL
  )
  ON CONFLICT (application_user_id) DO UPDATE SET
    ciphertext = EXCLUDED.ciphertext,
    nonce = EXCLUDED.nonce,
    key_id = EXCLUDED.key_id,
    enrolled_at = now(),
    verified_at = NULL,
    last_used_timestep = NULL,
    failed_attempts = 0,
    locked_until = NULL;
END;
$$;

ALTER FUNCTION public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text)
  OWNER TO checksops_admin;
REVOKE ALL ON FUNCTION public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text) TO checksops;

CREATE OR REPLACE FUNCTION public.financial_totp_get_enrollment(p_user_id uuid)
RETURNS TABLE(
  ciphertext bytea,
  nonce bytea,
  key_id text,
  last_used_timestep bigint,
  verified_at timestamptz,
  failed_attempts integer,
  locked_until timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'enrollment_caller_mismatch'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT e.ciphertext, e.nonce, e.key_id, e.last_used_timestep, e.verified_at,
           e.failed_attempts, e.locked_until
    FROM public.financial_totp_enrollments e
    WHERE e.application_user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.financial_totp_get_enrollment(uuid) OWNER TO checksops_admin;
REVOKE ALL ON FUNCTION public.financial_totp_get_enrollment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_totp_get_enrollment(uuid) TO checksops;

CREATE OR REPLACE FUNCTION public.financial_totp_mark_verified(
  p_user_id uuid,
  p_timestep bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'enrollment_caller_mismatch'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.financial_totp_enrollments
     SET verified_at = COALESCE(verified_at, now()),
         last_used_timestep = p_timestep,
         failed_attempts = 0,
         locked_until = NULL
   WHERE application_user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.financial_totp_mark_verified(uuid, bigint) OWNER TO checksops_admin;
REVOKE ALL ON FUNCTION public.financial_totp_mark_verified(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_totp_mark_verified(uuid, bigint) TO checksops;

COMMIT;
