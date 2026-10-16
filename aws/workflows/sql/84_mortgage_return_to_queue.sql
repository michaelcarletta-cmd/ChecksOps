-- AWS: Mortgage Ops Return to Queue (SQL 84).
-- Additive forward migration on top of the Mortgage Agent compensation ledger
-- (Cursor SQL 47, aws/isolated/mortgage-agent-compensation/sql/
-- 47_mortgage_agent_compensation.sql, sha256 bdbdccbc...). Does NOT rewrite or
-- reapply SQL 47.
--
-- Provenance: Cursor SQL 48 (aws/isolated/mortgage-agent-compensation/sql/
-- 48_return_mortgage_request_to_queue.sql, sha256 be6c7125..., branch
-- cursor/mortgage-agent-lambda-prod-ad99 b73e976be), renumbered to 84 to
-- follow main's 83_homeowner_signing_capabilities.sql. Same function name and
-- signature, so applying this replaces a live SQL 48 body in place.
--
-- Changes from SQL 48:
--   * Platform owner only. The caller must satisfy public.is_platform_owner()
--     (the predicate main's API uses, IS_PLATFORM_OWNER_SQL in data.mjs).
--     SQL 48 used aws_can_admin_mortgage_agent_compensation(), which also
--     admits any global user_roles 'admin'. Tenant owners/admins, platform
--     admins, staff and Mortgage Agents are refused (42501 not_authorized).
--   * The audit SELECT policy is platform owner only, for the same reason.
--   * The hardcoded request UUID (the accidental Freedom Accept) is removed.
--     Exclusions come only from public.mortgage_agent_compensation_exclusions,
--     where SQL 47 seeds that request. Behaviour changes only if that
--     exclusion row is deleted: the request would then be returnable.
--   * REVOKE ALL ... FROM PUBLIC before the grant (SQL 48 left the default
--     PUBLIC EXECUTE in place; the body check still refused non-admins).
--
-- Does NOT:
--   GRANT UPDATE ON TABLE mortgage_handling_requests
--   ALTER mortgage_handling_requests
--   INSERT/UPDATE/void check_billing_events (the original tenant billing event
--     stays; only its id is copied into the audit row)
--   change tenant $10/$5 rates or agent compensation rates
--   create, approve or pay compensation entries
--   implement A-to-B raw reassignment (the next agent must Accept normally)
--   reference any provider money rail
--
-- GATE 0 (kept from SQL 48): staging already has
--   check_billing_events_mortgage_ops_check_uidx
--   UNIQUE (check_intake_item_id)
--   WHERE event_type IN (mortgage_ops_initial, mortgage_ops_additional_check)
--     AND check_intake_item_id IS NOT NULL
-- The designed fallback unique index is created only when that protection is
-- absent, so a re-Accept after Return cannot add a second tenant charge. It is
-- an index, not a billing write; CREATE UNIQUE INDEX fails (and the whole file
-- rolls back) if duplicate per-check Mortgage Ops events already exist.
--
-- Idempotent: safe to run more than once.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'check_billing_events'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%check_intake_item_id%'
      AND indexdef ILIKE '%mortgage_ops_initial%'
      AND indexdef ILIKE '%mortgage_ops_additional_check%'
      AND indexdef NOT ILIKE '%(tenant_id, check_intake_item_id, event_type)%'
      AND indexdef NOT ILIKE '%(check_intake_item_id, event_type)%'
  ) THEN
    RAISE NOTICE 'SQL 84: Mortgage Ops per-check unique already present';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS check_billing_events_one_mortgage_ops_per_check
      ON public.check_billing_events (check_intake_item_id)
      WHERE event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
        AND status IS DISTINCT FROM 'voided'
        AND check_intake_item_id IS NOT NULL;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.mortgage_ops_request_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mortgage_request_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  previous_agent_id uuid,
  reason text NOT NULL,
  from_status text,
  to_status text,
  accepted_at_preserved timestamptz,
  tenant_billing_event_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mortgage_ops_request_audit_request_idx
  ON public.mortgage_ops_request_audit (mortgage_request_id, created_at DESC);

