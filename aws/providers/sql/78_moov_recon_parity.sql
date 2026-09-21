-- M7.9I: reconciliation parity for provider-confirmed completed transfers
-- and environment-scoped wallet cache.
-- Does not POST to Moov. Does not INSERT payment_transfers.
-- Does not DELETE payment_event_log. Does not mention or update Freedom.

-- Lookup now returns current failure_reason so JS can detect stale failure
-- on an already-completed row.
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
  leg_role text,
  failure_reason text
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
         t.provider_status, t.provider_transfer_id, t.leg_role, t.failure_reason
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

-- Completed terminal success fills completed_at from provider completedOn
-- and clears the current failure_reason column. Historical 403/audit rows
-- in payment_event_log are not deleted. A prior failure_reason is copied
-- into provider_metadata.cleared_failure_reason before the column is nulled.
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
  tenant_id uuid,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  found public.payment_transfers%ROWTYPE;
  cleared_reason text;
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

  IF p_status = 'completed' AND found.failure_reason IS NOT NULL THEN
    cleared_reason := found.failure_reason;
  END IF;

  UPDATE public.payment_transfers t
     SET status = p_status,
         provider_status = p_provider_status,
         completed_at = CASE
           WHEN p_status = 'completed' THEN COALESCE(p_completed_at, t.completed_at)
           ELSE t.completed_at
         END,
         failure_reason = CASE
           WHEN p_status = 'completed' THEN NULL
           ELSE t.failure_reason
         END,
         provider_metadata = COALESCE(t.provider_metadata, '{}'::jsonb)
           || COALESCE(p_metadata, '{}'::jsonb)
           || CASE
                WHEN cleared_reason IS NOT NULL THEN jsonb_build_object(
                  'cleared_failure_reason', cleared_reason,
                  'cleared_failure_event', COALESCE(p_event_type, 'moov.reconcile')
                )
                ELSE '{}'::jsonb
              END
   WHERE t.id = found.id
     AND t.provider = 'moov'
     AND t.environment = p_environment
  RETURNING t.id, t.status, t.provider_status, t.completed_at, t.tenant_id, t.failure_reason
  INTO id, status, provider_status, completed_at, tenant_id, failure_reason;

  INSERT INTO public.payment_event_log
    (provider, environment, tenant_id, transfer_id, provider_transfer_id,
     event_type, previous_status, new_status, provider_metadata)
  VALUES (
    'moov', found.environment, found.tenant_id, found.id, p_provider_transfer_id,
    COALESCE(p_event_type, 'moov.reconcile'), p_previous_status, p_status,
    COALESCE(p_metadata, '{}'::jsonb)
      || CASE
           WHEN cleared_reason IS NOT NULL THEN jsonb_build_object(
             'cleared_failure_reason', cleared_reason
           )
           ELSE '{}'::jsonb
         END
  );

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.aws_moov_reconcile_existing_transfer(text, text, text, timestamptz, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_moov_reconcile_existing_transfer(text, text, text, timestamptz, text, text, jsonb, text) TO checksops;

-- Environment-scoped wallet cache. Moov live balance is authoritative.
-- Never inserts wallets. Never writes across sandbox/production.
DROP FUNCTION IF EXISTS public.aws_moov_reconcile_wallet_cache(text, text, bigint, bigint, uuid, jsonb);

CREATE FUNCTION public.aws_moov_reconcile_wallet_cache(
  p_provider_wallet_id text,
  p_environment text,
  p_available_cents bigint,
  p_pending_cents bigint,
  p_tenant_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  environment text,
  provider_wallet_id text,
  available_cents bigint,
  pending_cents bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  found public.payment_wallets%ROWTYPE;
  other_env text;
BEGIN
  IF current_setting('request.provider_webhook', true) IS DISTINCT FROM '1'
     AND current_setting('request.moov_get_reconcile', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'moov_wallet_reconcile_denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_environment IS NULL OR p_environment NOT IN ('sandbox', 'production') THEN
    RAISE EXCEPTION 'moov_environment_required';
  END IF;

  IF p_provider_wallet_id IS NULL OR btrim(p_provider_wallet_id) = '' THEN
    RAISE EXCEPTION 'moov_wallet_id_required';
  END IF;

  SELECT * INTO found
    FROM public.payment_wallets w
   WHERE w.provider = 'moov'
     AND w.provider_wallet_id = p_provider_wallet_id
     AND w.environment = p_environment
   ORDER BY w.updated_at DESC NULLS LAST
   LIMIT 1;

  IF found.id IS NULL THEN
    SELECT w.environment INTO other_env
      FROM public.payment_wallets w
     WHERE w.provider = 'moov'
       AND w.provider_wallet_id = p_provider_wallet_id
       AND w.environment IS DISTINCT FROM p_environment
     LIMIT 1;
    IF other_env IS NOT NULL THEN
      RAISE EXCEPTION 'moov_environment_mismatch';
    END IF;
    RETURN;
  END IF;

  IF p_tenant_id IS NOT NULL AND found.tenant_id IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'moov_tenant_mismatch';
  END IF;

  UPDATE public.payment_wallets w
     SET available_cents = COALESCE(p_available_cents, w.available_cents),
         pending_cents = COALESCE(p_pending_cents, w.pending_cents),
         last_synced_at = now(),
         provider_metadata = COALESCE(w.provider_metadata, '{}'::jsonb)
           || COALESCE(p_metadata, '{}'::jsonb)
   WHERE w.id = found.id
     AND w.provider = 'moov'
     AND w.environment = p_environment
     AND w.provider_wallet_id = p_provider_wallet_id
  RETURNING w.id, w.tenant_id, w.environment, w.provider_wallet_id,
            w.available_cents, w.pending_cents
  INTO id, tenant_id, environment, provider_wallet_id, available_cents, pending_cents;

  INSERT INTO public.payment_event_log
    (provider, environment, tenant_id, event_type, previous_status, new_status, provider_metadata)
  VALUES (
    'moov',
    found.environment,
    found.tenant_id,
    'moov.wallet_cache_reconcile',
    NULL,
    'synced',
    jsonb_build_object(
      'provider_wallet_id', p_provider_wallet_id,
      'available_cents', COALESCE(p_available_cents, found.available_cents),
      'pending_cents', COALESCE(p_pending_cents, found.pending_cents)
    ) || COALESCE(p_metadata, '{}'::jsonb)
  );

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.aws_moov_reconcile_wallet_cache(text, text, bigint, bigint, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_moov_reconcile_wallet_cache(text, text, bigint, bigint, uuid, jsonb) TO checksops;
