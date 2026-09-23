-- Narrow Review amount correction for AWS staging.
-- Does NOT GRANT UPDATE (amount) to checksops or authenticated.
-- Generic /data/write stays unable to change amount / MICR / status.
-- Does not touch raw_ocr_front / raw_ocr_back.
-- Production Supabase is unchanged.

CREATE OR REPLACE FUNCTION public.aws_review_correction_set_amount(
  p_check_id uuid,
  p_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_check public.check_intake_items%ROWTYPE;
  v_old numeric;
  v_member boolean := false;
  v_privileged boolean := false;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF p_check_id IS NULL THEN
    RAISE EXCEPTION 'invalid_uuid' USING ERRCODE = '22023';
  END IF;

  IF p_amount IS NOT NULL AND (p_amount < 0 OR p_amount > 50000000) THEN
    RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_check
  FROM public.check_intake_items
  WHERE id = p_check_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tenant_users
    WHERE user_id = v_actor AND tenant_id = v_check.tenant_id
  ) INTO v_member;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_actor AND role IN ('admin', 'staff')
  ) INTO v_privileged;

  IF NOT v_member AND NOT v_privileged THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF v_check.deposited_at IS NOT NULL
     OR v_check.status IN ('deposited', 'approved_for_deposit')
     OR v_check.check_stage::text IN ('deposited', 'ready_for_deposit', 'funds_released', 'disbursed_externally')
  THEN
    RAISE EXCEPTION 'amount_financially_locked' USING ERRCODE = '42501';
  END IF;

  IF COALESCE(v_check.status, '') NOT IN ('uploaded', 'needs_review', 'ocr_complete', 'manual_review_required')
     AND COALESCE(v_check.check_stage::text, '') <> 'review'
  THEN
    RAISE EXCEPTION 'amount_not_in_review' USING ERRCODE = '42501';
  END IF;

  v_old := v_check.amount;

  UPDATE public.check_intake_items
     SET amount = p_amount,
         updated_at = now()
   WHERE id = p_check_id
     AND deposited_at IS NULL
     AND status NOT IN ('deposited', 'approved_for_deposit');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'amount_financially_locked' USING ERRCODE = '42501';
  END IF;

  UPDATE public.claim_checks
     SET amount = p_amount,
         updated_at = now()
   WHERE check_intake_item_id = p_check_id;

  RETURN jsonb_build_object(
    'ok', true,
    'check_id', p_check_id,
    'old_amount', v_old,
    'amount', p_amount,
    'ocr_preserved', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_review_correction_set_amount(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_review_correction_set_amount(uuid, numeric) TO checksops;

COMMENT ON FUNCTION public.aws_review_correction_set_amount(uuid, numeric) IS
  'Review-only amount correction. Tenant/role + financial-lock checked. Does not grant generic amount UPDATE.';
