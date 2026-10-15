-- Production Check Alt depositor registration writer.
--
-- Adds public.aws_register_checkalt_tenant_account(uuid, jsonb), the only
-- writer of a tenant's production checkalt_tenant_accounts identity
-- (sso_user_id, deposit_account_number, first/last name, email). It is called
-- by aws/functions/api/providers/production/checkalt-register.mjs only after
-- Check Alt's live POST /fincapture/useraccount/register succeeded.
--
--   * the caller must be the platform owner (public.is_platform_owner());
--     tenant owners/admins/operators, platform admins and staff are refused;
--   * only the keys sso_user_id, first_name, last_name, email,
--     deposit_account_number and last_register_payload are accepted;
--   * deposit_account_number must be 5 to 17 digits (no spaces, dashes or
--     letters; at least five so the last-four mask never shows the whole
--     number). There is no routing number: Check Alt binds the bank through
--     the platform FI key;
--   * last_register_payload must be a JSON object (or null) that does not
--     contain the full account number. The Lambda masks it before the call;
--   * the tenant must exist;
--   * registered_at is set to now() and enabled to true, matching the
--     Lovable checkalt-register-account writer. auto_approve_enabled and
--     auto_approve_max_cents are never touched (SQL 80 owns them).
--
-- There is still no table INSERT/UPDATE grant on checkalt_tenant_accounts.
-- The return value carries the account number masked (last four only).
--
-- No new column and no backfill. Existing rows keep working unchanged.

CREATE OR REPLACE FUNCTION public.aws_register_checkalt_tenant_account(
  _tenant_id uuid,
  _account jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _key text;
  _sso text;
  _first text;
  _last text;
  _email text;
  _acct text;
  _payload jsonb;
  _row public.checkalt_tenant_accounts%ROWTYPE;
BEGIN
  IF _tenant_id IS NULL OR _account IS NULL OR jsonb_typeof(_account) <> 'object' THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;

  IF NOT public.is_platform_owner() THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  FOR _key IN SELECT jsonb_object_keys(_account)
  LOOP
    IF _key NOT IN ('sso_user_id', 'first_name', 'last_name', 'email',
                    'deposit_account_number', 'last_register_payload') THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = _key;
    END IF;
  END LOOP;

  FOREACH _key IN ARRAY ARRAY['sso_user_id', 'first_name', 'last_name', 'email', 'deposit_account_number']
  LOOP
    IF jsonb_typeof(_account->_key) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = _key;
    END IF;
  END LOOP;

  _sso := btrim(_account->>'sso_user_id');
  _first := btrim(_account->>'first_name');
  _last := btrim(_account->>'last_name');
  _email := btrim(_account->>'email');
  _acct := _account->>'deposit_account_number';

  IF _sso !~ '^[!-~]{1,64}$' THEN
    RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = 'sso_user_id';
  END IF;
  IF length(_first) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = 'first_name';
  END IF;
  IF length(_last) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = 'last_name';
  END IF;
  IF length(_email) > 254 OR _email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = 'email';
  END IF;
  IF _acct !~ '^[0-9]{5,17}$' THEN
    RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = 'deposit_account_number';
  END IF;

  _payload := _account->'last_register_payload';
  IF _payload IS NOT NULL AND jsonb_typeof(_payload) = 'null' THEN
    _payload := NULL;
  END IF;
  IF _payload IS NOT NULL THEN
    IF jsonb_typeof(_payload) <> 'object' THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = 'last_register_payload';
    END IF;
    IF position(_acct IN _payload::text) > 0 THEN
      RAISE EXCEPTION 'unmasked_account_number' USING ERRCODE = '22023', DETAIL = 'last_register_payload';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = _tenant_id) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.checkalt_tenant_accounts AS a
    (tenant_id, sso_user_id, deposit_account_number, first_name, last_name, email,
     enabled, registered_at, last_register_payload)
  VALUES
    (_tenant_id, _sso, _acct, _first, _last, _email, true, now(), _payload)
  ON CONFLICT (tenant_id) DO UPDATE SET
    sso_user_id = EXCLUDED.sso_user_id,
    deposit_account_number = EXCLUDED.deposit_account_number,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name,
    email = EXCLUDED.email,
    enabled = true,
    registered_at = EXCLUDED.registered_at,
    last_register_payload = EXCLUDED.last_register_payload,
    updated_at = now()
  RETURNING * INTO _row;

  RETURN jsonb_build_object(
    'tenant_id', _row.tenant_id,
    'sso_user_id', _row.sso_user_id,
    'first_name', _row.first_name,
    'last_name', _row.last_name,
    'email', _row.email,
    'enabled', _row.enabled,
    'registered_at', _row.registered_at,
    'account_last4', right(_row.deposit_account_number, 4)
  );
END;
$$;

COMMENT ON FUNCTION public.aws_register_checkalt_tenant_account(uuid, jsonb) IS
  'Platform-owner-only production Check Alt depositor registration writer (SQL 81). Called after a successful live /fincapture/useraccount/register. Writes sso_user_id, deposit_account_number (5-17 digits), names, email, enabled, registered_at and a masked last_register_payload; never auto_approve_*. Returns the account number as last four only. Does not grant generic table INSERT/UPDATE.';

REVOKE ALL ON FUNCTION public.aws_register_checkalt_tenant_account(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_register_checkalt_tenant_account(uuid, jsonb) TO checksops, authenticated;
