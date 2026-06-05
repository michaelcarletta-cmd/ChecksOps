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
    'payee_name', ci.payee_name
  ) ORDER BY e.billed_at DESC), '[]'::jsonb)
    INTO v_events
  FROM public.check_billing_events e
  LEFT JOIN public.check_intake_items ci ON ci.id = e.check_intake_item_id
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