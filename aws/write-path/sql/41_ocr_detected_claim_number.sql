-- NOT APPLIED. Repo artifact only. Do not apply from this PR.
--
-- Safe OCR claim-number persistence for AWS check-ocr-intake.
-- See 41_ocr_claim_link_semantics.md.
--
-- A claim number identifies the claim, not the check and not the payee.
-- Many checks may share one claim number and must all link to that same
-- existing tenant-local claim_id. Payee differences are ignored. This
-- artifact never inserts a claims row.
--
-- Ambiguous only when two+ claims rows in the SAME tenant share the
-- normalized number (lower + btrim; punctuation significant). Repeated
-- detected_claim_number values on check_intake_items are required, not errors.
-- Cross-tenant numbers never link. Existing claim_id is never rewritten.
--
-- Does not grant table-column UPDATE of detected_claim_number to authenticated or checksops.
-- Generic /data/write remains blocked by INTAKE_PROHIBITED_COLUMNS.

CREATE OR REPLACE FUNCTION public.ocr_claim_number_key(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(lower(btrim(p_value)), '');
$$;

CREATE OR REPLACE FUNCTION public.ocr_unique_tenant_claim_id(
  p_tenant_id uuid,
  p_claim_number text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_key text := public.ocr_claim_number_key(p_claim_number);
  v_id uuid;
  v_count int;
BEGIN
  IF p_tenant_id IS NULL OR v_key IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.id, count(*) OVER ()
    INTO v_id, v_count
  FROM public.claims c
  WHERE c.org_id IS NOT DISTINCT FROM p_tenant_id
    AND public.ocr_claim_number_key(c.claim_number) = v_key
  LIMIT 1;

  IF v_count IS DISTINCT FROM 1 THEN
    RETURN NULL;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_link_check_to_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_candidate uuid;
BEGIN
  IF NEW.claim_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.freedom_claim_id IS NOT NULL AND NEW.tenant_id IS NOT NULL THEN
    SELECT c.id
      INTO v_candidate
    FROM public.claims c
    WHERE c.id = NEW.freedom_claim_id
      AND c.org_id IS NOT DISTINCT FROM NEW.tenant_id;
  END IF;

  IF v_candidate IS NULL AND NEW.freedom_claim_number IS NOT NULL THEN
    v_candidate := public.ocr_unique_tenant_claim_id(NEW.tenant_id, NEW.freedom_claim_number);
  END IF;

  IF v_candidate IS NULL AND NEW.detected_claim_number IS NOT NULL THEN
    v_candidate := public.ocr_unique_tenant_claim_id(NEW.tenant_id, NEW.detected_claim_number);
  END IF;

  IF v_candidate IS NOT NULL THEN
    NEW.claim_id := v_candidate;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_auto_link_check_to_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  IF NEW.claim_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  NEW.claim_id := public.ocr_unique_tenant_claim_id(NEW.tenant_id, NEW.detected_claim_number);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.ocr_persist_detected_claim_number(
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
  v_claim_id uuid;
  v_tenant uuid;
  v_linked_before uuid;
BEGIN
  IF v_incoming IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'persisted', false, 'linked', false, 'code', 'absent');
  END IF;

  IF p_check_id IS NULL OR p_tenant_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'linked', false, 'code', 'invalid_args');
  END IF;

  SELECT nullif(btrim(detected_claim_number), ''), claim_id, tenant_id
    INTO v_existing, v_linked_before, v_tenant
  FROM public.check_intake_items
  WHERE id = p_check_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'linked', false, 'code', 'check_not_found');
  END IF;

  IF v_tenant IS DISTINCT FROM p_tenant_id THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'linked', false, 'code', 'tenant_mismatch');
  END IF;

  IF v_existing IS NOT NULL THEN
    IF public.ocr_claim_number_key(v_existing) = public.ocr_claim_number_key(v_incoming) THEN
      RETURN jsonb_build_object('ok', true, 'persisted', false, 'linked', false, 'code', 'unchanged');
    END IF;
    RETURN jsonb_build_object('ok', true, 'persisted', false, 'linked', false, 'code', 'conflict_preserved');
  END IF;

  UPDATE public.check_intake_items
     SET detected_claim_number = v_incoming,
         updated_at = now()
   WHERE id = p_check_id
     AND tenant_id IS NOT DISTINCT FROM p_tenant_id
     AND nullif(btrim(detected_claim_number), '') IS NULL
  RETURNING claim_id INTO v_claim_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'persisted', false, 'linked', false, 'code', 'conflict_preserved');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'persisted', true,
    'linked', (v_claim_id IS NOT NULL AND v_claim_id IS DISTINCT FROM v_linked_before),
    'code', 'written'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ocr_claim_number_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ocr_unique_tenant_claim_id(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ocr_persist_detected_claim_number(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ocr_persist_detected_claim_number(uuid, uuid, text) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.ocr_claim_number_key(text) TO checksops;
GRANT EXECUTE ON FUNCTION public.ocr_unique_tenant_claim_id(uuid, text) TO checksops;
GRANT EXECUTE ON FUNCTION public.ocr_persist_detected_claim_number(uuid, uuid, text) TO checksops;
