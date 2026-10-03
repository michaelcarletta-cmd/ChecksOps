-- DO NOT APPLY THIS FILE until a human authorizes the status-read DB isolation apply.
-- Does not modify SQL 65.
-- Does not loosen aws_financial_insert_checkalt_deposits or
-- aws_financial_update_checkalt_deposits.
-- Does not GRANT table UPDATE/INSERT on checkalt_deposits or checkalt_config.
--
-- Status reconciliation only:
--   request.checkalt_status_read = '1'
--   request.financial_execution remains 0
--
-- Live CheckAlt username/password/FI key/base URL stay in Secrets Manager.

-- ---------------------------------------------------------------------------
-- Config: merchant + default_enabled + optional host-validation URL.
-- Never returns fi_key, secrets, depositor account, or registration payloads.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_checkalt_status_read_config()
RETURNS TABLE (
  merchant text,
  default_enabled boolean,
  base_url text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF current_setting('request.checkalt_status_read', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'checkalt status-read config requires request.checkalt_status_read=1'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT c.merchant,
           c.default_enabled,
           c.base_url
    FROM public.checkalt_config c
    WHERE c.singleton IS TRUE
    LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.aws_checkalt_status_read_config() IS
  'Status-read only. Returns merchant, default_enabled, and base_url for host validation when request.checkalt_status_read=1. Never returns fi_key, webhook_secret, cached_jwt, passwords, or depositor account.';

REVOKE ALL ON FUNCTION public.aws_checkalt_status_read_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_checkalt_status_read_config() TO checksops;

-- ---------------------------------------------------------------------------
-- Persist: update an existing checkalt_deposits row with reconciliation fields.
-- Never INSERT. Never change amount, tenant, or checkalt_reference.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_checkalt_status_read_persist(
  _deposit_id uuid,
  _status text,
  _audit jsonb DEFAULT '{}'::jsonb,
  _deposit_date timestamptz DEFAULT NULL,
  _evidence jsonb DEFAULT NULL
)
RETURNS public.checkalt_deposits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _row public.checkalt_deposits%ROWTYPE;
  _next text;
  _src jsonb;
  _code text;
  _label text;
  _has_deposit_date boolean;
  _uid uuid;
BEGIN
  IF current_setting('request.checkalt_status_read', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'checkalt status-read persist requires request.checkalt_status_read=1'
      USING ERRCODE = '42501';
  END IF;
  IF _deposit_id IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO _row
  FROM public.checkalt_deposits
  WHERE id = _deposit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deposit_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF _row.checkalt_reference IS NULL OR btrim(_row.checkalt_reference) = '' THEN
    RAISE EXCEPTION 'status_read_persist_requires_reference' USING ERRCODE = '22023';
  END IF;

  BEGIN
    _uid := NULLIF(current_setting('request.app_user_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    _uid := NULL;
  END;
  IF _uid IS NOT NULL AND NOT COALESCE(public.aws_can_access_tenant(_row.tenant_id), false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  _next := NULLIF(btrim(COALESCE(_status, '')), '');
  IF _next IS NULL THEN
    _next := _row.status;
  END IF;
  IF _next NOT IN ('pending_approval', 'submitted', 'rejected', 'returned', 'cleared', 'duplicate') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;

  _src := COALESCE(_evidence, _audit, '{}'::jsonb);
  _code := COALESCE(
    NULLIF(_src->>'statusCode', ''),
    NULLIF(_src->>'status_code', ''),
    CASE WHEN COALESCE(_src->>'status', '') ~ '^[0-9]+$' THEN _src->>'status' ELSE NULL END
  );
  _label := lower(COALESCE(
    NULLIF(_src->>'statusDescription', ''),
    NULLIF(_src->>'status', ''),
    ''
  ));
  _has_deposit_date :=
    NULLIF(_src->>'depositDate', '') IS NOT NULL
    OR NULLIF(_src->>'DepositDate', '') IS NOT NULL
    OR NULLIF(_src->'history'->>'depositDate', '') IS NOT NULL
    OR NULLIF(_src->'history'->>'DepositDate', '') IS NOT NULL
    OR NULLIF(_src->'item'->>'depositDate', '') IS NOT NULL
    OR NULLIF(_src->'last_poll'->>'depositDate', '') IS NOT NULL;

  IF _code = '40' OR _label IN ('pending') THEN
    IF _next = 'cleared' THEN _next := 'pending_approval'; END IF;
  ELSIF _code = '127' OR _label IN ('approved') THEN
    IF _next = 'cleared' THEN _next := 'submitted'; END IF;
  ELSIF _code = '120' OR _label IN ('rejected', 'declined') THEN
    IF _next = 'cleared' THEN _next := 'rejected'; END IF;
  END IF;

  IF _next = 'cleared' AND (_deposit_date IS NULL OR NOT _has_deposit_date) THEN
    _next := 'submitted';
    _deposit_date := NULL;
  END IF;
  IF _next <> 'cleared' THEN
    _deposit_date := NULL;
  END IF;

  UPDATE public.checkalt_deposits
  SET status = _next,
      last_polled_at = now(),
      last_status_payload = COALESCE(last_status_payload, '{}'::jsonb) || COALESCE(_audit, '{}'::jsonb),
      cleared_at = CASE
        WHEN _next = 'cleared' AND _deposit_date IS NOT NULL THEN COALESCE(cleared_at, _deposit_date)
        ELSE cleared_at
      END,
      returned_at = CASE
        WHEN _next = 'returned' THEN COALESCE(returned_at, now())
        ELSE returned_at
      END,
      updated_at = now()
  WHERE id = _deposit_id
  RETURNING * INTO _row;

  RETURN _row;
END;
$$;

COMMENT ON FUNCTION public.aws_checkalt_status_read_persist(uuid, text, jsonb, timestamptz, jsonb) IS
  'Status-read persist for an existing checkalt_deposits row. Requires request.checkalt_status_read=1. Never INSERT. Never changes amount, tenant_id, or checkalt_reference. Clears only when settlement evidence includes a provider depositDate.';

REVOKE ALL ON FUNCTION public.aws_checkalt_status_read_persist(uuid, text, jsonb, timestamptz, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_checkalt_status_read_persist(uuid, text, jsonb, timestamptz, jsonb) TO checksops;

SELECT 'NOT_APPLIED'::text AS aws_checkalt_status_read_db_isolation;
