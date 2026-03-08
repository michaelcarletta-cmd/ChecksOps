
-- Allow system (NULL actor) calls for automation RPCs by adjusting auth checks

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
BEGIN
  -- Allow NULL actor for system/cron calls
  IF p_actor_id IS NOT NULL AND NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  FOR v_item IN
    SELECT * FROM deposit_items WHERE NOT closeout_complete AND status NOT IN ('failed','returned')
  LOOP
    v_action := NULL; v_reason := NULL;
    SELECT COUNT(*) INTO v_open_exc FROM deposit_exceptions WHERE deposit_item_id = v_item.id AND resolved_at IS NULL;
    SELECT EXISTS(SELECT 1 FROM deposit_attachments WHERE deposit_item_id = v_item.id AND attachment_type = 'deposit_slip') INTO v_has_slip;

    IF v_open_exc > 0 THEN v_action := 'resolve_exceptions'; v_reason := format('%s open exception(s)', v_open_exc);
    ELSIF v_item.status = 'pending_assignment' THEN v_action := 'assign_provider'; v_reason := 'Needs deposit route assignment';
    ELSIF v_item.status = 'provider_assigned' THEN v_action := 'mark_deposited'; v_reason := 'Ready for deposit confirmation';
    ELSIF v_item.status = 'succeeded' AND NOT v_has_slip THEN v_action := 'upload_deposit_slip'; v_reason := 'Missing deposit slip';
    ELSIF v_item.status = 'succeeded' AND v_item.bank_confirmed_at IS NULL THEN v_action := 'bank_confirm'; v_reason := 'Awaiting bank confirmation';
    ELSIF v_item.status = 'succeeded' AND v_item.reconciled_at IS NULL THEN v_action := 'reconcile'; v_reason := 'Deposit succeeded, needs reconciliation';
    ELSIF v_item.status = 'reconciled' AND v_item.accounting_synced_at IS NULL THEN v_action := 'sync_accounting'; v_reason := 'Reconciled but not synced to accounting';
    ELSIF v_item.status = 'reconciled' AND v_item.accounting_synced_at IS NOT NULL AND v_open_exc = 0 THEN v_action := 'closeout'; v_reason := 'All requirements met, ready for closeout';
    ELSE v_action := 'review'; v_reason := 'Manual review needed';
    END IF;

    UPDATE deposit_items SET next_action = v_action, next_action_reason = v_reason, updated_at = now() WHERE id = v_item.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'refreshed', v_count);
END;
$$;

-- Fix generate_deposit_daily_digest to allow NULL actor
CREATE OR REPLACE FUNCTION public.generate_deposit_daily_digest(p_actor_id uuid DEFAULT NULL, p_digest_type text DEFAULT 'daily')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_open_exc int; v_sla_breaches int; v_unrecon_cash numeric;
  v_unsynced int; v_closeout_ready int; v_total_open int; v_total_open_amt numeric;
  v_owner_workloads jsonb; v_summary jsonb;
