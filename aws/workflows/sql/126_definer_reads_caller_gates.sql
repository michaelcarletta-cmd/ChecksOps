-- SQL 126: the Supabase-era SECURITY DEFINER reads check their caller inside the
-- database (security audit 2026-10-29, finding 4, database part).
--
-- Why: these functions were restored onto the AWS databases from the supabase
-- migrations named below. They let in any caller holding a global user_roles admin or
-- staff role, and every tenant admin holds user_roles admin (aws/rls/FINAL_POLICY_SET.md),
-- so a tenant admin could read every tenant: every check (safety net, stuck checks), the
-- deposit KPIs, another tenant's dashboard counts, usage, users and emails, any check's
-- claim settlement, another user's permissions, and the unread counts of every tenant's
-- check threads. PR #1379 gates them in the API (aws/functions/api/data.mjs
-- RPC_ACCESS_GATES); this file puts the same rule inside each function, so a path around
-- the API gate (another route, a later code change) still cannot read across tenants.
--
-- 1) Thirteen functions replaced with the same name, argument names and types, defaults,
--    result, language, volatility, SECURITY DEFINER and search_path (public). Each body is
--    the supabase body with only the caller gate (or the row scoping) changed:
--      a. platform owner only (public.is_platform_owner(); was user_roles admin or staff),
--         42501 otherwise: get_all_checks_safety_net() (20260502114110),
--         get_deposit_ops_kpis() and get_deposit_exception_kpis() (20260308181449),
--         get_deposit_aging_summary() (20260308173238);
--      b. get_stuck_checks() (20260502114110): the platform owner reads every tenant's stuck
--         checks; a user_roles admin or staff only the checks of their own tenants
--         (aws_user_tenant_ids()); anyone else 42501 as before. Check reconciliation
--         (aws/functions/api/check-reconciliation.mjs) calls it for a tenant admin and
--         already keeps only that tenant's rows, so what it shows does not change;
--      c. a member of the tenant or the platform owner (public.aws_can_access_tenant
--         (_tenant_id); was also any user_roles admin or staff, for every tenant), 42501
--         otherwise: get_check_dashboard_counts_for_tenant(uuid) (20260422135931),
--         get_loss_draft_dashboard_counts_for_tenant(uuid) (20260603174139),
--         get_tenant_check_usage(uuid, timestamptz, timestamptz) (20260820191520); the same
--         rule, no rows or false otherwise (LANGUAGE sql, as before):
--         get_tenant_users_with_profiles(uuid) (20260423231349),
--         is_checkalt_enabled_for_tenant(uuid) (20260626191752);
--      d. get_check_claim_settlement(uuid) (20260608105612): a member of the check's tenant,
--         a member of an active share target (the partner) or the platform owner (was also
--         any user_roles admin or staff); NULL otherwise, as before;
--      e. has_permission(uuid, text) (20260106133153): the caller's own user id, or the
--         platform owner; 42501 otherwise;
--      f. get_check_unread_counts() (20260502121539): only the checks whose messages the
--         caller may read (public.aws_can_access_check, the check_messages read rule: the
--         check's tenant, an active share target, the platform owner); was every check.
--         get_total_unread_check_messages() sums it and is not changed.
-- 2) EXECUTE on the thirteen: revoked from PUBLIC and from anon, authenticated and
--    service_role where those roles exist; granted to checksops (the API login). The owner
--    keeps its own. No other grant.
--
-- Not changed: get_tenant_funds_received, get_check_stage_totals and
-- aws_tenant_referral_summary (they already allow only tenant members, or members and the
-- platform owner), get_total_unread_check_messages, any table, column, view, policy,
-- trigger, grant on a table, or row.
-- Refuses to run (55000 sql126_prerequisite_missing) without the thirteen functions, the
-- helpers they call and the relations they read.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql126_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.get_all_checks_safety_net()', to_regprocedure('public.get_all_checks_safety_net()')::oid),
      ('public.get_stuck_checks()', to_regprocedure('public.get_stuck_checks()')::oid),
      ('public.get_deposit_ops_kpis()', to_regprocedure('public.get_deposit_ops_kpis()')::oid),
      ('public.get_deposit_exception_kpis()', to_regprocedure('public.get_deposit_exception_kpis()')::oid),
      ('public.get_deposit_aging_summary()', to_regprocedure('public.get_deposit_aging_summary()')::oid),
      ('public.get_check_dashboard_counts_for_tenant(uuid)', to_regprocedure('public.get_check_dashboard_counts_for_tenant(uuid)')::oid),
      ('public.get_loss_draft_dashboard_counts_for_tenant(uuid)', to_regprocedure('public.get_loss_draft_dashboard_counts_for_tenant(uuid)')::oid),
      ('public.get_tenant_check_usage(uuid, timestamp with time zone, timestamp with time zone)', to_regprocedure('public.get_tenant_check_usage(uuid, timestamp with time zone, timestamp with time zone)')::oid),
      ('public.get_tenant_users_with_profiles(uuid)', to_regprocedure('public.get_tenant_users_with_profiles(uuid)')::oid),
      ('public.is_checkalt_enabled_for_tenant(uuid)', to_regprocedure('public.is_checkalt_enabled_for_tenant(uuid)')::oid),
      ('public.get_check_claim_settlement(uuid)', to_regprocedure('public.get_check_claim_settlement(uuid)')::oid),
      ('public.has_permission(uuid, text)', to_regprocedure('public.has_permission(uuid, text)')::oid),
      ('public.get_check_unread_counts()', to_regprocedure('public.get_check_unread_counts()')::oid),
      ('auth.uid()', to_regprocedure('auth.uid()')::oid),
      ('public.is_platform_owner()', to_regprocedure('public.is_platform_owner()')::oid),
      ('public.aws_can_access_tenant(uuid)', to_regprocedure('public.aws_can_access_tenant(uuid)')::oid),
      ('public.aws_can_access_check(uuid)', to_regprocedure('public.aws_can_access_check(uuid)')::oid),
      ('public.aws_user_tenant_ids()', to_regprocedure('public.aws_user_tenant_ids()')::oid),
      ('public.has_role(uuid, public.app_role)', to_regprocedure('public.has_role(uuid, public.app_role)')::oid),
      ('public.user_belongs_to_tenant(uuid, uuid)', to_regprocedure('public.user_belongs_to_tenant(uuid, uuid)')::oid),
      ('public.check_intake_items', to_regclass('public.check_intake_items')::oid),
      ('public.check_status_audit', to_regclass('public.check_status_audit')::oid),
      ('public.loss_draft_tracking', to_regclass('public.loss_draft_tracking')::oid),
      ('public.loss_draft_documents', to_regclass('public.loss_draft_documents')::oid),
      ('public.shared_checks', to_regclass('public.shared_checks')::oid),
      ('public.tenants', to_regclass('public.tenants')::oid),
      ('public.tenant_users', to_regclass('public.tenant_users')::oid),
      ('public.profiles', to_regclass('public.profiles')::oid),
      ('public.user_roles', to_regclass('public.user_roles')::oid),
      ('public.check_billing_events', to_regclass('public.check_billing_events')::oid),
      ('public.mortgage_handling_requests', to_regclass('public.mortgage_handling_requests')::oid),
      ('public.checkalt_config', to_regclass('public.checkalt_config')::oid),
      ('public.checkalt_tenant_accounts', to_regclass('public.checkalt_tenant_accounts')::oid),
      ('public.claims', to_regclass('public.claims')::oid),
      ('public.claim_settlements', to_regclass('public.claim_settlements')::oid),
      ('public.check_messages', to_regclass('public.check_messages')::oid),
      ('public.check_message_reads', to_regclass('public.check_message_reads')::oid),
      ('public.deposit_ops_kpis', to_regclass('public.deposit_ops_kpis')::oid),
      ('public.deposit_exception_kpis', to_regclass('public.deposit_exception_kpis')::oid),
      ('public.deposit_aging_summary', to_regclass('public.deposit_aging_summary')::oid)
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'checksops') THEN
    v_missing := ARRAY['role checksops'];
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql126_prerequisite_missing: SQL 126 needs %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$sql126_prereq$;

