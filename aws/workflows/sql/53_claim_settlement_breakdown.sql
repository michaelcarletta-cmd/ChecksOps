CREATE OR REPLACE FUNCTION public.save_claim_settlement_breakdown(
  p_claim_id uuid,
  p_settlement_id uuid,
  p_values jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  v_key text;
  v_value jsonb;
  v_amount numeric;
  v_settlement_id uuid := p_settlement_id;
  v_settlement public.claim_settlements%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL
     OR p_claim_id IS NULL
     OR NOT public.aws_can_write_claim(p_claim_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authorized');
  END IF;

  IF jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR p_values = '{}'::jsonb THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_settlement_values');
  END IF;

  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(p_values) LOOP
    IF v_key NOT IN (
      'replacement_cost_value',
      'recoverable_depreciation',
      'non_recoverable_depreciation',
      'deductible',
      'other_structures_rcv',
      'other_structures_recoverable_depreciation',
      'other_structures_non_recoverable_depreciation',
      'other_structures_deductible',
      'pwi_rcv',
      'pwi_recoverable_depreciation',
      'pwi_non_recoverable_depreciation',
      'personal_property_rcv',
      'personal_property_recoverable_depreciation',
      'personal_property_non_recoverable_depreciation',
      'ale_rcv',
      'ale_recoverable_depreciation',
      'ale_non_recoverable_depreciation'
    ) OR jsonb_typeof(v_value) IS DISTINCT FROM 'number' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'invalid_settlement_values');
    END IF;
    v_amount := (v_value #>> '{}')::numeric;
    IF v_amount < 0 OR round(v_amount, 2) > 9999999999.99 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'invalid_settlement_values');
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_claim_id::text, 0));

  IF v_settlement_id IS NULL THEN
    SELECT id
      INTO v_settlement_id
      FROM public.claim_settlements
     WHERE claim_id = p_claim_id
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR UPDATE;
  END IF;

  IF v_settlement_id IS NOT NULL THEN
    UPDATE public.claim_settlements AS s
       SET replacement_cost_value = CASE WHEN p_values ? 'replacement_cost_value' THEN (p_values->>'replacement_cost_value')::numeric ELSE s.replacement_cost_value END,
           recoverable_depreciation = CASE WHEN p_values ? 'recoverable_depreciation' THEN (p_values->>'recoverable_depreciation')::numeric ELSE s.recoverable_depreciation END,
           non_recoverable_depreciation = CASE WHEN p_values ? 'non_recoverable_depreciation' THEN (p_values->>'non_recoverable_depreciation')::numeric ELSE s.non_recoverable_depreciation END,
           deductible = CASE WHEN p_values ? 'deductible' THEN (p_values->>'deductible')::numeric ELSE s.deductible END,
           other_structures_rcv = CASE WHEN p_values ? 'other_structures_rcv' THEN (p_values->>'other_structures_rcv')::numeric ELSE s.other_structures_rcv END,
           other_structures_recoverable_depreciation = CASE WHEN p_values ? 'other_structures_recoverable_depreciation' THEN (p_values->>'other_structures_recoverable_depreciation')::numeric ELSE s.other_structures_recoverable_depreciation END,
           other_structures_non_recoverable_depreciation = CASE WHEN p_values ? 'other_structures_non_recoverable_depreciation' THEN (p_values->>'other_structures_non_recoverable_depreciation')::numeric ELSE s.other_structures_non_recoverable_depreciation END,
           other_structures_deductible = CASE WHEN p_values ? 'other_structures_deductible' THEN (p_values->>'other_structures_deductible')::numeric ELSE s.other_structures_deductible END,
           pwi_rcv = CASE WHEN p_values ? 'pwi_rcv' THEN (p_values->>'pwi_rcv')::numeric ELSE s.pwi_rcv END,
           pwi_recoverable_depreciation = CASE WHEN p_values ? 'pwi_recoverable_depreciation' THEN (p_values->>'pwi_recoverable_depreciation')::numeric ELSE s.pwi_recoverable_depreciation END,
           pwi_non_recoverable_depreciation = CASE WHEN p_values ? 'pwi_non_recoverable_depreciation' THEN (p_values->>'pwi_non_recoverable_depreciation')::numeric ELSE s.pwi_non_recoverable_depreciation END,
           personal_property_rcv = CASE WHEN p_values ? 'personal_property_rcv' THEN (p_values->>'personal_property_rcv')::numeric ELSE s.personal_property_rcv END,
           personal_property_recoverable_depreciation = CASE WHEN p_values ? 'personal_property_recoverable_depreciation' THEN (p_values->>'personal_property_recoverable_depreciation')::numeric ELSE s.personal_property_recoverable_depreciation END,
           personal_property_non_recoverable_depreciation = CASE WHEN p_values ? 'personal_property_non_recoverable_depreciation' THEN (p_values->>'personal_property_non_recoverable_depreciation')::numeric ELSE s.personal_property_non_recoverable_depreciation END,
           ale_rcv = CASE WHEN p_values ? 'ale_rcv' THEN (p_values->>'ale_rcv')::numeric ELSE s.ale_rcv END,
           ale_recoverable_depreciation = CASE WHEN p_values ? 'ale_recoverable_depreciation' THEN (p_values->>'ale_recoverable_depreciation')::numeric ELSE s.ale_recoverable_depreciation END,
           ale_non_recoverable_depreciation = CASE WHEN p_values ? 'ale_non_recoverable_depreciation' THEN (p_values->>'ale_non_recoverable_depreciation')::numeric ELSE s.ale_non_recoverable_depreciation END,
           updated_at = now()
     WHERE s.id = v_settlement_id
       AND s.claim_id = p_claim_id
     RETURNING s.* INTO v_settlement;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'not_found');
    END IF;
  ELSE
    INSERT INTO public.claim_settlements (
      claim_id,
      replacement_cost_value,
      recoverable_depreciation,
      non_recoverable_depreciation,
      deductible,
      other_structures_rcv,
      other_structures_recoverable_depreciation,
      other_structures_non_recoverable_depreciation,
      other_structures_deductible,
      pwi_rcv,
      pwi_recoverable_depreciation,
      pwi_non_recoverable_depreciation,
      personal_property_rcv,
      personal_property_recoverable_depreciation,
      personal_property_non_recoverable_depreciation,
      ale_rcv,
      ale_recoverable_depreciation,
      ale_non_recoverable_depreciation,
      created_by
    ) VALUES (
      p_claim_id,
      COALESCE((p_values->>'replacement_cost_value')::numeric, 0),
      COALESCE((p_values->>'recoverable_depreciation')::numeric, 0),
      COALESCE((p_values->>'non_recoverable_depreciation')::numeric, 0),
      COALESCE((p_values->>'deductible')::numeric, 0),
      COALESCE((p_values->>'other_structures_rcv')::numeric, 0),
      COALESCE((p_values->>'other_structures_recoverable_depreciation')::numeric, 0),
      COALESCE((p_values->>'other_structures_non_recoverable_depreciation')::numeric, 0),
      COALESCE((p_values->>'other_structures_deductible')::numeric, 0),
      COALESCE((p_values->>'pwi_rcv')::numeric, 0),
      COALESCE((p_values->>'pwi_recoverable_depreciation')::numeric, 0),
      COALESCE((p_values->>'pwi_non_recoverable_depreciation')::numeric, 0),
      COALESCE((p_values->>'personal_property_rcv')::numeric, 0),
      COALESCE((p_values->>'personal_property_recoverable_depreciation')::numeric, 0),
      COALESCE((p_values->>'personal_property_non_recoverable_depreciation')::numeric, 0),
      COALESCE((p_values->>'ale_rcv')::numeric, 0),
      COALESCE((p_values->>'ale_recoverable_depreciation')::numeric, 0),
      COALESCE((p_values->>'ale_non_recoverable_depreciation')::numeric, 0),
      auth.uid()
    )
    RETURNING * INTO v_settlement;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'saved',
    'settlement', to_jsonb(v_settlement)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_claim_settlement_breakdown(uuid, uuid, jsonb)
  FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.save_claim_settlement_breakdown(uuid, uuid, jsonb) TO checksops;
