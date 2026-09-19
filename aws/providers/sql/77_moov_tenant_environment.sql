-- M7.8: tenant-level Moov sandbox/production environment.
-- Reuses tenants.moov_environment. Does not bulk-update existing tenants.
-- Does not migrate provider objects between environments.

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_moov_environment_chk;

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_moov_environment_chk
  CHECK (moov_environment IN ('sandbox', 'production'))
  NOT VALID;

COMMENT ON COLUMN public.tenants.moov_environment IS
  'Tenant-level Moov ledger. sandbox or production. Switching does not migrate provider objects.';

-- Widen provider-account lookup to return environment. Same provider_account_id
-- in both environments must not collapse to a single row.
DROP FUNCTION IF EXISTS public.aws_lookup_provider_account(text, text);
DROP FUNCTION IF EXISTS public.aws_lookup_provider_account(text, text, text);

CREATE FUNCTION public.aws_lookup_provider_account(
  p_provider text,
  p_provider_account_id text,
  p_environment text DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  provider text,
  provider_account_id text,
  environment text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.tenant_id, a.provider, a.provider_account_id, a.environment
  FROM public.payment_provider_accounts a
  WHERE a.provider = p_provider
    AND a.provider_account_id = p_provider_account_id
    AND (p_environment IS NULL OR a.environment = p_environment)
    AND (
      p_environment IS NOT NULL
      OR NOT EXISTS (
        SELECT 1
        FROM public.payment_provider_accounts dup
        WHERE dup.provider = a.provider
          AND dup.provider_account_id = a.provider_account_id
          AND dup.id IS DISTINCT FROM a.id
      )
    )
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.aws_lookup_provider_account(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_lookup_provider_account(text, text, text) TO checksops;

-- Transfer lookup is environment-scoped. No production-first fallback.
DROP FUNCTION IF EXISTS public.aws_moov_lookup_transfer(text);
DROP FUNCTION IF EXISTS public.aws_moov_lookup_transfer(text, text);

CREATE FUNCTION public.aws_moov_lookup_transfer(
  p_provider_transfer_id text,
  p_environment text DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  status text,
  environment text,
  amount_cents bigint,
  completed_at timestamptz,
  provider_status text,
  provider_transfer_id text,
  leg_role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('sandbox', 'production') THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT t.id, t.tenant_id, t.status, t.environment, t.amount_cents, t.completed_at,
         t.provider_status, t.provider_transfer_id, t.leg_role
    FROM public.payment_transfers t
   WHERE t.provider = 'moov'
     AND t.provider_transfer_id = p_provider_transfer_id
     AND t.environment = p_environment
   ORDER BY t.created_at DESC
   LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.aws_moov_lookup_transfer(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_moov_lookup_transfer(text, text) TO checksops;

-- Reconcile only the requested environment. No cross-environment write.
DROP FUNCTION IF EXISTS public.aws_moov_reconcile_existing_transfer(text, text, text, timestamptz, text, text, jsonb);
DROP FUNCTION IF EXISTS public.aws_moov_reconcile_existing_transfer(text, text, text, timestamptz, text, text, jsonb, text);

CREATE FUNCTION public.aws_moov_reconcile_existing_transfer(
  p_provider_transfer_id text,
  p_status text,
  p_provider_status text,
  p_completed_at timestamptz,
  p_event_type text,
  p_previous_status text,
  p_metadata jsonb,
  p_environment text DEFAULT 'production'
) RETURNS TABLE (
  id uuid,
  status text,
  provider_status text,
  completed_at timestamptz,
  tenant_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  found public.payment_transfers%ROWTYPE;
BEGIN
  IF current_setting('request.provider_webhook', true) IS DISTINCT FROM '1'
     AND current_setting('request.moov_get_reconcile', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'moov_reconcile_denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_environment IS NULL OR p_environment NOT IN ('sandbox', 'production') THEN
    RAISE EXCEPTION 'moov_environment_required';
  END IF;

  SELECT * INTO found
    FROM public.payment_transfers t
   WHERE t.provider = 'moov'
     AND t.provider_transfer_id = p_provider_transfer_id
     AND t.environment = p_environment
   ORDER BY t.created_at DESC
   LIMIT 1;

  IF found.id IS NULL THEN
    RAISE EXCEPTION 'moov_transfer_not_found';
  END IF;

  IF found.environment IS DISTINCT FROM p_environment THEN
    RAISE EXCEPTION 'moov_environment_mismatch';
  END IF;

  IF found.status IN ('failed', 'canceled', 'cancelled', 'returned')
     AND p_status IS DISTINCT FROM found.status THEN
    RAISE EXCEPTION 'moov_terminal_regression';
  END IF;

  IF found.status = 'completed'
     AND p_status IS DISTINCT FROM 'completed'
     AND p_status IS DISTINCT FROM 'returned' THEN
    RAISE EXCEPTION 'moov_terminal_regression';
  END IF;

  UPDATE public.payment_transfers t
     SET status = p_status,
         provider_status = p_provider_status,
         completed_at = CASE
           WHEN p_status = 'completed' THEN COALESCE(p_completed_at, t.completed_at)
           ELSE t.completed_at
         END,
         provider_metadata = COALESCE(t.provider_metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb)
   WHERE t.id = found.id
     AND t.provider = 'moov'
     AND t.environment = p_environment
  RETURNING t.id, t.status, t.provider_status, t.completed_at, t.tenant_id
  INTO id, status, provider_status, completed_at, tenant_id;

  INSERT INTO public.payment_event_log
    (provider, environment, tenant_id, transfer_id, provider_transfer_id,
     event_type, previous_status, new_status, provider_metadata)
  VALUES (
    'moov', found.environment, found.tenant_id, found.id, p_provider_transfer_id,
    COALESCE(p_event_type, 'moov.reconcile'), p_previous_status, p_status,
    COALESCE(p_metadata, '{}'::jsonb)
  );

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.aws_moov_reconcile_existing_transfer(text, text, text, timestamptz, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_moov_reconcile_existing_transfer(text, text, text, timestamptz, text, text, jsonb, text) TO checksops;

-- Activity uniqueness includes environment so sandbox/production IDs cannot collide.
ALTER TABLE public.payment_provider_activity
  DROP CONSTRAINT IF EXISTS payment_provider_activity_provider_provider_transfer_id_key;
ALTER TABLE public.payment_provider_activity
  DROP CONSTRAINT IF EXISTS payment_provider_activity_provider_transfer_id_key;

DROP INDEX IF EXISTS payment_provider_activity_provider_env_transfer_uniq;
CREATE UNIQUE INDEX payment_provider_activity_provider_env_transfer_uniq
  ON public.payment_provider_activity (provider, environment, provider_transfer_id);

DROP FUNCTION IF EXISTS public.aws_moov_observe_provider_activity(uuid, text, text, text, text, bigint, text, text, timestamptz, timestamptz, jsonb);
DROP FUNCTION IF EXISTS public.aws_moov_observe_provider_activity(uuid, text, text, text, text, bigint, text, text, timestamptz, timestamptz, jsonb, text);

CREATE FUNCTION public.aws_moov_observe_provider_activity(
  p_tenant_id uuid,
  p_provider_transfer_id text,
  p_origin text,
  p_activity_kind text,
  p_status text,
  p_amount_cents bigint,
  p_source_rail text,
  p_destination_rail text,
  p_created_at timestamptz,
  p_completed_at timestamptz,
  p_metadata jsonb,
  p_environment text DEFAULT 'production'
) RETURNS TABLE (
  observed_id uuid,
  observed_transfer_id text,
  observed_origin text,
  observed_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('request.provider_webhook', true) IS DISTINCT FROM '1'
     AND current_setting('request.moov_get_reconcile', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'moov_observe_denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_environment IS NULL OR p_environment NOT IN ('sandbox', 'production') THEN
    RAISE EXCEPTION 'moov_environment_required';
  END IF;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO public.payment_provider_activity (
      tenant_id, provider, environment, origin, activity_kind, provider_transfer_id,
      provider_sweep_id, status, amount_cents, source_rail, destination_rail,
      provider_created_at, provider_completed_at, provider_metadata
    ) VALUES (
      p_tenant_id, 'moov', p_environment, COALESCE(p_origin, 'provider_unknown'),
      COALESCE(p_activity_kind, 'transfer'), p_provider_transfer_id,
      p_metadata->>'sweepID', p_status, p_amount_cents, p_source_rail, p_destination_rail,
      p_created_at, p_completed_at, COALESCE(p_metadata, '{}'::jsonb)
    )
    ON CONFLICT (provider, environment, provider_transfer_id) DO UPDATE SET
      status = COALESCE(EXCLUDED.status, payment_provider_activity.status),
      amount_cents = COALESCE(EXCLUDED.amount_cents, payment_provider_activity.amount_cents),
      provider_sweep_id = COALESCE(EXCLUDED.provider_sweep_id, payment_provider_activity.provider_sweep_id),
      origin = CASE
        WHEN payment_provider_activity.origin = 'provider_unknown' THEN EXCLUDED.origin
        ELSE payment_provider_activity.origin
      END,
      provider_completed_at = COALESCE(EXCLUDED.provider_completed_at, payment_provider_activity.provider_completed_at),
      provider_metadata = payment_provider_activity.provider_metadata || EXCLUDED.provider_metadata,
      updated_at = now()
    RETURNING payment_provider_activity.id,
              payment_provider_activity.provider_transfer_id,
              payment_provider_activity.origin,
              payment_provider_activity.status
  )
  SELECT ins.id, ins.provider_transfer_id, ins.origin, ins.status FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.aws_moov_observe_provider_activity(uuid, text, text, text, text, bigint, text, text, timestamptz, timestamptz, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_moov_observe_provider_activity(uuid, text, text, text, text, bigint, text, text, timestamptz, timestamptz, jsonb, text) TO checksops;

-- Webhook events unique per environment so sandbox/production event IDs cannot collide.
ALTER TABLE public.payment_webhook_events
  DROP CONSTRAINT IF EXISTS payment_webhook_events_provider_external_event_id_key;

DROP INDEX IF EXISTS payment_webhook_events_provider_env_event_uniq;
CREATE UNIQUE INDEX payment_webhook_events_provider_env_event_uniq
  ON public.payment_webhook_events (provider, environment, external_event_id);

-- Optimistic tenant environment switch. Never migrates provider objects.
DROP FUNCTION IF EXISTS public.aws_moov_set_tenant_environment(uuid, text, text, uuid);

CREATE FUNCTION public.aws_moov_set_tenant_environment(
  p_tenant_id uuid,
  p_expected_current text,
  p_next text,
  p_actor_user_id uuid
) RETURNS TABLE (
  tenant_id uuid,
  before_environment text,
  after_environment text,
  objects_migrated boolean,
  changed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  found public.tenants%ROWTYPE;
BEGIN
  IF p_next IS NULL OR p_next NOT IN ('sandbox', 'production') THEN
    RAISE EXCEPTION 'moov_environment_invalid';
  END IF;
  IF p_expected_current IS NULL OR p_expected_current NOT IN ('sandbox', 'production') THEN
    RAISE EXCEPTION 'moov_environment_expected_invalid';
  END IF;

  SELECT * INTO found FROM public.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
  IF found.id IS NULL THEN
    RAISE EXCEPTION 'tenant_not_found';
  END IF;
  IF found.moov_environment IS DISTINCT FROM p_expected_current THEN
    RAISE EXCEPTION 'moov_environment_stale'
      USING ERRCODE = '40001';
  END IF;

  IF found.moov_environment = p_next THEN
    tenant_id := found.id;
    before_environment := found.moov_environment;
    after_environment := found.moov_environment;
    objects_migrated := false;
    changed_at := now();
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public.tenants t
     SET moov_environment = p_next
   WHERE t.id = p_tenant_id
     AND t.moov_environment = p_expected_current;

  INSERT INTO public.payment_event_log
    (provider, environment, tenant_id, event_type, previous_status, new_status, provider_metadata)
  VALUES (
    'moov',
    p_next,
    p_tenant_id,
    'moov_environment.changed',
    p_expected_current,
    p_next,
    jsonb_build_object(
      'actor_user_id', p_actor_user_id,
      'before', p_expected_current,
      'after', p_next,
      'objects_migrated', false,
      'timestamp', now()
    )
  );

  tenant_id := p_tenant_id;
  before_environment := p_expected_current;
  after_environment := p_next;
  objects_migrated := false;
  changed_at := now();
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.aws_moov_set_tenant_environment(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_moov_set_tenant_environment(uuid, text, text, uuid) TO checksops;
