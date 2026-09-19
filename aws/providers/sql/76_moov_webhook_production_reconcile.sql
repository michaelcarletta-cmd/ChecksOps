-- Production Moov webhook/GET reconciliation.
-- Reconciles EXISTING payment_transfers only. Never INSERT a money intent.
-- Gated by request.provider_webhook=1 (webhook) or tenant write (GET refresh).

CREATE TABLE IF NOT EXISTS public.payment_provider_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'production',
  origin text NOT NULL DEFAULT 'provider_unknown',
  activity_kind text NOT NULL DEFAULT 'transfer',
  provider_transfer_id text NOT NULL,
  provider_sweep_id text,
  payment_transfer_id uuid,
  status text,
  amount_cents bigint,
  source_rail text,
  destination_rail text,
  provider_created_at timestamptz,
  provider_completed_at timestamptz,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_transfer_id)
);

CREATE INDEX IF NOT EXISTS payment_provider_activity_tenant_observed_idx
  ON public.payment_provider_activity (tenant_id, observed_at DESC);

COMMENT ON TABLE public.payment_provider_activity IS
  'Provider-created activity (including Moov Sweep transfers). Observe/reconcile only. Not a ChecksOps money intent.';

ALTER TABLE public.payment_provider_activity ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.payment_provider_activity FROM PUBLIC;
GRANT SELECT ON TABLE public.payment_provider_activity TO authenticated, checksops;
GRANT INSERT, UPDATE ON TABLE public.payment_provider_activity TO checksops;

DROP POLICY IF EXISTS aws_select_payment_provider_activity ON public.payment_provider_activity;
CREATE POLICY aws_select_payment_provider_activity
  ON public.payment_provider_activity
  FOR SELECT TO authenticated, checksops
  USING (
    tenant_id IS NULL
    OR public.aws_is_cross_tenant_reader()
    OR public.aws_can_access_tenant(tenant_id)
    OR current_setting('request.provider_webhook', true) = '1'
    OR current_setting('request.moov_get_reconcile', true) = '1'
  );

CREATE OR REPLACE FUNCTION public.aws_moov_lookup_transfer(p_provider_transfer_id text)
RETURNS TABLE (
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
  RETURN QUERY
  SELECT t.id, t.tenant_id, t.status, t.environment, t.amount_cents, t.completed_at,
         t.provider_status, t.provider_transfer_id, t.leg_role
    FROM public.payment_transfers t
   WHERE t.provider = 'moov'
     AND t.provider_transfer_id = p_provider_transfer_id
   ORDER BY CASE WHEN t.environment = 'production' THEN 0 ELSE 1 END, t.created_at DESC
   LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.aws_moov_record_reconcile_event(
  p_tenant_id uuid,
  p_transfer_id uuid,
  p_provider_transfer_id text,
  p_event_type text,
  p_previous_status text,
  p_metadata jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.payment_event_log
    (provider, environment, tenant_id, transfer_id, provider_transfer_id,
     event_type, previous_status, new_status, provider_metadata)
  VALUES (
    'moov', 'production', p_tenant_id, p_transfer_id, p_provider_transfer_id,
    p_event_type, p_previous_status, p_previous_status, COALESCE(p_metadata, '{}'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.aws_moov_reconcile_existing_transfer(
  p_provider_transfer_id text,
  p_status text,
  p_provider_status text,
  p_completed_at timestamptz,
  p_event_type text,
  p_previous_status text,
  p_metadata jsonb
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

  SELECT * INTO found
    FROM public.payment_transfers t
   WHERE t.provider = 'moov'
     AND t.provider_transfer_id = p_provider_transfer_id
   ORDER BY CASE WHEN t.environment = 'production' THEN 0 ELSE 1 END, t.created_at DESC
   LIMIT 1;

  IF found.id IS NULL THEN
    RAISE EXCEPTION 'moov_transfer_not_found';
  END IF;

  IF found.environment IS DISTINCT FROM 'production' THEN
    RAISE EXCEPTION 'moov_production_row_required';
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

CREATE OR REPLACE FUNCTION public.aws_moov_observe_provider_activity(
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
  p_metadata jsonb
) RETURNS TABLE (
  id uuid,
  provider_transfer_id text,
  origin text,
  status text
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

  RETURN QUERY
  WITH ins AS (
    INSERT INTO public.payment_provider_activity (
      tenant_id, provider, environment, origin, activity_kind, provider_transfer_id,
      provider_sweep_id, status, amount_cents, source_rail, destination_rail,
      provider_created_at, provider_completed_at, provider_metadata
    ) VALUES (
      p_tenant_id, 'moov', 'production', COALESCE(p_origin, 'provider_unknown'),
      COALESCE(p_activity_kind, 'transfer'), p_provider_transfer_id,
      p_metadata->>'sweepID', p_status, p_amount_cents, p_source_rail, p_destination_rail,
      p_created_at, p_completed_at, COALESCE(p_metadata, '{}'::jsonb)
    )
    ON CONFLICT (provider, provider_transfer_id) DO UPDATE SET
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

REVOKE ALL ON FUNCTION public.aws_moov_lookup_transfer(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_moov_record_reconcile_event(uuid, uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_moov_reconcile_existing_transfer(text, text, text, timestamptz, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_moov_observe_provider_activity(uuid, text, text, text, text, bigint, text, text, timestamptz, timestamptz, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.aws_moov_lookup_transfer(text) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_moov_record_reconcile_event(uuid, uuid, text, text, text, jsonb) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_moov_reconcile_existing_transfer(text, text, text, timestamptz, text, text, jsonb) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_moov_observe_provider_activity(uuid, text, text, text, text, bigint, text, text, timestamptz, timestamptz, jsonb) TO checksops;