BEGIN
  IF p_actor_id IS NOT NULL AND NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COUNT(*) INTO v_open_exc FROM deposit_exceptions WHERE resolved_at IS NULL;
  SELECT COUNT(*) INTO v_sla_breaches FROM deposit_items
  WHERE NOT closeout_complete AND status NOT IN ('failed','returned')
    AND ((status = 'succeeded' AND cleared_at < now() - interval '2 days' AND bank_confirmed_at IS NULL)
      OR (reconciled_at IS NOT NULL AND accounting_synced_at IS NULL AND reconciled_at < now() - interval '5 days'));
  SELECT COALESCE(SUM(amount), 0) INTO v_unrecon_cash FROM deposit_items WHERE status = 'succeeded' AND reconciled_at IS NULL AND NOT closeout_complete;
  SELECT COUNT(*) INTO v_unsynced FROM deposit_items WHERE reconciled_at IS NOT NULL AND accounting_synced_at IS NULL AND NOT closeout_complete;
  SELECT COUNT(*) INTO v_closeout_ready FROM deposit_items di
  WHERE NOT di.closeout_complete AND di.status = 'reconciled' AND di.bank_confirmed_at IS NOT NULL AND di.accounting_synced_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM deposit_exceptions de WHERE de.deposit_item_id = di.id AND de.resolved_at IS NULL);
  SELECT COUNT(*), COALESCE(SUM(amount), 0) INTO v_total_open, v_total_open_amt FROM deposit_items WHERE NOT closeout_complete AND status NOT IN ('failed','returned');
  SELECT COALESCE(jsonb_agg(jsonb_build_object('owner_id', owner_id, 'open_items', open_items, 'open_amount', open_amount, 'sla_breaches', sla_breaches)), '[]'::jsonb) INTO v_owner_workloads FROM deposit_owner_performance WHERE owner_id IS NOT NULL;

  v_summary := jsonb_build_object('generated_at', now(), 'type', p_digest_type, 'highlights', jsonb_build_object('open_exceptions', v_open_exc, 'sla_breaches', v_sla_breaches, 'unreconciled_cash', v_unrecon_cash, 'unsynced_items', v_unsynced, 'closeout_ready', v_closeout_ready));

  INSERT INTO deposit_daily_digest (digest_type, generated_by, summary, open_exceptions_count, sla_breaches_count, unreconciled_cash, unsynced_count, closeout_ready_count, total_open_items, total_open_amount, owner_workloads)
  VALUES (p_digest_type, p_actor_id, v_summary, v_open_exc, v_sla_breaches, v_unrecon_cash, v_unsynced, v_closeout_ready, v_total_open, v_total_open_amt, v_owner_workloads)
  ON CONFLICT (digest_date, digest_type) DO UPDATE SET
    generated_at = now(), generated_by = p_actor_id, summary = v_summary, open_exceptions_count = v_open_exc, sla_breaches_count = v_sla_breaches,
    unreconciled_cash = v_unrecon_cash, unsynced_count = v_unsynced, closeout_ready_count = v_closeout_ready, total_open_items = v_total_open, total_open_amount = v_total_open_amt, owner_workloads = v_owner_workloads;

  RETURN jsonb_build_object('success', true, 'summary', v_summary, 'owner_workloads', v_owner_workloads);
END;
$$;

