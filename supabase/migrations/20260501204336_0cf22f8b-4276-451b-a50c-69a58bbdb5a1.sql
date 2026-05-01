-- ============================================================
-- Per-check billing system
-- ============================================================

-- 1) Global config (single-row pattern)
CREATE TABLE public.check_billing_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_per_check_cents integer NOT NULL DEFAULT 300,
  currency text NOT NULL DEFAULT 'usd',
  stripe_meter_event_name text NOT NULL DEFAULT 'checks_processed',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.check_billing_config (price_per_check_cents, currency, stripe_meter_event_name)
VALUES (300, 'usd', 'checks_processed');

ALTER TABLE public.check_billing_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can read billing config"
  ON public.check_billing_config FOR SELECT TO authenticated USING (true);

CREATE POLICY "Only admins can modify billing config"
  ON public.check_billing_config FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- 2) Billing events ledger
CREATE TABLE public.check_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  check_intake_item_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  billed_at timestamptz NOT NULL DEFAULT now(),
  unit_price_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','reported','invoiced','failed','voided')),
  stripe_meter_event_id text,
  stripe_customer_id text,
  reported_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_billing_events_unique_check UNIQUE (check_intake_item_id)
);

CREATE INDEX idx_check_billing_events_tenant_billed ON public.check_billing_events (tenant_id, billed_at DESC);
CREATE INDEX idx_check_billing_events_status ON public.check_billing_events (status) WHERE status IN ('recorded','failed');

ALTER TABLE public.check_billing_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view own billing events"
  ON public.check_billing_events FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'staff'::app_role)
    OR public.is_tenant_member(auth.uid(), tenant_id)
  );

CREATE POLICY "Only admins can update billing events"
  ON public.check_billing_events FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- No INSERT/DELETE policies → blocked by RLS for everyone except SECURITY DEFINER functions / service role.

-- 3) Trigger: record billing event when an intake item becomes 'deposited'
CREATE OR REPLACE FUNCTION public.record_check_billing_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_price integer;
  v_currency text;
BEGIN
  IF NEW.status = 'deposited'
     AND (OLD.status IS DISTINCT FROM 'deposited')
     AND NEW.tenant_id IS NOT NULL THEN

    SELECT price_per_check_cents, currency
      INTO v_price, v_currency
    FROM public.check_billing_config
    WHERE active = true
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_price IS NULL THEN
      v_price := 300;
      v_currency := 'usd';
    END IF;

    INSERT INTO public.check_billing_events (
      tenant_id, check_intake_item_id, unit_price_cents, currency, status
    ) VALUES (
      NEW.tenant_id, NEW.id, v_price, v_currency, 'recorded'
    )
    ON CONFLICT (check_intake_item_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_check_billing_event ON public.check_intake_items;
CREATE TRIGGER trg_record_check_billing_event
  AFTER UPDATE OF status ON public.check_intake_items
  FOR EACH ROW
  EXECUTE FUNCTION public.record_check_billing_event();

-- 4) Touch updated_at
CREATE TRIGGER trg_check_billing_events_updated_at
  BEFORE UPDATE ON public.check_billing_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_check_billing_config_updated_at
  BEFORE UPDATE ON public.check_billing_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5) Tenant usage RPC
CREATE OR REPLACE FUNCTION public.get_tenant_check_usage(
  _tenant_id uuid,
  _month_start timestamptz DEFAULT date_trunc('month', now()),
  _month_end timestamptz DEFAULT (date_trunc('month', now()) + interval '1 month')
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_amount_cents bigint;
  v_events jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role)
     AND NOT public.has_role(auth.uid(), 'staff'::app_role)
     AND NOT public.is_tenant_member(auth.uid(), _tenant_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COUNT(*), COALESCE(SUM(unit_price_cents), 0)
    INTO v_count, v_amount_cents
  FROM public.check_billing_events
  WHERE tenant_id = _tenant_id
    AND billed_at >= _month_start
    AND billed_at < _month_end
    AND status <> 'voided';

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'check_intake_item_id', e.check_intake_item_id,
    'billed_at', e.billed_at,
    'unit_price_cents', e.unit_price_cents,
    'currency', e.currency,
    'status', e.status
  ) ORDER BY e.billed_at DESC), '[]'::jsonb)
    INTO v_events
  FROM public.check_billing_events e
  WHERE e.tenant_id = _tenant_id
    AND e.billed_at >= _month_start
    AND e.billed_at < _month_end
    AND e.status <> 'voided';

  RETURN jsonb_build_object(
    'count', v_count,
    'amount_cents', v_amount_cents,
    'currency', 'usd',
    'month_start', _month_start,
    'month_end', _month_end,
    'events', v_events
  );
END;
$$;

-- 6) Admin backfill for past deposited checks
CREATE OR REPLACE FUNCTION public.backfill_check_billing_events()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
  v_price integer;
  v_currency text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT price_per_check_cents, currency INTO v_price, v_currency
  FROM public.check_billing_config WHERE active = true ORDER BY created_at DESC LIMIT 1;

  WITH ins AS (
    INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, unit_price_cents, currency, status)
    SELECT cii.tenant_id, cii.id, v_price, v_currency, 'recorded'
    FROM public.check_intake_items cii
    WHERE cii.status = 'deposited'
      AND cii.tenant_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.check_billing_events e WHERE e.check_intake_item_id = cii.id
      )
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;

  RETURN jsonb_build_object('inserted', v_inserted);
END;
$$;