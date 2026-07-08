
-- Fix get_tenant_check_usage: ci.payee_name does not exist; use payee_line.
CREATE OR REPLACE FUNCTION public.get_tenant_check_usage(_tenant_id uuid, _month_start timestamp with time zone DEFAULT date_trunc('month'::text, now()), _month_end timestamp with time zone DEFAULT (date_trunc('month'::text, now()) + '1 mon'::interval))
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    'status', e.status,
    'event_type', e.event_type,
    'check_number', ci.check_number,
    'payee_name', ci.payee_line,
    'processed_by', p.full_name
  ) ORDER BY e.billed_at DESC), '[]'::jsonb)
    INTO v_events
  FROM public.check_billing_events e
  LEFT JOIN public.check_intake_items ci ON ci.id = e.check_intake_item_id
  LEFT JOIN public.profiles p ON p.id = ci.uploaded_by
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
$function$;

-- Table to track maintenance/monthly fees received from tenants
CREATE TABLE IF NOT EXISTS public.tenant_maintenance_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  period_start date NOT NULL,
  period_end date NOT NULL,
  method text NOT NULL DEFAULT 'stripe',
  reference text,
  notes text,
  received_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_maintenance_payments TO authenticated;
GRANT ALL ON public.tenant_maintenance_payments TO service_role;

ALTER TABLE public.tenant_maintenance_payments ENABLE ROW LEVEL SECURITY;

-- Only platform admin (Freedom Adjustment) can manage
CREATE POLICY "platform_admin_manage_maintenance_payments"
  ON public.tenant_maintenance_payments
  FOR ALL
  USING (auth.uid() IN (SELECT id FROM auth.users WHERE email = 'mcarletta@freedomadj.com'))
  WITH CHECK (auth.uid() IN (SELECT id FROM auth.users WHERE email = 'mcarletta@freedomadj.com'));

-- Tenants can view their own payment history
CREATE POLICY "tenants_view_own_maintenance_payments"
  ON public.tenant_maintenance_payments
  FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS tenant_maintenance_payments_tenant_idx
  ON public.tenant_maintenance_payments(tenant_id, received_at DESC);

CREATE TRIGGER tenant_maintenance_payments_set_updated_at
  BEFORE UPDATE ON public.tenant_maintenance_payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
