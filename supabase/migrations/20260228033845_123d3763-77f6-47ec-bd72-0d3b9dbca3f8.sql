
-- Create the "Money Source of Truth" view
-- One row per claim with all financial fields needed by Autopilot and UI
CREATE OR REPLACE VIEW public.claim_money_snapshot AS
SELECT
  c.id AS claim_id,
  -- RCV: sum of all coverage RCVs from settlement
  COALESCE(s.replacement_cost_value, 0) +
  COALESCE(s.other_structures_rcv, 0) +
  COALESCE(s.pwi_rcv, 0) +
  COALESCE(s.personal_property_rcv, 0) AS rcv_claimed,
  
  -- ACV: RCV minus all depreciation minus deductibles
  CASE WHEN s.id IS NOT NULL THEN
    (COALESCE(s.replacement_cost_value, 0) + COALESCE(s.other_structures_rcv, 0) + COALESCE(s.pwi_rcv, 0) + COALESCE(s.personal_property_rcv, 0))
    - (COALESCE(s.recoverable_depreciation, 0) + COALESCE(s.other_structures_recoverable_depreciation, 0) + COALESCE(s.pwi_recoverable_depreciation, 0) + COALESCE(s.personal_property_recoverable_depreciation, 0))
    - (COALESCE(s.non_recoverable_depreciation, 0) + COALESCE(s.other_structures_non_recoverable_depreciation, 0) + COALESCE(s.pwi_non_recoverable_depreciation, 0) + COALESCE(s.personal_property_non_recoverable_depreciation, 0))
    - (COALESCE(s.deductible, 0) + COALESCE(s.other_structures_deductible, 0) + COALESCE(s.pwi_deductible, 0))
  ELSE NULL END AS acv_value,
  
  -- Total depreciation (recoverable + non-recoverable)
  CASE WHEN s.id IS NOT NULL THEN
    COALESCE(s.recoverable_depreciation, 0) + COALESCE(s.other_structures_recoverable_depreciation, 0) + COALESCE(s.pwi_recoverable_depreciation, 0) + COALESCE(s.personal_property_recoverable_depreciation, 0)
    + COALESCE(s.non_recoverable_depreciation, 0) + COALESCE(s.other_structures_non_recoverable_depreciation, 0) + COALESCE(s.pwi_non_recoverable_depreciation, 0) + COALESCE(s.personal_property_non_recoverable_depreciation, 0)
  ELSE NULL END AS dep_total,
  
  -- Recoverable depreciation only
  CASE WHEN s.id IS NOT NULL THEN
    COALESCE(s.recoverable_depreciation, 0) + COALESCE(s.other_structures_recoverable_depreciation, 0) + COALESCE(s.pwi_recoverable_depreciation, 0) + COALESCE(s.personal_property_recoverable_depreciation, 0)
  ELSE NULL END AS dep_recoverable,
  
  -- Total deductible
  COALESCE(s.deductible, 0) + COALESCE(s.other_structures_deductible, 0) + COALESCE(s.pwi_deductible, 0) AS deductible_total,
  
  -- Paid total (from checks ledger only)
  COALESCE(chk.paid_total, 0) AS paid_total,
  
  -- Paid ACV (initial + supplemental checks)
  COALESCE(chk.paid_acv, 0) AS paid_acv,
  
  -- Paid RD (recoverable_depreciation checks)
  COALESCE(chk.paid_rd, 0) AS paid_rd,
  
  -- Unclassified payments (checks with unknown type)
  COALESCE(chk.unclassified_payment_total, 0) AS unclassified_payment_total,
  
  -- RD Available = recoverable depreciation - paid_rd
  CASE WHEN s.id IS NOT NULL THEN
    GREATEST(0,
      COALESCE(s.recoverable_depreciation, 0) + COALESCE(s.other_structures_recoverable_depreciation, 0) + COALESCE(s.pwi_recoverable_depreciation, 0) + COALESCE(s.personal_property_recoverable_depreciation, 0)
      - COALESCE(chk.paid_rd, 0)
    )
  ELSE NULL END AS rd_available,
  
  -- Gap = RCV - paid_total
  GREATEST(0,
    COALESCE(s.replacement_cost_value, 0) + COALESCE(s.other_structures_rcv, 0) + COALESCE(s.pwi_rcv, 0) + COALESCE(s.personal_property_rcv, 0)
    - COALESCE(chk.paid_total, 0)
  ) AS gap,
  
  -- Money confidence
  CASE
    WHEN s.id IS NULL THEN 'low'
    WHEN (COALESCE(s.recoverable_depreciation, 0) + COALESCE(s.other_structures_recoverable_depreciation, 0) + COALESCE(s.pwi_recoverable_depreciation, 0) + COALESCE(s.personal_property_recoverable_depreciation, 0)) = 0
      AND (COALESCE(s.replacement_cost_value, 0) + COALESCE(s.other_structures_rcv, 0) + COALESCE(s.pwi_rcv, 0) + COALESCE(s.personal_property_rcv, 0)) > 0
      THEN 'medium'
    WHEN COALESCE(chk.unclassified_payment_total, 0) > 0 THEN 'medium'
    ELSE 'high'
  END AS money_confidence,
  
  -- Has settlement data
  s.id IS NOT NULL AS has_settlement

FROM public.claims c
LEFT JOIN LATERAL (
  SELECT * FROM public.claim_settlements cs
  WHERE cs.claim_id = c.id
  ORDER BY cs.created_at DESC
  LIMIT 1
) s ON true
LEFT JOIN LATERAL (
  SELECT
    SUM(cc.amount) AS paid_total,
    SUM(CASE WHEN cc.check_type IN ('initial', 'supplemental') THEN cc.amount ELSE 0 END) AS paid_acv,
    SUM(CASE WHEN cc.check_type = 'recoverable_depreciation' THEN cc.amount ELSE 0 END) AS paid_rd,
    SUM(CASE WHEN cc.check_type NOT IN ('initial', 'supplemental', 'recoverable_depreciation') THEN cc.amount ELSE 0 END) AS unclassified_payment_total
  FROM public.claim_checks cc
  WHERE cc.claim_id = c.id
) chk ON true;

-- RPC wrapper for service-role / edge-function access
CREATE OR REPLACE FUNCTION public.get_claim_money_snapshot(p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE result jsonb;
BEGIN
  SELECT row_to_json(cms.*) INTO result
  FROM public.claim_money_snapshot cms
  WHERE cms.claim_id = p_claim_id;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;
