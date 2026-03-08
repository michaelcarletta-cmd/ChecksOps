
-- Phase 8: Operational automation, workload balancing, daily digest, manager command center

-- 1) Daily digest table for storing generated summaries
CREATE TABLE public.deposit_daily_digest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  digest_date date NOT NULL DEFAULT CURRENT_DATE,
  digest_type text NOT NULL DEFAULT 'daily', -- daily, weekly, monthly
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by uuid,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  open_exceptions_count int DEFAULT 0,
  sla_breaches_count int DEFAULT 0,
  unreconciled_cash numeric DEFAULT 0,
  unsynced_count int DEFAULT 0,
  closeout_ready_count int DEFAULT 0,
  total_open_items int DEFAULT 0,
  total_open_amount numeric DEFAULT 0,
  owner_workloads jsonb DEFAULT '[]'::jsonb,
  UNIQUE(digest_date, digest_type)
);

ALTER TABLE public.deposit_daily_digest ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can read digests" ON public.deposit_daily_digest FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "System can insert digests" ON public.deposit_daily_digest FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

-- 2) Owner performance view
CREATE OR REPLACE VIEW public.deposit_owner_performance AS
SELECT
  di.owner_id,
  COUNT(*) AS total_assigned,
  COUNT(*) FILTER (WHERE di.closeout_complete) AS total_closed,
  COUNT(*) FILTER (WHERE NOT di.closeout_complete AND di.status NOT IN ('failed','returned')) AS open_items,
  COALESCE(SUM(di.amount) FILTER (WHERE NOT di.closeout_complete), 0) AS open_amount,
  COALESCE(SUM(di.amount) FILTER (WHERE di.closeout_complete), 0) AS closed_amount,
  ROUND(AVG(EXTRACT(EPOCH FROM (di.closeout_at - di.created_at)) / 86400) FILTER (WHERE di.closeout_complete), 1) AS avg_days_to_closeout,
  ROUND(AVG(EXTRACT(EPOCH FROM (di.bank_confirmed_at - di.cleared_at)) / 86400) FILTER (WHERE di.bank_confirmed_at IS NOT NULL), 1) AS avg_days_to_confirm,
  ROUND(AVG(EXTRACT(EPOCH FROM (di.reconciled_at - di.cleared_at)) / 86400) FILTER (WHERE di.reconciled_at IS NOT NULL), 1) AS avg_days_to_reconcile,
  COUNT(*) FILTER (WHERE di.nsf_flag = true) AS nsf_count,
  COUNT(*) FILTER (WHERE di.variance_amount IS NOT NULL AND di.variance_amount != 0) AS variance_count,
  COUNT(*) FILTER (WHERE NOT di.closeout_complete AND di.status = 'succeeded' AND di.cleared_at < now() - interval '2 days') AS sla_breaches
FROM deposit_items di
WHERE di.owner_id IS NOT NULL
GROUP BY di.owner_id;

-- 3) Queue priority scoring view
CREATE OR REPLACE VIEW public.deposit_queue_scored AS
SELECT
  di.id,
  di.check_number,
  di.carrier_name,
  di.amount,
  di.status,
  di.provider,
  di.owner_id,
  di.next_action,
  di.next_action_reason,
  di.created_at,
  di.cleared_at,
  di.bank_confirmed_at,
  di.reconciled_at,
  di.accounting_synced_at,
  di.closeout_complete,
  di.nsf_flag,
  di.variance_amount,
  di.claim_id,
  -- Priority score: higher = more urgent
  (
    -- Amount weight (log scale, max ~20 pts)
    LEAST(20, ROUND(LN(GREATEST(di.amount, 1)) * 3))
    -- Age weight (1 pt per day, max 30)
    + LEAST(30, EXTRACT(DAY FROM now() - di.created_at)::int)
    -- Exception severity (20 pts per open critical, 10 per warning)
    + COALESCE((SELECT SUM(CASE WHEN severity = 'critical' THEN 20 ELSE 10 END) FROM deposit_exceptions de WHERE de.deposit_item_id = di.id AND de.resolved_at IS NULL), 0)
    -- SLA breach bonus
    + CASE WHEN di.status IN ('succeeded','provider_assigned','pending_assignment') AND di.cleared_at < now() - interval '2 days' THEN 15 ELSE 0 END
    + CASE WHEN di.status = 'succeeded' AND di.bank_confirmed_at IS NULL AND di.cleared_at < now() - interval '3 days' THEN 15 ELSE 0 END
  )::int AS priority_score,
  (SELECT COUNT(*) FROM deposit_exceptions de2 WHERE de2.deposit_item_id = di.id AND de2.resolved_at IS NULL) AS open_exception_count
FROM deposit_items di
WHERE NOT di.closeout_complete AND di.status NOT IN ('failed','returned');

