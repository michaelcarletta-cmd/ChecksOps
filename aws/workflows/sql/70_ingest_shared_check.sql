-- AWS staging: SECURITY DEFINER ingest for partner-shared checks (Class A).
-- Used when the API role cannot bypass RLS for unauthenticated bridge writes.
-- Does NOT apply financial activation. Does not enable provider execution.
-- Production Supabase is unchanged.

CREATE OR REPLACE FUNCTION public.aws_ingest_shared_check(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_target_code text;
  v_target_tenant uuid;
  v_source_tenant uuid;
  v_native uuid;
  v_check_id uuid;
  v_payee jsonb;
  v_signed_at timestamptz;
BEGIN
  IF p_payload IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing required fields', 'statusCode', 400);
  END IF;

  v_target_code := upper(trim(p_payload->>'target_partner_code'));
  IF coalesce(p_payload->>'source_check_id', '') = '' OR v_target_code IS NULL OR v_target_code = ''
     OR coalesce(p_payload->>'source_tenant_id', '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing required fields', 'statusCode', 400);
  END IF;

  SELECT id INTO v_target_tenant
  FROM public.lookup_tenant_by_partner_code(v_target_code)
  LIMIT 1;
  IF v_target_tenant IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'target_partner_code not found', 'statusCode', 404);
  END IF;

  IF upper(coalesce(p_payload->>'source_partner_code', '')) = 'DF9CC985' THEN
    v_native := '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a'::uuid;
    v_source_tenant := v_native;
  ELSE
    v_native := NULL;
    SELECT id INTO v_source_tenant
    FROM public.tenants
    WHERE slug = 'ext-' || left(coalesce(p_payload->>'source_app', 'app'), 24)
      || '-' || left(p_payload->>'source_tenant_id', 8)
    LIMIT 1;
    IF v_source_tenant IS NULL THEN
      INSERT INTO public.tenants (name, slug, plan_tier)
      VALUES (
        coalesce(p_payload->>'source_tenant_name', 'External') || ' (' || coalesce(p_payload->>'source_app', 'partner') || ')',
        'ext-' || left(coalesce(p_payload->>'source_app', 'app'), 24) || '-' || left(p_payload->>'source_tenant_id', 8),
        'starter'
      )
      RETURNING id INTO v_source_tenant;
    END IF;
  END IF;

  SELECT id INTO v_check_id
  FROM public.check_intake_items
  WHERE external_origin->>'source_check_id' = p_payload->>'source_check_id'
  LIMIT 1;

  IF v_check_id IS NOT NULL THEN
    UPDATE public.check_intake_items SET
      updated_at = now(),
      carrier_name = coalesce(p_payload->'check'->>'carrier_name', carrier_name),
      check_number = coalesce(p_payload->'check'->>'check_number', check_number),
      amount = CASE WHEN p_payload->'check' ? 'amount' THEN NULLIF(p_payload->'check'->>'amount', '')::numeric ELSE amount END,
      front_image_path = CASE
        WHEN coalesce(p_payload->>'front_image_path', '') <> '' AND p_payload->>'front_image_path' NOT LIKE 'http%'
        THEN p_payload->>'front_image_path' ELSE front_image_path END,
      back_image_path = CASE
        WHEN coalesce(p_payload->>'back_image_path', '') <> '' AND p_payload->>'back_image_path' NOT LIKE 'http%'
        THEN p_payload->>'back_image_path' ELSE back_image_path END
    WHERE id = v_check_id;
  ELSE
    INSERT INTO public.check_intake_items (
      tenant_id, front_image_path, back_image_path, carrier_name, check_number, amount,
      issue_date, payee_line, detected_claim_number, funds_type, property_address,
      payment_classification, payee_address, status, check_stage, check_source,
      deposit_recommendation, ocr_status, freedom_claim_id, freedom_claim_number,
      external_origin
    ) VALUES (
      v_source_tenant,
      coalesce(NULLIF(p_payload->>'front_image_path', ''), 'external://' || (p_payload->>'source_check_id')),
      NULLIF(p_payload->>'back_image_path', ''),
      p_payload->'check'->>'carrier_name',
      p_payload->'check'->>'check_number',
      NULLIF(p_payload->>'amount', '')::numeric,
      NULLIF(p_payload->'check'->>'issue_date', '')::date,
      p_payload->'check'->>'payee_line',
      p_payload->'check'->>'detected_claim_number',
      p_payload->'check'->>'funds_type',
      p_payload->'check'->>'property_address',
      p_payload->'check'->>'payment_classification',
      p_payload->'check'->>'payee_address',
      CASE WHEN v_native IS NOT NULL THEN coalesce(p_payload->'check'->>'status', 'needs_review') ELSE coalesce(p_payload->'check'->>'status', 'uploaded') END,
      CASE WHEN v_native IS NOT NULL THEN 'review' ELSE coalesce(p_payload->'check'->>'check_stage', 'review') END,
      'insurance',
      p_payload->'check'->>'deposit_recommendation',
      coalesce(p_payload->'check'->>'ocr_status', 'pending'),
      NULLIF(p_payload->>'freedom_claim_id', '')::uuid,
      p_payload->>'freedom_claim_number',
      jsonb_build_object(
        'source_app', p_payload->>'source_app',
        'source_project_ref', p_payload->>'source_project_ref',
        'source_tenant_id', p_payload->>'source_tenant_id',
        'source_tenant_name', p_payload->>'source_tenant_name',
        'source_check_id', p_payload->>'source_check_id',
        'source_partner_code', p_payload->>'source_partner_code',
        'native_paired', v_native IS NOT NULL,
        'ingested_at', now(),
        'shared_by_email', p_payload->>'shared_by_email'
      )
    )
    RETURNING id INTO v_check_id;
  END IF;

  IF coalesce(p_payload->>'payeesProvided', 'false') = 'true' THEN
    DELETE FROM public.check_payees WHERE check_id = v_check_id;
    DELETE FROM public.check_endorsements WHERE check_id = v_check_id;
    FOR v_payee IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'cleanedPayees', '[]'::jsonb))
    LOOP
      v_signed_at := coalesce(NULLIF(v_payee->>'endorsed_at', ''), NULLIF(v_payee->>'signed_at', ''))::timestamptz;
      INSERT INTO public.check_payees (
        check_id, tenant_id, payee_name, payee_type, endorsement_status, endorsed_at, contact_email, contact_phone
      ) VALUES (
        v_check_id, v_source_tenant, v_payee->>'payee_name', coalesce(NULLIF(v_payee->>'payee_type', ''), 'unknown'),
        CASE WHEN v_signed_at IS NOT NULL THEN 'signed' ELSE coalesce(NULLIF(v_payee->>'endorsement_status', ''), 'pending') END,
        v_signed_at, v_payee->>'contact_email', v_payee->>'contact_phone'
      );
      INSERT INTO public.check_endorsements (
        check_id, tenant_id, payee_name, payee_type, status, signed_at, contact_email, contact_phone
      ) VALUES (
        v_check_id, v_source_tenant, v_payee->>'payee_name', coalesce(NULLIF(v_payee->>'payee_type', ''), 'unknown'),
        CASE WHEN v_signed_at IS NOT NULL THEN 'signed' ELSE coalesce(NULLIF(v_payee->>'endorsement_status', ''), 'pending') END,
        v_signed_at, v_payee->>'contact_email', v_payee->>'contact_phone'
      );
    END LOOP;
  END IF;

  IF v_native IS NULL THEN
    INSERT INTO public.shared_checks (
      check_id, source_tenant_id, target_tenant_id, shared_by, access_level, revoked_at
    ) VALUES (
      v_check_id, v_source_tenant, v_target_tenant, '00000000-0000-0000-0000-000000000000'::uuid, 'read_only', NULL
    )
    ON CONFLICT (check_id, source_tenant_id, target_tenant_id)
    DO UPDATE SET revoked_at = NULL, access_level = 'read_only';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'statusCode', 200,
    'check_id', v_check_id,
    'target_tenant_id', v_target_tenant,
    'source_tenant_id', v_source_tenant,
    'native_paired', v_native IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_ingest_shared_check(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_ingest_shared_check(jsonb) TO checksops;

COMMENT ON FUNCTION public.aws_ingest_shared_check(jsonb) IS
  'Partner ingest for shared checks. Bridge-authenticated API only. Amount comes from partner payload. Not a payment execution path.';
