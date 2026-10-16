-- AWS: Mortgage Agent compensation is platform owner only (SQL 86).
-- Forward migration on top of the Mortgage Agent compensation ledger (Cursor
-- SQL 47, aws/isolated/mortgage-agent-compensation/sql/
-- 47_mortgage_agent_compensation.sql, sha256 bdbdccbc...). Does NOT rewrite or
-- reapply SQL 47. Refuses to run (55000 sql47_prerequisite_missing) when the
-- SQL 47 objects it changes are absent. Independent of SQL 84/85.
--
-- 1) public.aws_can_admin_mortgage_agent_compensation() keeps SQL 47's
--    signature, return type, LANGUAGE sql, STABLE, SECURITY DEFINER,
--    search_path and row_security, but now returns
--    COALESCE(public.is_platform_owner(), false). SQL 47's version also
--    admitted any global user_roles 'admin' (and is_master_owner(), today an
--    alias of is_platform_owner()). Its callers, all in SQL 47 and all
--    Mortgage Agent compensation administration:
--      set_mortgage_agent_account_status, approve_mortgage_agent_compensation,
--      mark_mortgage_agent_compensation_paid, and the SELECT policies on
--      mortgage_agent_accounts, mortgage_agent_compensation_rates,
--      mortgage_agent_compensation_exclusions, mortgage_agent_compensation_entries,
--      mortgage_agent_compensation_batches and mortgage_agent_compensation_audit.
--    No Lambda code and no other SQL on main calls it. The Lambda
--    (mortgage-agent-compensation.mjs) already refuses everyone but the
--    platform owner. aws_is_active_mortgage_agent() (the Accept trigger) is
--    SECURITY DEFINER with row_security off, so Mortgage Agents' Accept does
--    not depend on the mortgage_agent_accounts policy.
--
-- 2) public.earn_mortgage_agent_compensation(uuid) had EXECUTE for PUBLIC,
--    checksops and authenticated and no caller check. Its only caller is the
--    SQL 47 completion trigger function tg_earn_mortgage_agent_compensation()
--    (SECURITY DEFINER), which runs it with its owner's privileges, so
--    EXECUTE is revoked from PUBLIC, checksops and authenticated and granted
--    explicitly to the owner. The function body is unchanged; Complete still
--    earns. Guard (55000 earn_owner_unsafe): both functions must have the
--    same owner, and that owner must not be checksops or authenticated nor a
--    member of either (a superuser owner is accepted: privilege checks do not
--    apply to it). Otherwise the revoke could take EXECUTE away from the
--    trigger and every Complete would fail with 42501.
--
-- 3) public.mortgage_agent_compensation_reconciliation(text) did not call the
--    helper (SECURITY DEFINER, no caller check, EXECUTE for checksops and
--    authenticated). It keeps its signature, RETURNS TABLE, STABLE, SECURITY
--    DEFINER, search_path, row_security and query, now in plpgsql so it can
--    first refuse with not_authorized (42501) unless
--    aws_can_admin_mortgage_agent_compensation(), like SQL 47's other admin
--    functions. #variable_conflict use_column keeps the query's column
--    references meaning what they meant in the SQL 47 sql-language body.
--
-- No table, column, row, rate, billing or payment change.
--
-- Transactions: like main's other aws/workflows/sql files this has no
-- BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once.