-- 4) Manager rollup view by period
CREATE OR REPLACE VIEW public.deposit_manager_rollup AS
SELECT
  date_trunc('day', di.created_at)::date AS period_date,
  COUNT(*) AS items_created,
  COUNT(*) FILTER (WHERE di.closeout_complete) AS items_closed,
  COALESCE(SUM(di.amount), 0) AS total_amount,
  COALESCE(SUM(di.amount) FILTER (WHERE di.closeout_complete), 0) AS closed_amount,
  COUNT(*) FILTER (WHERE di.nsf_flag = true) AS nsf_count,
  COUNT(*) FILTER (WHERE di.variance_amount IS NOT NULL AND di.variance_amount != 0) AS variance_count,
  COUNT(DISTINCT di.owner_id) AS active_owners
FROM deposit_items di
GROUP BY date_trunc('day', di.created_at)::date;

-- 5) RPC: refresh_all_deposit_next_actions
CREATE OR REPLACE FUNCTION public.refresh_all_deposit_next_actions(p_actor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item record;
  v_count int := 0;
  v_action text;
  v_reason text;
  v_open_exc int;
  v_has_slip boolean;
  v_has_receipt boolean;
  v_has_bank_doc boolean;
BEGIN
  FOR v_item IN
    SELECT * FROM deposit_items WHERE NOT closeout_complete AND status NOT IN ('failed','returned')
  LOOP
    v_action := NULL;
    v_reason := NULL;
    
    SELECT COUNT(*) INTO v_open_exc FROM deposit_exceptions WHERE deposit_item_id = v_item.id AND resolved_at IS NULL;
    SELECT EXISTS(SELECT 1 FROM deposit_attachments WHERE deposit_item_id = v_item.id AND attachment_type = 'deposit_slip') INTO v_has_slip;
    SELECT EXISTS(SELECT 1 FROM deposit_attachments WHERE deposit_item_id = v_item.id AND attachment_type = 'stamped_receipt') INTO v_has_receipt;
    SELECT EXISTS(SELECT 1 FROM deposit_attachments WHERE deposit_item_id = v_item.id AND attachment_type = 'bank_confirmation') INTO v_has_bank_doc;
    
    IF v_open_exc > 0 THEN
      v_action := 'resolve_exceptions';
      v_reason := format('%s open exception(s)', v_open_exc);
    ELSIF v_item.status = 'pending_assignment' THEN
      v_action := 'assign_provider';
      v_reason := 'Needs deposit route assignment';
    ELSIF v_item.status = 'provider_assigned' THEN
      v_action := 'mark_deposited';
      v_reason := 'Ready for deposit confirmation';
    ELSIF v_item.status = 'succeeded' AND NOT v_has_slip THEN
      v_action := 'upload_deposit_slip';
      v_reason := 'Missing deposit slip';
    ELSIF v_item.status = 'succeeded' AND v_item.bank_confirmed_at IS NULL THEN
      v_action := 'bank_confirm';
      v_reason := 'Awaiting bank confirmation';
    ELSIF v_item.status = 'succeeded' AND v_item.reconciled_at IS NULL THEN
      v_action := 'reconcile';
      v_reason := 'Deposit succeeded, needs reconciliation';
    ELSIF v_item.status = 'reconciled' AND v_item.accounting_synced_at IS NULL THEN
      v_action := 'sync_accounting';
      v_reason := 'Reconciled but not synced to accounting';
    ELSIF v_item.status = 'reconciled' AND v_item.accounting_synced_at IS NOT NULL AND v_open_exc = 0 THEN
      v_action := 'closeout';
      v_reason := 'All requirements met, ready for closeout';
    ELSE
      v_action := 'review';
      v_reason := 'Manual review needed';
    END IF;
    
    UPDATE deposit_items SET next_action = v_action, next_action_reason = v_reason, updated_at = now() WHERE id = v_item.id;
    v_count := v_count + 1;
  END LOOP;
  
  RETURN jsonb_build_object('success', true, 'refreshed', v_count);
END;
$$;

-- 6) RPC: rebalance_deposit_workload
CREATE OR REPLACE FUNCTION public.rebalance_deposit_workload(p_actor_id uuid, p_max_per_owner int DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_staff uuid[];
  v_unassigned uuid[];
  v_overloaded record;
  v_idx int := 0;
  v_reassigned int := 0;
  v_staff_count int;
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Get all staff/admin user IDs
  SELECT array_agg(DISTINCT user_id) INTO v_staff FROM user_roles WHERE role IN ('staff', 'admin');
  v_staff_count := COALESCE(array_length(v_staff, 1), 0);
  IF v_staff_count = 0 THEN RETURN jsonb_build_object('success', false, 'reason', 'no_staff'); END IF;

  -- Get unassigned open items
  SELECT array_agg(id) INTO v_unassigned FROM deposit_items 
  WHERE owner_id IS NULL AND NOT closeout_complete AND status NOT IN ('failed','returned');
  
  IF v_unassigned IS NOT NULL THEN
    FOR v_idx IN 1..array_length(v_unassigned, 1) LOOP
      UPDATE deposit_items SET owner_id = v_staff[((v_idx - 1) % v_staff_count) + 1], owner_assigned_at = now(), updated_at = now()
      WHERE id = v_unassigned[v_idx];
      v_reassigned := v_reassigned + 1;
    END LOOP;
  END IF;

  -- Log
  INSERT INTO deposit_audit_log (action, actor_id, notes, new_values)
  VALUES ('rebalance_workload', p_actor_id, format('Rebalanced %s items across %s staff', v_reassigned, v_staff_count),
    jsonb_build_object('reassigned', v_reassigned, 'staff_count', v_staff_count, 'max_per_owner', p_max_per_owner));

  RETURN jsonb_build_object('success', true, 'reassigned', v_reassigned, 'staff_count', v_staff_count);
END;
$$;

-- 7) RPC: generate_deposit_daily_digest
CREATE OR REPLACE FUNCTION public.generate_deposit_daily_digest(p_actor_id uuid, p_digest_type text DEFAULT 'daily')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_open_exc int;
  v_sla_breaches int;
  v_unrecon_cash numeric;
  v_unsynced int;
  v_closeout_ready int;
  v_total_open int;
  v_total_open_amt numeric;
  v_owner_workloads jsonb;
  v_summary jsonb;
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Open exceptions
  SELECT COUNT(*) INTO v_open_exc FROM deposit_exceptions WHERE resolved_at IS NULL;

  -- SLA breaches
  SELECT COUNT(*) INTO v_sla_breaches FROM deposit_items
  WHERE NOT closeout_complete AND status NOT IN ('failed','returned')
    AND ((status IN ('succeeded') AND cleared_at < now() - interval '2 days' AND bank_confirmed_at IS NULL)
      OR (reconciled_at IS NOT NULL AND accounting_synced_at IS NULL AND reconciled_at < now() - interval '5 days'));

  -- Unreconciled cash
  SELECT COALESCE(SUM(amount), 0) INTO v_unrecon_cash FROM deposit_items
  WHERE status = 'succeeded' AND reconciled_at IS NULL AND NOT closeout_complete;

  -- Unsynced
  SELECT COUNT(*) INTO v_unsynced FROM deposit_items
  WHERE reconciled_at IS NOT NULL AND accounting_synced_at IS NULL AND NOT closeout_complete;

  -- Closeout ready
  SELECT COUNT(*) INTO v_closeout_ready FROM deposit_items di
  WHERE NOT di.closeout_complete AND di.status = 'reconciled' AND di.bank_confirmed_at IS NOT NULL 
    AND di.accounting_synced_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM deposit_exceptions de WHERE de.deposit_item_id = di.id AND de.resolved_at IS NULL);

  -- Total open
  SELECT COUNT(*), COALESCE(SUM(amount), 0) INTO v_total_open, v_total_open_amt
  FROM deposit_items WHERE NOT closeout_complete AND status NOT IN ('failed','returned');

  -- Owner workloads
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'owner_id', owner_id, 'open_items', open_items, 'open_amount', open_amount,
    'sla_breaches', sla_breaches, 'avg_days_to_closeout', avg_days_to_closeout
  )), '[]'::jsonb) INTO v_owner_workloads FROM deposit_owner_performance WHERE owner_id IS NOT NULL;

  v_summary := jsonb_build_object(
    'generated_at', now(),
    'type', p_digest_type,
    'highlights', jsonb_build_object(
      'open_exceptions', v_open_exc,
      'sla_breaches', v_sla_breaches,
      'unreconciled_cash', v_unrecon_cash,
      'unsynced_items', v_unsynced,
      'closeout_ready', v_closeout_ready
    )
  );

  INSERT INTO deposit_daily_digest (
    digest_type, generated_by, summary, open_exceptions_count, sla_breaches_count,
    unreconciled_cash, unsynced_count, closeout_ready_count, total_open_items, total_open_amount, owner_workloads
  ) VALUES (
    p_digest_type, p_actor_id, v_summary, v_open_exc, v_sla_breaches,
    v_unrecon_cash, v_unsynced, v_closeout_ready, v_total_open, v_total_open_amt, v_owner_workloads
  )
  ON CONFLICT (digest_date, digest_type) DO UPDATE SET
    generated_at = now(), generated_by = p_actor_id, summary = v_summary,
    open_exceptions_count = v_open_exc, sla_breaches_count = v_sla_breaches,
    unreconciled_cash = v_unrecon_cash, unsynced_count = v_unsynced,
    closeout_ready_count = v_closeout_ready, total_open_items = v_total_open,
    total_open_amount = v_total_open_amt, owner_workloads = v_owner_workloads;

  RETURN jsonb_build_object('success', true, 'summary', v_summary, 'owner_workloads', v_owner_workloads);
END;
$$;

-- 8) Convenience RPCs for views
CREATE OR REPLACE FUNCTION public.get_deposit_ops_kpis()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT has_role(auth.uid(), 'staff') AND NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT row_to_json(k.*) INTO result FROM deposit_ops_kpis k;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_deposit_exception_kpis()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT has_role(auth.uid(), 'staff') AND NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT row_to_json(k.*) INTO result FROM deposit_exception_kpis k;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;