COMMENT ON TABLE public.mortgage_ops_request_audit IS
  'Append-only Mortgage Ops request history. Return-to-queue records previous agent, actor, reason, and preserved tenant billing event.';

CREATE OR REPLACE FUNCTION public.return_mortgage_handling_request_to_queue(
  p_request_id uuid,
  p_reason text
) RETURNS public.mortgage_handling_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_updated public.mortgage_handling_requests%ROWTYPE;
  v_reason text;
  v_event_id uuid;
BEGIN
  IF NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
  END IF;

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.mortgage_agent_compensation_exclusions x
    WHERE x.mortgage_request_id = p_request_id
  ) THEN
    RAISE EXCEPTION 'request_excluded' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_req
  FROM public.mortgage_handling_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_req.status IS DISTINCT FROM 'in_progress'
     OR v_req.completed_at IS NOT NULL
     OR v_req.assigned_employee_id IS NULL
  THEN
    RAISE EXCEPTION 'request_not_returnable' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.mortgage_agent_compensation_entries e
    WHERE e.mortgage_request_id = v_req.id
      AND e.parent_entry_id IS NULL
      AND e.status NOT IN ('voided', 'excluded')
  ) THEN
    RAISE EXCEPTION 'compensation_already_exists' USING ERRCODE = 'P0001';
  END IF;

  SELECT e.id INTO v_event_id
  FROM public.check_billing_events e
  WHERE e.check_intake_item_id = v_req.check_intake_item_id
    AND e.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
  ORDER BY e.created_at
  LIMIT 1;

  UPDATE public.mortgage_handling_requests
     SET assigned_employee_id = NULL,
         status = 'requested',
         updated_at = now()
   WHERE id = v_req.id
     AND status = 'in_progress'
     AND completed_at IS NULL
     AND assigned_employee_id IS NOT NULL
     AND accepted_at IS NOT DISTINCT FROM v_req.accepted_at
  RETURNING * INTO v_updated;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_returnable' USING ERRCODE = 'P0001';
  END IF;

  IF v_updated.accepted_at IS DISTINCT FROM v_req.accepted_at THEN
    RAISE EXCEPTION 'accepted_at_must_be_preserved' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.mortgage_ops_request_audit (
    mortgage_request_id, actor_id, action, previous_agent_id, reason,
    from_status, to_status, accepted_at_preserved, tenant_billing_event_id, payload
  ) VALUES (
    v_updated.id,
    auth.uid(),
    'return_to_queue',
    v_req.assigned_employee_id,
    v_reason,
    v_req.status,
    v_updated.status,
    v_updated.accepted_at,
    v_event_id,
    jsonb_build_object(
      'check_intake_item_id', v_req.check_intake_item_id,
      'claim_id', v_req.claim_id,
      'tenant_id', v_req.tenant_id
    )
  );

  INSERT INTO public.mortgage_agent_compensation_audit (
    actor_id, action, payload
  ) VALUES (
    auth.uid(),
    'return_to_queue',
    jsonb_build_object(
      'mortgage_request_id', v_updated.id,
      'previous_agent_id', v_req.assigned_employee_id,
      'reason', v_reason,
      'accepted_at_preserved', v_updated.accepted_at,
      'tenant_billing_event_id', v_event_id
    )
  );

  RETURN v_updated;
END;
$$;

COMMENT ON FUNCTION public.return_mortgage_handling_request_to_queue(uuid, text) IS
  'Platform-owner-only Return to Queue. Clears assignee, sets requested, preserves accepted_at and the original tenant billing event. Admins, tenant roles and agents denied. No A-to-B assignment.';

ALTER TABLE public.mortgage_ops_request_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aws_select_mortgage_ops_request_audit ON public.mortgage_ops_request_audit;
CREATE POLICY aws_select_mortgage_ops_request_audit ON public.mortgage_ops_request_audit
  FOR SELECT TO checksops, authenticated
  USING (COALESCE(public.is_platform_owner(), false));

GRANT SELECT ON TABLE public.mortgage_ops_request_audit TO checksops, authenticated;
REVOKE ALL ON FUNCTION public.return_mortgage_handling_request_to_queue(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.return_mortgage_handling_request_to_queue(uuid, text)
  TO checksops, authenticated;
