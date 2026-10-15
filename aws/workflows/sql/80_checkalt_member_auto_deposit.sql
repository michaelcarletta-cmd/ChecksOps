-- Let operators of a tenant, not only its admins, change that tenant's
-- Check Alt auto-approve settings. Viewers stay refused: the setting controls
-- automatic approval of deposits.
--
-- Replaces public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) from
-- aws/rls/sql/38_checkalt_auto_deposit_persist.sql. The only behavior changes:
--   * the caller must be the platform owner or a tenant_users member of
--     _tenant_id with role owner, admin, manager or operator (SQL 38 required
--     admin/owner); viewers and unknown roles are refused;
--   * auto_approve_enabled must be a JSON boolean, and auto_approve_max_cents
--     must be JSON null or a non-negative integer that fits the column.
-- Everything else is unchanged: SECURITY DEFINER, only auto_approve_enabled and
-- auto_approve_max_cents (plus updated_at) are written, any other key is
-- refused, other tenants' rows are refused, and there is still no table
-- UPDATE grant on checkalt_tenant_accounts. A missing row raises not_found,
-- so a save never reports success after changing nothing.
--
-- Writer: aws/functions/api/workflow-rpc.mjs (save_checkalt_tenant_auto_deposit).

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
  IF _settings IS NULL OR jsonb_typeof(_settings) <> 'object' OR _settings = '{}'::jsonb THEN
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
        AND lower(tu.role::text) IN ('owner', 'admin', 'manager', 'operator')
    )
  ) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF _settings ? 'auto_approve_max_cents'
     AND jsonb_typeof(_settings->'auto_approve_max_cents') <> 'null'
  THEN
    IF jsonb_typeof(_settings->'auto_approve_max_cents') <> 'number' THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023';
    END IF;
    _max := (_settings->>'auto_approve_max_cents')::numeric;
    IF _max < 0 OR _max <> trunc(_max) OR _max > 2147483647 THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF _settings ? 'auto_approve_enabled' THEN
    IF jsonb_typeof(_settings->'auto_approve_enabled') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023';
    END IF;
    _enabled := (_settings->>'auto_approve_enabled')::boolean;
  END IF;

  UPDATE public.checkalt_tenant_accounts
  SET
    auto_approve_enabled = CASE
      WHEN _settings ? 'auto_approve_enabled' THEN _enabled
      ELSE auto_approve_enabled
    END,
    auto_approve_max_cents = CASE
      WHEN _settings ? 'auto_approve_max_cents' THEN
        CASE
          WHEN jsonb_typeof(_settings->'auto_approve_max_cents') = 'null' THEN NULL
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
  'Tenant owner/admin/manager/operator or platform-owner Auto-Deposit persist (SQL 80); viewers refused. Updates only auto_approve_enabled and auto_approve_max_cents on the caller''s own tenant row. Does not grant generic table UPDATE.';

REVOKE ALL ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) TO checksops, authenticated;