-- 1) The thirteen functions, each as its supabase migration defines it but for the gate.

-- public.get_all_checks_safety_net()
CREATE OR REPLACE FUNCTION public.get_all_checks_safety_net()
RETURNS TABLE (
  id uuid, claim_id uuid, status text, amount numeric, check_number text,
  carrier_name text, payee_line text, front_image_path text, back_image_path text,
  created_at timestamptz, updated_at timestamptz, has_loss_draft boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- SQL 126 (finding 4): the platform owner only; was any global user_roles admin or staff.
  IF NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT c.id, c.claim_id, c.status, c.amount, c.check_number,
         c.carrier_name, c.payee_line, c.front_image_path, c.back_image_path,
         c.created_at, c.updated_at,
         EXISTS(SELECT 1 FROM public.loss_draft_tracking ld WHERE ld.check_intake_item_id = c.id)
  FROM public.check_intake_items c
  ORDER BY c.created_at DESC;
END;
$$;

-- public.get_stuck_checks()
CREATE OR REPLACE FUNCTION public.get_stuck_checks()
RETURNS TABLE (
  id uuid, claim_id uuid, status text, amount numeric,
  carrier_name text, payee_line text, created_at timestamptz, updated_at timestamptz,
  hours_in_status numeric, sla_hours int, is_overdue boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner boolean;
BEGIN
  -- SQL 126 (finding 4): the platform owner reads every tenant's stuck checks; a user_roles
  -- admin or staff (a tenant admin holds user_roles admin) only those of their own tenants
  -- (check reconciliation, aws/functions/api/check-reconciliation.mjs, already keeps only those).
  v_owner := COALESCE(public.is_platform_owner(), false);
  IF NOT (v_owner OR public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role)) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH last_change AS (
    SELECT check_intake_item_id, MAX(changed_at) AS last_changed_at
    FROM public.check_status_audit GROUP BY check_intake_item_id
  ),
  sla AS (
    SELECT * FROM (VALUES
      ('uploaded', 24),
      ('needs_review', 48),
      ('endorsing', 72),
      ('approved_for_deposit', 24),
      ('loss_draft_required', 168),
      ('branch_deposit_required', 48),
      ('deposited', 168)
    ) AS s(status, sla_hours)
  )
  SELECT c.id, c.claim_id, c.status, c.amount, c.carrier_name, c.payee_line,
         c.created_at, c.updated_at,
         EXTRACT(EPOCH FROM (now() - COALESCE(lc.last_changed_at, c.created_at))) / 3600.0,
         sla.sla_hours,
         (EXTRACT(EPOCH FROM (now() - COALESCE(lc.last_changed_at, c.created_at))) / 3600.0) > sla.sla_hours
  FROM public.check_intake_items c
  LEFT JOIN last_change lc ON lc.check_intake_item_id = c.id
  JOIN sla ON sla.status = c.status
  WHERE v_owner OR c.tenant_id IN (SELECT public.aws_user_tenant_ids())
  ORDER BY EXTRACT(EPOCH FROM (now() - COALESCE(lc.last_changed_at, c.created_at))) DESC;
END;
$$;

-- public.get_deposit_ops_kpis()
CREATE OR REPLACE FUNCTION public.get_deposit_ops_kpis()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT COALESCE(public.is_platform_owner(), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  SELECT row_to_json(k.*) INTO result FROM deposit_ops_kpis k;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

-- public.get_deposit_exception_kpis()
CREATE OR REPLACE FUNCTION public.get_deposit_exception_kpis()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT COALESCE(public.is_platform_owner(), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  SELECT row_to_json(k.*) INTO result FROM deposit_exception_kpis k;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

-- public.get_deposit_aging_summary()
CREATE OR REPLACE FUNCTION public.get_deposit_aging_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT COALESCE(public.is_platform_owner(), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  SELECT row_to_json(s.*) INTO result FROM deposit_aging_summary s;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

-- public.get_check_dashboard_counts_for_tenant(uuid)
CREATE OR REPLACE FUNCTION public.get_check_dashboard_counts_for_tenant(_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE result jsonb;
BEGIN
  -- SQL 126 (finding 4): tenant members and the platform owner; was also any global
  -- user_roles admin or staff, for every tenant.
  IF NOT COALESCE(public.aws_can_access_tenant(_tenant_id), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'manual_review', COUNT(*) FILTER (WHERE status IN ('needs_review','manual_review_required','endorsements_complete') OR ocr_status = 'failed'),
    'branch_deposit', COUNT(*) FILTER (WHERE status = 'branch_deposit_required'),
    'reissue_requested', COUNT(*) FILTER (WHERE status = 'reissue_requested'),
    'approved_for_deposit', COUNT(*) FILTER (WHERE status = 'approved_for_deposit'),
    'total_deposited', COUNT(*) FILTER (WHERE status = 'deposited'),
    'total_deposited_value', COALESCE(SUM(amount) FILTER (WHERE status = 'deposited'), 0),
    'total_checks', COUNT(*)
  ) INTO result
  FROM check_intake_items
  WHERE tenant_id = _tenant_id;

  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

-- public.get_loss_draft_dashboard_counts_for_tenant(uuid)
CREATE OR REPLACE FUNCTION public.get_loss_draft_dashboard_counts_for_tenant(_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE result jsonb;
BEGIN
  -- SQL 126 (finding 4): tenant members and the platform owner; was also any global
  -- user_roles admin or staff, for every tenant.
  IF NOT COALESCE(public.aws_can_access_tenant(_tenant_id), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  WITH auth_tenants AS (
    -- The tenant being queried
    SELECT _tenant_id AS tenant_id
  ),
  scoped AS (
    SELECT ld.*, 
      ci.status AS check_status,
      auth_t.tenant_id as resolved_tenant_id
    FROM public.loss_draft_tracking ld
    LEFT JOIN public.check_intake_items ci ON ci.id = ld.check_intake_item_id
    CROSS JOIN LATERAL (
       -- Either the original owner matches
       SELECT COALESCE(ci.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)) AS tenant_id
       UNION
       -- Or it was shared with this tenant
       SELECT sc.target_tenant_id FROM public.shared_checks sc WHERE sc.check_id = ci.id AND sc.revoked_at IS NULL
    ) auth_t
    WHERE auth_t.tenant_id = _tenant_id
      AND NOT (
        ld.escrow_status = 'endorsing'
        OR (
          ld.monitoring_type = 'not_monitored'
          AND ci.status IN ('endorsements_in_progress', 'approved_for_deposit', 'deposited')
        )
      )
  )
  SELECT jsonb_build_object(
    'total_active',             COUNT(*) FILTER (WHERE escrow_status NOT IN ('final_release_complete')),
    'pending_send',             COUNT(*) FILTER (WHERE escrow_status = 'pending_send'),
    'escrowed',                 COUNT(*) FILTER (WHERE escrow_status = 'escrowed'),
    'draw_requested',           COUNT(*) FILTER (WHERE escrow_status = 'first_draw_requested'),
    'partial_release',          COUNT(*) FILTER (WHERE escrow_status = 'partial_release'),
    'final_complete',           COUNT(*) FILTER (WHERE escrow_status = 'final_release_complete'),
    'total_unreleased',         COALESCE(SUM(total_escrowed - draw_amount_released) FILTER (WHERE escrow_status NOT IN ('final_release_complete')), 0),
    'stale_count',              COUNT(*) FILTER (WHERE last_contact_at < now() - interval '14 days' AND escrow_status NOT IN ('final_release_complete','pending_send')),
    'overdue_followup',         COUNT(*) FILTER (WHERE follow_up_date < CURRENT_DATE AND escrow_status NOT IN ('final_release_complete')),
    'checks_blocked_in_lender', (
      SELECT COUNT(*) 
      FROM public.check_intake_items ci_inner
      LEFT JOIN auth_tenants at ON true
      WHERE ci_inner.status = 'loss_draft_required' 
        AND (
          ci_inner.tenant_id = at.tenant_id
          OR EXISTS (
            SELECT 1 FROM public.shared_checks sc 
            WHERE sc.check_id = ci_inner.id 
              AND sc.target_tenant_id = at.tenant_id 
              AND sc.revoked_at IS NULL
          )
        )
    ),
    'checks_awaiting_docs',     (
      SELECT COUNT(DISTINCT lt2.id)
      FROM public.loss_draft_tracking lt2
      LEFT JOIN public.check_intake_items ci2 ON ci2.id = lt2.check_intake_item_id
      JOIN public.loss_draft_documents ldd ON ldd.loss_draft_id = lt2.id
      CROSS JOIN LATERAL (
        SELECT COALESCE(ci2.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)) AS t_id
        UNION
        SELECT sc2.target_tenant_id FROM public.shared_checks sc2 WHERE sc2.check_id = ci2.id AND sc2.revoked_at IS NULL
      ) auth_t2
      WHERE lt2.escrow_status NOT IN ('final_release_complete','endorsing')
        AND NOT (lt2.monitoring_type = 'not_monitored' AND ci2.status IN ('endorsements_in_progress', 'approved_for_deposit', 'deposited'))
        AND ldd.is_required = true
        AND ldd.is_submitted = false
        AND auth_t2.t_id = _tenant_id
    ),
    'checks_ready_for_release', (
      SELECT COUNT(*) FROM public.loss_draft_tracking lt3
      LEFT JOIN public.check_intake_items ci3 ON ci3.id = lt3.check_intake_item_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(ci3.tenant_id, (SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1)) AS t_id
        UNION
        SELECT sc3.target_tenant_id FROM public.shared_checks sc3 WHERE sc3.check_id = ci3.id AND sc3.revoked_at IS NULL
      ) auth_t3
      WHERE lt3.escrow_status NOT IN ('final_release_complete','endorsing')
        AND NOT (lt3.monitoring_type = 'not_monitored' AND ci3.status IN ('endorsements_in_progress', 'approved_for_deposit', 'deposited'))
        AND auth_t3.t_id = _tenant_id
        AND NOT EXISTS (
          SELECT 1 FROM public.loss_draft_documents ldd2
          WHERE ldd2.loss_draft_id = lt3.id
            AND ldd2.is_required = true
            AND ldd2.is_submitted = false
        )
    )
  ) INTO result FROM scoped;

  RETURN result;
END;
$$;

-- public.get_tenant_check_usage(uuid, timestamp with time zone, timestamp with time zone)
CREATE OR REPLACE FUNCTION public.get_tenant_check_usage(_tenant_id uuid, _month_start timestamp with time zone DEFAULT date_trunc('month'::text, now()), _month_end timestamp with time zone DEFAULT (date_trunc('month'::text, now()) + '1 mon'::interval))
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_amount_cents bigint;
  v_events jsonb;
  v_mortgage_count integer;
  v_mortgage_amount_cents bigint;
  v_shipping_cents bigint;
BEGIN
  -- SQL 126 (finding 4): tenant members and the platform owner; was also any global
  -- user_roles admin or staff, for every tenant.
  IF NOT COALESCE(public.aws_can_access_tenant(_tenant_id), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*), COALESCE(SUM(unit_price_cents), 0)
    INTO v_count, v_amount_cents
  FROM public.check_billing_events
  WHERE tenant_id = _tenant_id
    AND billed_at >= _month_start
    AND billed_at < _month_end
    AND status <> 'voided';

  SELECT COUNT(*), COALESCE(SUM(flat_fee_cents), 0), COALESCE(SUM(COALESCE(invoice_shipping_cents,0)), 0)
    INTO v_mortgage_count, v_mortgage_amount_cents, v_shipping_cents
  FROM public.mortgage_handling_requests
  WHERE tenant_id = _tenant_id
    AND billed_at >= _month_start
    AND billed_at < _month_end
    AND billing_status = 'billed';

  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'billed_at' DESC), '[]'::jsonb)
  INTO v_events
  FROM (
    SELECT jsonb_build_object(
      'id', e.id,
      'check_intake_item_id', e.check_intake_item_id,
      'billed_at', e.billed_at,
      'unit_price_cents', e.unit_price_cents,
      'currency', e.currency,
      'status', e.status,
      'event_type', e.event_type,
      'check_number', ci.check_number,
      'payee_name', ci.payee_line,
      'processed_by', p.full_name,
      'source', 'check'
    ) as item
    FROM public.check_billing_events e
    LEFT JOIN public.check_intake_items ci ON ci.id = e.check_intake_item_id
    LEFT JOIN public.profiles p ON p.id = ci.uploaded_by
    WHERE e.tenant_id = _tenant_id
      AND e.billed_at >= _month_start
      AND e.billed_at < _month_end
      AND e.status <> 'voided'

    UNION ALL

    SELECT jsonb_build_object(
      'id', m.id,
      'billed_at', m.billed_at,
      'unit_price_cents', m.flat_fee_cents,
      'currency', 'usd',
      'status', 'billed',
      'event_type', 'mortgage_handling',
      'mortgage_company', m.mortgage_company,
      'loan_number', m.loan_number,
      'source', 'mortgage'
    ) as item
    FROM public.mortgage_handling_requests m
    WHERE m.tenant_id = _tenant_id
      AND m.billed_at >= _month_start
      AND m.billed_at < _month_end
      AND m.billing_status = 'billed'

    UNION ALL

    SELECT jsonb_build_object(
      'id', m.id || ':shipping',
      'billed_at', m.billed_at,
      'unit_price_cents', m.invoice_shipping_cents,
      'currency', 'usd',
      'status', 'billed',
      'event_type', 'mortgage_shipping_label',
      'mortgage_company', m.mortgage_company,
      'loan_number', m.loan_number,
      'source', 'mortgage'
    ) as item
    FROM public.mortgage_handling_requests m
    WHERE m.tenant_id = _tenant_id
      AND m.billed_at >= _month_start
      AND m.billed_at < _month_end
      AND m.billing_status = 'billed'
      AND COALESCE(m.invoice_shipping_cents, 0) > 0
  ) sub;

  RETURN jsonb_build_object(
    'count', v_count + v_mortgage_count,
    'amount_cents', v_amount_cents + v_mortgage_amount_cents + v_shipping_cents,
    'currency', 'usd',
    'month_start', _month_start,
    'month_end', _month_end,
    'events', v_events,
    'mortgage_count', v_mortgage_count,
    'mortgage_amount_cents', v_mortgage_amount_cents + v_shipping_cents,
    'mortgage_shipping_cents', v_shipping_cents
  );
END;
$$;

-- public.get_tenant_users_with_profiles(uuid)
CREATE OR REPLACE FUNCTION public.get_tenant_users_with_profiles(_tenant_id uuid)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  role text,
  created_at timestamptz,
  full_name text,
  email text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    tu.id,
    tu.user_id,
    tu.role::text,
    tu.created_at,
    p.full_name,
    p.email
  FROM public.tenant_users tu
  LEFT JOIN public.profiles p ON p.id = tu.user_id
  WHERE tu.tenant_id = _tenant_id
    -- SQL 126 (finding 4): a member of this tenant or the platform owner; was also any
    -- global user_roles admin, for every tenant. No rows otherwise.
    AND COALESCE(public.aws_can_access_tenant(_tenant_id), false)
  ORDER BY tu.created_at ASC;
$$;

-- public.is_checkalt_enabled_for_tenant(uuid)
CREATE OR REPLACE FUNCTION public.is_checkalt_enabled_for_tenant(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE((SELECT default_enabled FROM public.checkalt_config WHERE singleton = true LIMIT 1), false)
    AND EXISTS (
      SELECT 1 FROM public.checkalt_tenant_accounts
      WHERE tenant_id = _tenant_id
        AND enabled = true
        AND registered_at IS NOT NULL
    )
    -- SQL 126 (finding 4): false unless the caller is a member of the tenant or the platform owner.
    AND COALESCE(public.aws_can_access_tenant(_tenant_id), false);
$$;

-- public.get_check_claim_settlement(uuid)
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
  -- SQL 126 (finding 4): the platform owner; was any global user_roles admin or staff.
  ELSIF COALESCE(public.is_platform_owner(), false) THEN
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

-- public.has_permission(uuid, text)
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_role app_role;
BEGIN
  -- SQL 126 (finding 4): the caller's own permissions, or the platform owner's question.
  IF _user_id IS DISTINCT FROM auth.uid() AND NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  -- Get highest role (admin > staff > read_only)
  SELECT role INTO user_role
  FROM public.user_roles
  WHERE user_id = _user_id
  ORDER BY 
    CASE role 
      WHEN 'admin' THEN 1 
      WHEN 'staff' THEN 2 
      WHEN 'read_only' THEN 3 
    END
  LIMIT 1;
  
  IF user_role IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Permission matrix
  CASE _permission
    WHEN 'read' THEN
      RETURN user_role IN ('admin', 'staff', 'read_only');
    WHEN 'create' THEN
      RETURN user_role IN ('admin', 'staff');
    WHEN 'update' THEN
      RETURN user_role IN ('admin', 'staff');
    WHEN 'delete' THEN
      RETURN user_role IN ('admin', 'staff');
    WHEN 'export' THEN
      RETURN user_role IN ('admin', 'staff');
    WHEN 'reveal_pii' THEN
      RETURN user_role IN ('admin', 'staff', 'read_only');
    WHEN 'manage_users' THEN
      RETURN user_role = 'admin';
    WHEN 'view_audit_logs' THEN
      RETURN user_role = 'admin';
    ELSE
      RETURN FALSE;
  END CASE;
END;
$$;

-- public.get_check_unread_counts()
CREATE OR REPLACE FUNCTION public.get_check_unread_counts()
RETURNS TABLE(check_id uuid, unread_count bigint, last_message_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.check_id,
    COUNT(*) FILTER (
      WHERE m.sender_id <> auth.uid()
        AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
    ) AS unread_count,
    MAX(m.created_at) AS last_message_at
  FROM public.check_messages m
  LEFT JOIN public.check_message_reads r
    ON r.check_id = m.check_id AND r.user_id = auth.uid()
  WHERE m.is_deleted = false
  GROUP BY m.check_id
  -- SQL 126 (finding 4): only the checks whose messages the caller may read (the
  -- check_messages read rule, aws_can_access_check); was every tenant's checks.
  HAVING COALESCE(public.aws_can_access_check(m.check_id), false);
$$;

-- 2) EXECUTE: the API login and the owner only.
REVOKE ALL ON FUNCTION public.get_all_checks_safety_net() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_stuck_checks() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_deposit_ops_kpis() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_deposit_exception_kpis() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_deposit_aging_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_check_dashboard_counts_for_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_loss_draft_dashboard_counts_for_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_tenant_check_usage(uuid, timestamp with time zone, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_tenant_users_with_profiles(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_checkalt_enabled_for_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_check_claim_settlement(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_permission(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_check_unread_counts() FROM PUBLIC;

DO $sql126_acl$
DECLARE
  grantee text;
  fn text;
BEGIN
  FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = grantee) THEN
      FOREACH fn IN ARRAY ARRAY[
        'public.get_all_checks_safety_net()',
        'public.get_stuck_checks()',
        'public.get_deposit_ops_kpis()',
        'public.get_deposit_exception_kpis()',
        'public.get_deposit_aging_summary()',
        'public.get_check_dashboard_counts_for_tenant(uuid)',
        'public.get_loss_draft_dashboard_counts_for_tenant(uuid)',
        'public.get_tenant_check_usage(uuid, timestamp with time zone, timestamp with time zone)',
        'public.get_tenant_users_with_profiles(uuid)',
        'public.is_checkalt_enabled_for_tenant(uuid)',
        'public.get_check_claim_settlement(uuid)',
        'public.has_permission(uuid, text)',
        'public.get_check_unread_counts()'
      ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, grantee);
      END LOOP;
    END IF;
  END LOOP;
END
$sql126_acl$;

GRANT EXECUTE ON FUNCTION public.get_all_checks_safety_net() TO checksops;
GRANT EXECUTE ON FUNCTION public.get_stuck_checks() TO checksops;
GRANT EXECUTE ON FUNCTION public.get_deposit_ops_kpis() TO checksops;
GRANT EXECUTE ON FUNCTION public.get_deposit_exception_kpis() TO checksops;
GRANT EXECUTE ON FUNCTION public.get_deposit_aging_summary() TO checksops;
GRANT EXECUTE ON FUNCTION public.get_check_dashboard_counts_for_tenant(uuid) TO checksops;
GRANT EXECUTE ON FUNCTION public.get_loss_draft_dashboard_counts_for_tenant(uuid) TO checksops;
GRANT EXECUTE ON FUNCTION public.get_tenant_check_usage(uuid, timestamp with time zone, timestamp with time zone) TO checksops;
GRANT EXECUTE ON FUNCTION public.get_tenant_users_with_profiles(uuid) TO checksops;
GRANT EXECUTE ON FUNCTION public.is_checkalt_enabled_for_tenant(uuid) TO checksops;
GRANT EXECUTE ON FUNCTION public.get_check_claim_settlement(uuid) TO checksops;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text) TO checksops;
GRANT EXECUTE ON FUNCTION public.get_check_unread_counts() TO checksops;
