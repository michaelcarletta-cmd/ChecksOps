-- Narrow Auto-Deposit persist for Manager settings.
-- SECURITY DEFINER owns the two-column update so checksops does not need
-- table UPDATE on checkalt_tenant_accounts.
-- Generic /data/write stays blocked. Registration, provider, and money-path
-- columns stay unmodifiable through this function.
-- Do not apply until authorized. Not SQL 36. Not SQL 37.

CREATE OR REPLACE FUNCTION public.aws_save_checkalt_tenant_auto_deposit(
  _tenant_id uuid,
  _settings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _key text;
  _max numeric;
  _enabled boolean;
  _row public.checkalt_tenant_accounts%ROWTYPE;
BEGIN
  IF _tenant_id IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  IF _settings IS NULL OR _settings = '{}'::jsonb THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;

  FOR _key IN SELECT jsonb_object_keys(_settings)
  LOOP
    IF _key NOT IN ('auto_approve_enabled', 'auto_approve_max_cents') THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF NOT (
    public.is_platform_owner()
    OR EXISTS (
      SELECT 1
      FROM public.tenant_users tu
      WHERE tu.user_id = auth.uid()
        AND tu.tenant_id = _tenant_id
        AND lower(tu.role::text) IN ('admin', 'owner')
    )
  ) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF _settings ? 'auto_approve_max_cents'
     AND jsonb_typeof(_settings->'auto_approve_max_cents') IS NOT NULL
     AND jsonb_typeof(_settings->'auto_approve_max_cents') <> 'null'
  THEN
    _max := (_settings->>'auto_approve_max_cents')::numeric;
    IF _max IS NULL OR _max < 0 OR _max <> trunc(_max) THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF _settings ? 'auto_approve_enabled'
     AND jsonb_typeof(_settings->'auto_approve_enabled') IS NOT NULL
     AND jsonb_typeof(_settings->'auto_approve_enabled') <> 'null'
  THEN
    _enabled := (_settings->>'auto_approve_enabled')::boolean;
  END IF;

  UPDATE public.checkalt_tenant_accounts
  SET
    auto_approve_enabled = CASE
      WHEN _settings ? 'auto_approve_enabled' THEN COALESCE(_enabled, false)
      ELSE auto_approve_enabled
    END,
    auto_approve_max_cents = CASE
      WHEN _settings ? 'auto_approve_max_cents' THEN
        CASE
          WHEN jsonb_typeof(_settings->'auto_approve_max_cents') IS NULL
            OR jsonb_typeof(_settings->'auto_approve_max_cents') = 'null'
          THEN NULL
          ELSE _max::integer
        END
      ELSE auto_approve_max_cents
    END,
    updated_at = now()
  WHERE tenant_id = _tenant_id
  RETURNING * INTO _row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'tenant_id', _row.tenant_id,
    'auto_approve_enabled', _row.auto_approve_enabled,
    'auto_approve_max_cents', _row.auto_approve_max_cents
  );
END;
$$;

COMMENT ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) IS
  'Tenant-admin/platform-owner Auto-Deposit persist. Updates only auto_approve_enabled and auto_approve_max_cents. Does not grant generic table UPDATE.';

REVOKE ALL ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) TO checksops, authenticated;
