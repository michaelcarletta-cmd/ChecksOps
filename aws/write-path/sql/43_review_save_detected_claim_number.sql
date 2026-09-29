-- NOT APPLIED. Repo artifact only. Do not apply from this PR.
--
-- Review Claim # save (PR #455 commit f9b239def). Overwrites a wrong OCR
-- value. Does not GRANT table-column UPDATE of detected_claim_number or amount.
-- Generic /data/write still blocks those columns; the AWS write path
-- calls this RPC when Review updates detected_claim_number.
-- Never inserts a claims row. Existing claim_id is never rewritten.
-- Auto-link on UPDATE may attach an existing same-tenant claim.
-- check_intake_items.claim_id remains the authoritative claim relationship.

CREATE OR REPLACE FUNCTION public.review_save_detected_claim_number(
  p_check_id uuid,
  p_tenant_id uuid,
  p_claim_number text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
SET row_security = off
AS $$
DECLARE
  v_incoming text := nullif(btrim(p_claim_number), '');
  v_existing text;
  v_tenant uuid;
  v_deposited timestamptz;
  v_stage text;
  v_claim_id uuid;
  v_linked_before uuid;
BEGIN
  IF p_check_id IS NULL OR p_tenant_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'invalid_args');
  END IF;

  SELECT nullif(btrim(detected_claim_number), ''), tenant_id, deposited_at,
         check_stage::text, claim_id
    INTO v_existing, v_tenant, v_deposited, v_stage, v_linked_before
  FROM public.check_intake_items
  WHERE id = p_check_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'check_not_found');
  END IF;

  IF v_tenant IS DISTINCT FROM p_tenant_id THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'tenant_mismatch');
  END IF;

  IF v_deposited IS NOT NULL OR COALESCE(v_stage, '') IN ('deposited', 'voided', 'returned') THEN
    RETURN jsonb_build_object('ok', true, 'persisted', false, 'code', 'locked');
  END IF;

  IF public.ocr_claim_number_key(v_existing) IS NOT DISTINCT FROM public.ocr_claim_number_key(v_incoming) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'persisted', false,
      'code', 'unchanged',
      'detected_claim_number', v_existing
    );
  END IF;

  UPDATE public.check_intake_items
     SET detected_claim_number = v_incoming,
         updated_at = now()
   WHERE id = p_check_id
     AND tenant_id IS NOT DISTINCT FROM p_tenant_id
     AND deposited_at IS NULL
     AND COALESCE(check_stage::text, '') NOT IN ('deposited', 'voided', 'returned')
  RETURNING claim_id INTO v_claim_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'persisted', false, 'code', 'conflict_preserved');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'persisted', true,
    'linked', (v_claim_id IS NOT NULL AND v_claim_id IS DISTINCT FROM v_linked_before),
    'code', 'written',
    'detected_claim_number', v_incoming
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_save_detected_claim_number(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_save_detected_claim_number(uuid, uuid, text) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.review_save_detected_claim_number(uuid, uuid, text) TO checksops;
