-- SQL 129: the financial TOTP rate limit accepts the shared 'code_check' action.
--
-- Why: since the finding 7 deploy (production overlay run 40992441506, 2026-10-30) the API
-- rate-limits every authenticator-code check under one action, 'code_check'
-- (aws/functions/api/auth-financial-totp.mjs: enroll confirm and step-up;
-- providers/production/checkalt-register.mjs: the finding 13 deposit-account change). The
-- live public.consume_financial_totp_rate_limit(uuid, text, integer, integer) is the one in
-- aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql (read-only
-- production inspect 2026-10-30, SSM cfee4512-4988-4fd1-be77-b03d1b4cd50b, main da064a34:
-- pg_get_functiondef and prosrc equal to that file's), which allows only 'enroll_start',
-- 'enroll_confirm' and 'step_up' and raises invalid_rate_limit_action for anything else.
-- So every code check fails, and the API answers 401 financial_totp_failed: enrolling an
-- authenticator, every financial step-up, and the Check Alt deposit-account change.
--
-- 1) consume_financial_totp_rate_limit is replaced with the same signature, result, language,
--    SECURITY DEFINER and search_path, and the same body except one line: the action
--    allow-list also accepts 'code_check'. The three older actions stay accepted, so a
--    Lambda still on the previous build keeps working while the overlay and this file are
--    out of step. Limit and window bounds, the caller check (p_user_id = auth.uid()) and the
--    per-user, per-action counter are unchanged.
-- 2) No grant change. CREATE OR REPLACE keeps the function's owner and EXECUTE ACL as they
--    are (production: PUBLIC, checksops and the owner). Revoking PUBLIC EXECUTE from the
--    financial_totp functions is a separate finding and a separate migration.
--
-- Not changed: no table, column, policy, trigger, grant or other function.

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

  IF p_action IS NULL OR p_action NOT IN ('enroll_start', 'enroll_confirm', 'step_up', 'code_check') THEN
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
