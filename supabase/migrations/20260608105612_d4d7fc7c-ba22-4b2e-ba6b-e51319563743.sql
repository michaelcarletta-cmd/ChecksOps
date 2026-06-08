CREATE OR REPLACE FUNCTION public.get_check_claim_settlement(p_check_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_check RECORD;
  v_has_access boolean := false;
  v_claim jsonb;
  v_settlement jsonb;
  v_sibling_checks jsonb;
BEGIN
  IF v_user IS NULL THEN RETURN NULL; END IF;

  SELECT id, tenant_id, claim_id, detected_claim_number
  INTO v_check
  FROM check_intake_items
  WHERE id = p_check_id;

  IF NOT FOUND THEN RETURN NULL; END IF;

  IF user_belongs_to_tenant(v_user, v_check.tenant_id) THEN
    v_has_access := true;
  ELSIF EXISTS (
    SELECT 1 FROM shared_checks sc
    WHERE sc.check_id = p_check_id
      AND sc.revoked_at IS NULL
      AND user_belongs_to_tenant(v_user, sc.target_tenant_id)
  ) THEN
    v_has_access := true;
  ELSIF has_role(v_user, 'admin'::app_role) OR has_role(v_user, 'staff'::app_role) THEN
    v_has_access := true;
  END IF;

  IF NOT v_has_access THEN RETURN NULL; END IF;

  IF v_check.claim_id IS NULL THEN
    RETURN jsonb_build_object(
      'claim', NULL,
      'settlement', NULL,
      'sibling_checks', '[]'::jsonb,
      'detected_claim_number', v_check.detected_claim_number
    );
  END IF;

  SELECT to_jsonb(c) INTO v_claim
  FROM (SELECT id, claim_number, policyholder_name, policyholder_address
        FROM claims WHERE id = v_check.claim_id) c;

  SELECT to_jsonb(s) INTO v_settlement
  FROM (SELECT * FROM claim_settlements WHERE claim_id = v_check.claim_id LIMIT 1) s;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.issue_date DESC NULLS LAST), '[]'::jsonb)
  INTO v_sibling_checks
  FROM (SELECT id, check_number, amount, carrier_name, issue_date, status, check_stage, created_at
        FROM check_intake_items WHERE claim_id = v_check.claim_id) x;

  RETURN jsonb_build_object(
    'claim', v_claim,
    'settlement', v_settlement,
    'sibling_checks', v_sibling_checks,
    'detected_claim_number', v_check.detected_claim_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_check_claim_settlement(uuid) TO authenticated;