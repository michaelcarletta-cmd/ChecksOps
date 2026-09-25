-- Staging S5: privileged claim association for admin_set_check_claim.
-- Does not GRANT UPDATE(claim_id) on check_intake_items.
-- Generic /data/write remains blocked by INTAKE_PROHIBITED_COLUMNS.

CREATE OR REPLACE FUNCTION public.admin_set_check_claim(
  p_actor_id uuid,
  p_check_id uuid,
  p_claim_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_check record;
  v_claim record;
  v_is_admin boolean;
  v_member boolean;
  v_prior uuid;
  v_updated uuid;
  v_changed_at timestamptz := clock_timestamp();
BEGIN
  IF p_actor_id IS NULL OR p_check_id IS NULL THEN
    RETURN jsonb_build_object('error', 'missing_required_field', 'field', 'p_check_id');
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles
     WHERE user_id = p_actor_id
       AND lower(role::text) = 'admin'
  ) INTO v_is_admin;
  IF NOT v_is_admin THEN
    RETURN jsonb_build_object('error', 'not_authorized', 'message', 'Insufficient role for this workflow RPC');
  END IF;

  SELECT id, tenant_id, claim_id, deposited_at
    INTO v_check
    FROM public.check_intake_items
   WHERE id = p_check_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_authorized', 'message', 'check not found or not writable');
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.tenant_users
     WHERE user_id = p_actor_id
       AND tenant_id = v_check.tenant_id
  ) INTO v_member;
  IF NOT v_member THEN
    RETURN jsonb_build_object('error', 'not_authorized', 'message', 'Check is not in the caller tenant');
  END IF;

  IF v_check.deposited_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'already_deposited', 'message', 'claim_id cannot change after deposit');
  END IF;

  v_prior := v_check.claim_id;
  IF v_prior IS NOT DISTINCT FROM p_claim_id THEN
    RETURN jsonb_build_object(
      'ok', true,
      'noop', true,
      'check_id', p_check_id,
      'prior_claim_id', v_prior,
      'new_claim_id', p_claim_id,
      'claim_id', v_prior
    );
  END IF;

  IF p_claim_id IS NOT NULL THEN
    SELECT id, org_id AS tenant_id
      INTO v_claim
      FROM public.claims
     WHERE id = p_claim_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'rls_denied', 'message', 'claim not found or not writable');
    END IF;
    IF v_claim.tenant_id IS DISTINCT FROM v_check.tenant_id THEN
      RETURN jsonb_build_object('error', 'cross_tenant_denied', 'message', 'Target claim is not in the check tenant');
    END IF;
  END IF;

  UPDATE public.check_intake_items
     SET claim_id = p_claim_id,
         updated_at = now()
   WHERE id = p_check_id
     AND tenant_id = v_check.tenant_id
     AND deposited_at IS NULL
   RETURNING id INTO v_updated;
  IF v_updated IS NULL THEN
    RETURN jsonb_build_object('error', 'already_deposited', 'message', 'claim_id cannot change after deposit');
  END IF;

  INSERT INTO public.check_audit_log (
    check_id, tenant_id, actor_id, event_type, event_description, event_data
  ) VALUES (
    p_check_id,
    v_check.tenant_id,
    p_actor_id,
    'admin_set_check_claim',
    'Admin set or cleared check claim association',
    jsonb_build_object(
      'actor_id', p_actor_id,
      'changed_at', v_changed_at,
      'check_id', p_check_id,
      'prior_claim_id', v_prior,
      'new_claim_id', p_claim_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'noop', false,
    'check_id', p_check_id,
    'prior_claim_id', v_prior,
    'new_claim_id', p_claim_id,
    'claim_id', p_claim_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_check_claim(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_check_claim(uuid, uuid, uuid) TO checksops;