-- Fix save_deposit_manager_snapshot to allow NULL actor
CREATE OR REPLACE FUNCTION public.save_deposit_manager_snapshot(p_actor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_kpi jsonb; v_exc_kpi jsonb; v_queue jsonb; v_owners jsonb;
BEGIN
  IF p_actor_id IS NOT NULL AND NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT row_to_json(k.*) INTO v_kpi FROM deposit_ops_kpis k;
  SELECT row_to_json(k.*) INTO v_exc_kpi FROM deposit_exception_kpis k;
  SELECT COALESCE(jsonb_agg(row_to_json(q.*)), '[]'::jsonb) INTO v_queue FROM (SELECT id, check_number, amount, status, priority_score, next_action, owner_id FROM deposit_queue_scored ORDER BY priority_score DESC LIMIT 20) q;
  SELECT COALESCE(jsonb_agg(row_to_json(o.*)), '[]'::jsonb) INTO v_owners FROM deposit_owner_performance o WHERE owner_id IS NOT NULL;
  INSERT INTO deposit_manager_snapshots (snapshot_date, snapshot_type, kpi_data, queue_data, owner_data, exception_data)
  VALUES (CURRENT_DATE, 'daily', COALESCE(v_kpi, '{}'::jsonb), v_queue, v_owners, COALESCE(v_exc_kpi, '{}'::jsonb))
  ON CONFLICT (snapshot_date, snapshot_type) DO UPDATE SET kpi_data = COALESCE(v_kpi, '{}'::jsonb), queue_data = v_queue, owner_data = v_owners, exception_data = COALESCE(v_exc_kpi, '{}'::jsonb), created_at = now();
  RETURN jsonb_build_object('success', true);
END;
$$;

-- Fix run_deposit_escalation_check to allow NULL actor
CREATE OR REPLACE FUNCTION public.run_deposit_escalation_check(p_actor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_rule record; v_item record; v_exc record; v_count int := 0; v_admin_id uuid;
BEGIN
  SELECT user_id INTO v_admin_id FROM user_roles WHERE role = 'admin' LIMIT 1;
  FOR v_rule IN SELECT * FROM deposit_escalation_rules WHERE is_active = true ORDER BY priority
  LOOP
    CASE v_rule.trigger_type
      WHEN 'stale_exception' THEN
        FOR v_exc IN SELECT de.id as exc_id, de.deposit_item_id FROM deposit_exceptions de WHERE de.resolved_at IS NULL AND de.created_at < now() - (v_rule.threshold_days || ' days')::interval AND NOT EXISTS (SELECT 1 FROM deposit_escalation_events ee WHERE ee.exception_id = de.id AND ee.rule_id = v_rule.id AND NOT ee.is_resolved)
        LOOP INSERT INTO deposit_escalation_events (rule_id, deposit_item_id, exception_id, escalation_type, escalated_to, message) VALUES (v_rule.id, v_exc.deposit_item_id, v_exc.exc_id, v_rule.trigger_type, v_admin_id, v_rule.notification_message); v_count := v_count + 1; END LOOP;
      WHEN 'unreconciled_cash' THEN
        FOR v_item IN SELECT di.id FROM deposit_items di WHERE di.status = 'succeeded' AND di.reconciled_at IS NULL AND NOT di.closeout_complete AND di.cleared_at < now() - (v_rule.threshold_days || ' days')::interval AND di.amount >= v_rule.threshold_amount AND NOT EXISTS (SELECT 1 FROM deposit_escalation_events ee WHERE ee.deposit_item_id = di.id AND ee.escalation_type = 'unreconciled_cash' AND ee.rule_id = v_rule.id AND NOT ee.is_resolved)
        LOOP INSERT INTO deposit_escalation_events (rule_id, deposit_item_id, escalation_type, escalated_to, message) VALUES (v_rule.id, v_item.id, v_rule.trigger_type, v_admin_id, v_rule.notification_message); v_count := v_count + 1; END LOOP;
      WHEN 'unsynced_accounting' THEN
        FOR v_item IN SELECT di.id FROM deposit_items di WHERE di.reconciled_at IS NOT NULL AND di.accounting_synced_at IS NULL AND NOT di.closeout_complete AND di.reconciled_at < now() - (v_rule.threshold_days || ' days')::interval AND NOT EXISTS (SELECT 1 FROM deposit_escalation_events ee WHERE ee.deposit_item_id = di.id AND ee.escalation_type = 'unsynced_accounting' AND ee.rule_id = v_rule.id AND NOT ee.is_resolved)
        LOOP INSERT INTO deposit_escalation_events (rule_id, deposit_item_id, escalation_type, escalated_to, message) VALUES (v_rule.id, v_item.id, v_rule.trigger_type, v_admin_id, v_rule.notification_message); v_count := v_count + 1; END LOOP;
      WHEN 'unassigned_item' THEN
        FOR v_item IN SELECT di.id FROM deposit_items di WHERE di.owner_id IS NULL AND NOT di.closeout_complete AND di.status NOT IN ('failed','returned') AND di.created_at < now() - (v_rule.threshold_days || ' days')::interval AND NOT EXISTS (SELECT 1 FROM deposit_escalation_events ee WHERE ee.deposit_item_id = di.id AND ee.escalation_type = 'unassigned_item' AND ee.rule_id = v_rule.id AND NOT ee.is_resolved)
        LOOP INSERT INTO deposit_escalation_events (rule_id, deposit_item_id, escalation_type, escalated_to, message) VALUES (v_rule.id, v_item.id, v_rule.trigger_type, v_admin_id, v_rule.notification_message); v_count := v_count + 1; END LOOP;
      WHEN 'sla_breach' THEN
        FOR v_item IN SELECT di.id FROM deposit_items di WHERE NOT di.closeout_complete AND di.status NOT IN ('failed','returned') AND di.created_at < now() - (v_rule.threshold_days || ' days')::interval AND ((di.status IN ('pending_assignment','provider_assigned') AND di.cleared_at IS NULL) OR (di.status = 'succeeded' AND di.bank_confirmed_at IS NULL AND di.cleared_at < now() - interval '3 days')) AND NOT EXISTS (SELECT 1 FROM deposit_escalation_events ee WHERE ee.deposit_item_id = di.id AND ee.escalation_type = 'sla_breach' AND ee.rule_id = v_rule.id AND NOT ee.is_resolved)
        LOOP INSERT INTO deposit_escalation_events (rule_id, deposit_item_id, escalation_type, escalated_to, message) VALUES (v_rule.id, v_item.id, v_rule.trigger_type, v_admin_id, v_rule.notification_message); v_count := v_count + 1; END LOOP;
      ELSE NULL;
    END CASE;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'escalations_created', v_count);
END;
$$;
