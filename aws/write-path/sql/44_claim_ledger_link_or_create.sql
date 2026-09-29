-- NOT APPLIED. Repo artifact only. Do not apply from this PR.
--
-- Claim Ledger link-or-create (narrow atomic operation).
-- Does NOT grant generic claims INSERT.
-- Does NOT grant generic check_intake_items.claim_id UPDATE.
-- Generic /data/write still blocks those.
-- The AWS write path calls this RPC via POST /data/rpc.
--
-- Actions:
--   inspect       — lock check, report already_linked / existing_found / no_match / ambiguous
--   link_existing — SET claim_id to the unique same-tenant match only
--   create_new    — INSERT one tracking claim + SET claim_id atomically
--
-- Already-linked checks return the existing claim and never relink or create.
-- Existing claim_id is never rewritten.
-- Cross-tenant matches cannot be linked. Ambiguous matches fail closed.
-- Does not write amount, deposited_at, check_stage, or settlement columns.
-- Does not change Review detected_claim_number behavior.

CREATE OR REPLACE FUNCTION public.claim_ledger_link_or_create(
  p_check_id uuid,
  p_tenant_id uuid,
  p_claim_number text,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
SET row_security = off
AS $$
DECLARE
  v_action text := lower(btrim(COALESCE(p_action, '')));
  v_incoming text := nullif(btrim(p_claim_number), '');
  v_key text;
  v_check_tenant uuid;
  v_linked uuid;
  v_stage text;
  v_deposited timestamptz;
  v_same_id uuid;
  v_same_number text;
  v_same_name text;
  v_same_count int;
  v_other_id uuid;
  v_other_org uuid;
  v_other_count int;
  v_new_id uuid;
  v_after uuid;
BEGIN
  IF p_check_id IS NULL OR p_tenant_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'created', false, 'linked', false, 'code', 'invalid_args');
  END IF;

  IF v_action NOT IN ('inspect', 'link_existing', 'create_new') THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'created', false, 'linked', false, 'code', 'invalid_action');
  END IF;

  IF v_incoming IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'created', false, 'linked', false, 'code', 'invalid_args');
  END IF;

  v_key := public.ocr_claim_number_key(v_incoming);
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'created', false, 'linked', false, 'code', 'invalid_args');
  END IF;

  SELECT tenant_id, claim_id, check_stage::text, deposited_at
    INTO v_check_tenant, v_linked, v_stage, v_deposited
  FROM public.check_intake_items
  WHERE id = p_check_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'created', false, 'linked', false, 'code', 'check_not_found');
  END IF;

  IF v_check_tenant IS DISTINCT FROM p_tenant_id THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'created', false, 'linked', false, 'code', 'tenant_mismatch');
  END IF;

  IF v_linked IS NOT NULL THEN
    SELECT c.id, c.claim_number, c.policyholder_name
      INTO v_same_id, v_same_number, v_same_name
    FROM public.claims c
    WHERE c.id = v_linked;
    RETURN jsonb_build_object(
      'ok', true,
      'persisted', false,
      'created', false,
      'linked', false,
      'code', 'already_linked',
      'claim_id', v_linked,
      'claim_number', v_same_number,
      'policyholder_name', v_same_name,
      'check_claim_id', v_linked
    );
  END IF;

  SELECT c.id, c.claim_number, c.policyholder_name, count(*) OVER ()
    INTO v_same_id, v_same_number, v_same_name, v_same_count
  FROM public.claims c
  WHERE c.org_id IS NOT DISTINCT FROM p_tenant_id
    AND public.ocr_claim_number_key(c.claim_number) = v_key
  LIMIT 1;

  SELECT c.id, c.org_id, count(*) OVER ()
    INTO v_other_id, v_other_org, v_other_count
  FROM public.claims c
  WHERE public.ocr_claim_number_key(c.claim_number) = v_key
    AND c.org_id IS DISTINCT FROM p_tenant_id
  LIMIT 1;

  IF COALESCE(v_same_count, 0) > 1 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'persisted', false,
      'created', false,
      'linked', false,
      'code', 'ambiguous'
    );
  END IF;

  IF v_action = 'inspect' THEN
    IF v_same_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true,
        'persisted', false,
        'created', false,
        'linked', false,
        'code', 'existing_found',
        'can_link', true,
        'claim_id', v_same_id,
        'claim_number', v_same_number,
        'policyholder_name', v_same_name,
        'check_claim_id', NULL
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'persisted', false,
      'created', false,
      'linked', false,
      'code', 'no_match',
      'can_create', (v_other_id IS NULL),
      'claim_id', NULL,
      'check_claim_id', NULL
    );
  END IF;

  IF v_action = 'link_existing' THEN
    IF v_same_id IS NULL THEN
      IF v_other_id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'persisted', false, 'created', false, 'linked', false, 'code', 'cross_tenant');
      END IF;
      RETURN jsonb_build_object('ok', false, 'persisted', false, 'created', false, 'linked', false, 'code', 'no_match');
    END IF;

    UPDATE public.check_intake_items
       SET claim_id = v_same_id,
           updated_at = now()
     WHERE id = p_check_id
       AND tenant_id IS NOT DISTINCT FROM p_tenant_id
       AND claim_id IS NULL
    RETURNING claim_id INTO v_after;

    IF v_after IS NULL OR v_after IS DISTINCT FROM v_same_id THEN
      RETURN jsonb_build_object('ok', false, 'persisted', false, 'created', false, 'linked', false, 'code', 'link_failed');
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'persisted', true,
      'created', false,
      'linked', true,
      'code', 'linked',
      'claim_id', v_same_id,
      'claim_number', v_same_number,
      'policyholder_name', v_same_name,
      'check_claim_id', v_after
    );
  END IF;

  -- create_new
  IF v_same_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'persisted', false,
      'created', false,
      'linked', false,
      'code', 'existing_found',
      'claim_id', v_same_id,
      'claim_number', v_same_number
    );
  END IF;

  IF v_other_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'persisted', false,
      'created', false,
      'linked', false,
      'code', 'cross_tenant'
    );
  END IF;

  BEGIN
    INSERT INTO public.claims (claim_number, status, org_id)
    VALUES (v_incoming, 'tracking', p_tenant_id)
    RETURNING id INTO v_new_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT c.id, c.org_id
        INTO v_same_id, v_other_org
      FROM public.claims c
      WHERE public.ocr_claim_number_key(c.claim_number) = v_key
      LIMIT 1;
      IF v_same_id IS NOT NULL AND v_other_org IS NOT DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object(
          'ok', false,
          'persisted', false,
          'created', false,
          'linked', false,
          'code', 'existing_found',
          'claim_id', v_same_id
        );
      END IF;
      RETURN jsonb_build_object(
        'ok', false,
        'persisted', false,
        'created', false,
        'linked', false,
        'code', 'claim_number_conflict'
      );
  END;

  UPDATE public.check_intake_items
     SET claim_id = v_new_id,
         updated_at = now()
   WHERE id = p_check_id
     AND tenant_id IS NOT DISTINCT FROM p_tenant_id
     AND claim_id IS NULL
  RETURNING claim_id INTO v_after;

  IF v_after IS NULL OR v_after IS DISTINCT FROM v_new_id THEN
    RAISE EXCEPTION 'claim_ledger_link_failed'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'persisted', true,
    'created', true,
    'linked', true,
    'code', 'created',
    'claim_id', v_new_id,
    'claim_number', v_incoming,
    'check_claim_id', v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ledger_link_or_create(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_ledger_link_or_create(uuid, uuid, text, text) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.claim_ledger_link_or_create(uuid, uuid, text, text) TO checksops;