DO $$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.mortgage_agent_compensation_entries', to_regclass('public.mortgage_agent_compensation_entries')::oid),
      ('public.aws_can_admin_mortgage_agent_compensation()', to_regprocedure('public.aws_can_admin_mortgage_agent_compensation()')::oid),
      ('public.earn_mortgage_agent_compensation(uuid)', to_regprocedure('public.earn_mortgage_agent_compensation(uuid)')::oid),
      ('public.tg_earn_mortgage_agent_compensation()', to_regprocedure('public.tg_earn_mortgage_agent_compensation()')::oid),
      ('public.mortgage_agent_compensation_reconciliation(text)', to_regprocedure('public.mortgage_agent_compensation_reconciliation(text)')::oid),
      ('role checksops', (SELECT oid FROM pg_roles WHERE rolname = 'checksops')),
      ('role authenticated', (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')),
      ('public.is_platform_owner()', to_regprocedure('public.is_platform_owner()')::oid)
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql47_prerequisite_missing: SQL 86 needs SQL 47 (and the identity helpers) applied first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.aws_can_admin_mortgage_agent_compensation()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT COALESCE(public.is_platform_owner(), false);
$$;

COMMENT ON FUNCTION public.aws_can_admin_mortgage_agent_compensation() IS
  'Mortgage Agent compensation administration: platform owner only (SQL 86). Global admin, staff, tenant roles and Mortgage Agents are refused.';

CREATE OR REPLACE FUNCTION public.mortgage_agent_compensation_reconciliation(
  p_pay_period text DEFAULT NULL
)
RETURNS TABLE (
  anomaly_type text,
  mortgage_request_id uuid,
  compensation_entry_id uuid,
  tenant_billing_event_id uuid,
  detail jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.aws_can_admin_mortgage_agent_compensation() THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    WITH completed AS (
      SELECT r.*
      FROM public.mortgage_handling_requests r
      WHERE r.status = 'completed'
        AND r.completed_at IS NOT NULL
        AND r.assigned_employee_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.mortgage_agent_compensation_exclusions x
          WHERE x.mortgage_request_id = r.id
        )
        AND (
          p_pay_period IS NULL
          OR to_char(timezone('UTC', r.completed_at), 'YYYY-MM') = p_pay_period
        )
    ),
    live_pay AS (
      SELECT e.*
      FROM public.mortgage_agent_compensation_entries e
      WHERE e.parent_entry_id IS NULL
        AND e.status NOT IN ('voided', 'excluded')
        AND (p_pay_period IS NULL OR e.pay_period = p_pay_period)
    ),
    billing AS (
      SELECT e.id, e.check_intake_item_id, e.mortgage_request_id, e.event_type,
             e.unit_price_cents, e.status
      FROM public.check_billing_events e
      WHERE e.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
    )
    SELECT
      'completed_without_compensation'::text,
      c.id,
      NULL::uuid,
      NULL::uuid,
      jsonb_build_object('assigned_employee_id', c.assigned_employee_id, 'completed_at', c.completed_at)
    FROM completed c
    WHERE NOT EXISTS (SELECT 1 FROM live_pay p WHERE p.mortgage_request_id = c.id)

    UNION ALL
    SELECT
      'compensation_without_request',
      p.mortgage_request_id,
      p.id,
      p.tenant_billing_event_id,
      jsonb_build_object('status', p.status, 'amount_cents', p.amount_cents)
    FROM live_pay p
    WHERE NOT EXISTS (SELECT 1 FROM public.mortgage_handling_requests r WHERE r.id = p.mortgage_request_id)

    UNION ALL
    SELECT
      'expected_tenant_billing_missing',
      c.id,
      p.id,
      NULL::uuid,
      jsonb_build_object('accepted_at', c.accepted_at)
    FROM completed c
    LEFT JOIN live_pay p ON p.mortgage_request_id = c.id
    WHERE c.accepted_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM billing b
        WHERE b.mortgage_request_id = c.id
           OR b.check_intake_item_id IS NOT DISTINCT FROM c.check_intake_item_id
      )

    UNION ALL
    SELECT
      'duplicate_tenant_billing',
      c.id,
      p.id,
      NULL::uuid,
      jsonb_build_object('billing_count', (
        SELECT count(*) FROM billing b
        WHERE b.mortgage_request_id = c.id
           OR b.check_intake_item_id IS NOT DISTINCT FROM c.check_intake_item_id
      ))
    FROM completed c
    LEFT JOIN live_pay p ON p.mortgage_request_id = c.id
    WHERE (
      SELECT count(*) FROM billing b
      WHERE b.mortgage_request_id = c.id
         OR b.check_intake_item_id IS NOT DISTINCT FROM c.check_intake_item_id
    ) > 1

    UNION ALL
    SELECT
      'duplicate_compensation',
      p.mortgage_request_id,
      p.id,
      p.tenant_billing_event_id,
      jsonb_build_object('live_count', x.n)
    FROM live_pay p
    JOIN (
      SELECT mortgage_request_id, count(*)::int AS n
      FROM live_pay
      GROUP BY 1
      HAVING count(*) > 1
    ) x ON x.mortgage_request_id = p.mortgage_request_id

    UNION ALL
    SELECT
      'classification_mismatch',
      p.mortgage_request_id,
      p.id,
      p.tenant_billing_event_id,
      jsonb_build_object(
        'agent_classification', p.classification,
        'tenant_event_type', p.tenant_billing_event_type
      )
    FROM live_pay p
    WHERE p.tenant_billing_event_type IS NOT NULL
      AND (
        (p.classification = 'initial' AND p.tenant_billing_event_type IS DISTINCT FROM 'mortgage_ops_initial')
        OR (p.classification = 'additional' AND p.tenant_billing_event_type IS DISTINCT FROM 'mortgage_ops_additional_check')
      )

    UNION ALL
    SELECT
      'amount_mismatch',
      p.mortgage_request_id,
      p.id,
      p.tenant_billing_event_id,
      jsonb_build_object(
        'agent_amount_cents', p.amount_cents,
        'tenant_amount_cents', p.tenant_billing_amount_cents
      )
    FROM live_pay p
    WHERE p.tenant_billing_amount_cents IS NOT NULL
      AND p.tenant_billing_amount_cents <> 0
      AND p.tenant_billing_amount_cents IS DISTINCT FROM p.amount_cents;
END;
$$;

COMMENT ON FUNCTION public.mortgage_agent_compensation_reconciliation(text) IS
  'Flag-only tenant receivable vs agent payable anomalies, platform owner only (SQL 86). A legitimate tenant $0 promotional charge is not an amount mismatch.';

DO $$
DECLARE
  v_earn_owner oid;
  v_tg_owner oid;
  v_owner name;
  v_super boolean;
BEGIN
  SELECT p.proowner INTO v_earn_owner FROM pg_proc p
   WHERE p.oid = 'public.earn_mortgage_agent_compensation(uuid)'::regprocedure;
  SELECT p.proowner INTO v_tg_owner FROM pg_proc p
   WHERE p.oid = 'public.tg_earn_mortgage_agent_compensation()'::regprocedure;
  SELECT r.rolname, r.rolsuper INTO v_owner, v_super FROM pg_roles r WHERE r.oid = v_earn_owner;
  IF v_earn_owner IS DISTINCT FROM v_tg_owner THEN
    RAISE EXCEPTION 'earn_owner_unsafe: earn_mortgage_agent_compensation (owner %) and tg_earn_mortgage_agent_compensation (owner %) must have the same owner before SQL 86 revokes EXECUTE',
      v_owner, (SELECT rolname FROM pg_roles WHERE oid = v_tg_owner)
      USING ERRCODE = '55000';
  END IF;
  IF v_owner IN ('checksops', 'authenticated')
     OR (NOT v_super AND (pg_has_role(v_earn_owner, 'checksops', 'MEMBER')
                          OR pg_has_role(v_earn_owner, 'authenticated', 'MEMBER')))
  THEN
    RAISE EXCEPTION 'earn_owner_unsafe: earn_mortgage_agent_compensation owner % is or belongs to checksops/authenticated; SQL 86 would revoke the completion trigger''s EXECUTE',
      v_owner
      USING ERRCODE = '55000';
  END IF;

  REVOKE ALL ON FUNCTION public.earn_mortgage_agent_compensation(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.earn_mortgage_agent_compensation(uuid) FROM checksops;
  REVOKE ALL ON FUNCTION public.earn_mortgage_agent_compensation(uuid) FROM authenticated;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.earn_mortgage_agent_compensation(uuid) TO %I', v_owner);
END
$$;
