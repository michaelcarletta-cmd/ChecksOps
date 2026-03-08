
-- Phase 7: Automation, Ownership, Exception-Driven Ops, KPIs

-- 1. Owner assignment on deposit_items
ALTER TABLE deposit_items ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE deposit_items ADD COLUMN IF NOT EXISTS owner_assigned_at timestamptz;
ALTER TABLE deposit_items ADD COLUMN IF NOT EXISTS next_action text;
ALTER TABLE deposit_items ADD COLUMN IF NOT EXISTS next_action_reason text;
ALTER TABLE deposit_items ADD COLUMN IF NOT EXISTS next_action_generated_at timestamptz;

-- 2. KPI materialized view for deposit operations
CREATE OR REPLACE VIEW deposit_ops_kpis AS
WITH item_metrics AS (
  SELECT
    di.id,
    di.status,
    di.provider,
    di.amount,
    di.nsf_flag,
    di.variance_amount,
    di.closeout_complete,
    di.created_at,
    di.cleared_at,
    di.bank_confirmed_at,
    di.reconciled_at,
    di.accounting_synced_at,
    di.closeout_at,
    -- Time deltas in days
    EXTRACT(EPOCH FROM (di.cleared_at - di.created_at)) / 86400.0 AS days_to_deposit,
    EXTRACT(EPOCH FROM (di.bank_confirmed_at - di.cleared_at)) / 86400.0 AS days_to_bank_confirm,
    EXTRACT(EPOCH FROM (di.reconciled_at - COALESCE(di.bank_confirmed_at, di.cleared_at))) / 86400.0 AS days_to_reconcile,
    EXTRACT(EPOCH FROM (di.accounting_synced_at - di.reconciled_at)) / 86400.0 AS days_to_sync,
    EXTRACT(EPOCH FROM (di.closeout_at - di.created_at)) / 86400.0 AS days_to_closeout
  FROM deposit_items di
)
SELECT
  COUNT(*) AS total_items,
  COUNT(*) FILTER (WHERE closeout_complete) AS closed_out,
  COUNT(*) FILTER (WHERE status IN ('pending_assignment','provider_assigned')) AS in_pipeline,
  COUNT(*) FILTER (WHERE status = 'succeeded') AS cleared_pending,
  COUNT(*) FILTER (WHERE status = 'reconciled') AS reconciled_pending,
  -- Averages
  ROUND(AVG(days_to_deposit) FILTER (WHERE days_to_deposit IS NOT NULL), 1) AS avg_days_to_deposit,
  ROUND(AVG(days_to_bank_confirm) FILTER (WHERE days_to_bank_confirm IS NOT NULL), 1) AS avg_days_to_bank_confirm,
  ROUND(AVG(days_to_reconcile) FILTER (WHERE days_to_reconcile IS NOT NULL), 1) AS avg_days_to_reconcile,
  ROUND(AVG(days_to_sync) FILTER (WHERE days_to_sync IS NOT NULL), 1) AS avg_days_to_sync,
  ROUND(AVG(days_to_closeout) FILTER (WHERE days_to_closeout IS NOT NULL), 1) AS avg_days_to_closeout,
  -- Rates
  ROUND(100.0 * COUNT(*) FILTER (WHERE nsf_flag) / NULLIF(COUNT(*), 0), 1) AS nsf_rate_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE variance_amount IS NOT NULL AND variance_amount != 0) / NULLIF(COUNT(*), 0), 1) AS variance_rate_pct,
  -- Money
  COALESCE(SUM(amount) FILTER (WHERE closeout_complete), 0) AS total_closed_amount,
  COALESCE(SUM(amount) FILTER (WHERE NOT closeout_complete AND status NOT IN ('failed','returned')), 0) AS total_open_amount,
  COALESCE(SUM(amount) FILTER (WHERE nsf_flag), 0) AS total_nsf_amount
FROM item_metrics;

-- 3. Exception resolution time metrics
CREATE OR REPLACE VIEW deposit_exception_kpis AS
SELECT
  COUNT(*) AS total_exceptions,
  COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved_count,
  COUNT(*) FILTER (WHERE resolved_at IS NULL) AS open_count,
  ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0) FILTER (WHERE resolved_at IS NOT NULL), 1) AS avg_hours_to_resolve,
  COUNT(*) FILTER (WHERE reopened_at IS NOT NULL) AS reopen_count,
  COUNT(*) FILTER (WHERE severity = 'critical' AND resolved_at IS NULL) AS critical_open
FROM deposit_exceptions;

-- 4. Reminder queue view — items needing attention
CREATE OR REPLACE VIEW deposit_reminder_queue AS
SELECT
  di.id AS deposit_item_id,
  di.check_number,
  di.carrier_name,
  di.amount,
  di.status,
  di.provider,
  di.owner_id,
  di.created_at,
  CASE
    -- SLA: awaiting deposit > 2 days
    WHEN di.status IN ('pending_assignment','provider_assigned')
      AND di.created_at < now() - interval '2 days'
    THEN 'sla_deposit_breach'
    -- SLA: awaiting bank confirm > 3 days
    WHEN di.status = 'succeeded' AND di.bank_confirmed_at IS NULL
      AND di.cleared_at < now() - interval '3 days'
    THEN 'sla_confirm_breach'
    -- Succeeded but no deposit slip
    WHEN di.status = 'succeeded'
      AND NOT EXISTS (SELECT 1 FROM deposit_attachments da WHERE da.deposit_item_id = di.id AND da.attachment_type = 'deposit_slip')
    THEN 'missing_deposit_slip'
    -- Reconciled but not synced > 2 days
    WHEN di.status = 'reconciled' AND di.accounting_synced_at IS NULL
      AND di.reconciled_at < now() - interval '2 days'
    THEN 'unsynced_reconciled'
    -- Succeeded but not reconciled > 5 days
    WHEN di.status = 'succeeded' AND di.reconciled_at IS NULL
      AND di.cleared_at < now() - interval '5 days'
    THEN 'stale_unreconciled'
    -- Has open exceptions > 3 days old
    WHEN EXISTS (
      SELECT 1 FROM deposit_exceptions de
      WHERE de.deposit_item_id = di.id AND de.resolved_at IS NULL
        AND de.created_at < now() - interval '3 days'
    )
    THEN 'stale_open_exception'
    ELSE NULL
  END AS reminder_type,
  (SELECT COUNT(*) FROM deposit_exceptions de WHERE de.deposit_item_id = di.id AND de.resolved_at IS NULL) AS open_exception_count
FROM deposit_items di
WHERE NOT di.closeout_complete
  AND di.status NOT IN ('failed','returned');

-- 5. assign_deposit_owner RPC
CREATE OR REPLACE FUNCTION public.assign_deposit_owner(
  p_deposit_item_ids uuid[],
  p_owner_id uuid,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_count int;
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE deposit_items SET
    owner_id = p_owner_id,
    owner_assigned_at = now(),
    updated_at = now()
  WHERE id = ANY(p_deposit_item_ids)
    AND NOT closeout_complete;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Audit each
  INSERT INTO deposit_audit_log (deposit_item_id, action, actor_id, notes, new_values)
  SELECT
    unnest(p_deposit_item_ids),
    'assign_owner',
    p_actor_id,
    'Owner assigned',
    jsonb_build_object('owner_id', p_owner_id);

  -- Also assign owner on open exceptions for those items
  UPDATE deposit_exceptions SET
    owner_id = p_owner_id,
    assigned_at = now(),
    updated_at = now()
  WHERE deposit_item_id = ANY(p_deposit_item_ids)
    AND resolved_at IS NULL;

  RETURN jsonb_build_object('success', true, 'updated', v_count);
END;
$$;

-- 6. generate_next_deposit_action RPC
CREATE OR REPLACE FUNCTION public.generate_next_deposit_action(
  p_deposit_item_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_item record;
  v_action text;
  v_reason text;
  v_open_exc int;
  v_has_slip boolean;
  v_has_receipt boolean;
  v_has_bank_doc boolean;
BEGIN
  SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
  IF v_item.closeout_complete THEN
    UPDATE deposit_items SET next_action = NULL, next_action_reason = NULL, next_action_generated_at = now(), updated_at = now() WHERE id = p_deposit_item_id;
    RETURN jsonb_build_object('action', null, 'reason', 'Closed out');
  END IF;

  SELECT COUNT(*) INTO v_open_exc FROM deposit_exceptions WHERE deposit_item_id = p_deposit_item_id AND resolved_at IS NULL;
  SELECT EXISTS(SELECT 1 FROM deposit_attachments WHERE deposit_item_id = p_deposit_item_id AND attachment_type = 'deposit_slip') INTO v_has_slip;
  SELECT EXISTS(SELECT 1 FROM deposit_attachments WHERE deposit_item_id = p_deposit_item_id AND attachment_type = 'stamped_receipt') INTO v_has_receipt;
  SELECT EXISTS(SELECT 1 FROM deposit_attachments WHERE deposit_item_id = p_deposit_item_id AND attachment_type = 'bank_confirmation') INTO v_has_bank_doc;

  -- Priority order: exceptions > missing steps > missing artifacts
  IF v_open_exc > 0 THEN
    v_action := 'resolve_exceptions';
    v_reason := format('%s open exception(s) must be resolved before closeout', v_open_exc);
  ELSIF v_item.status = 'pending_assignment' THEN
    v_action := 'assign_provider';
    v_reason := 'Assign a deposit route (manual branch or internal)';
  ELSIF v_item.status = 'provider_assigned' THEN
    v_action := 'mark_deposited';
    v_reason := 'Record the manual deposit at the bank branch';
  ELSIF v_item.status = 'succeeded' AND NOT v_has_slip THEN
    v_action := 'upload_deposit_slip';
    v_reason := 'Upload the deposit slip for audit records';
  ELSIF v_item.status = 'succeeded' AND v_item.bank_confirmed_at IS NULL THEN
    v_action := 'bank_confirm';
    v_reason := 'Confirm funds cleared with bank reference number';
  ELSIF v_item.status = 'succeeded' AND v_item.reconciled_at IS NULL THEN
    v_action := 'reconcile';
    v_reason := 'Reconcile deposited amount against bank statement';
  ELSIF v_item.status = 'reconciled' AND v_item.accounting_synced_at IS NULL THEN
    v_action := 'sync_accounting';
    v_reason := 'Sync to accounting system (QuickBooks)';
  ELSIF v_item.status = 'reconciled' AND v_item.accounting_synced_at IS NOT NULL THEN
    v_action := 'closeout';
    v_reason := 'All requirements met — ready for final closeout';
  ELSE
    v_action := 'review';
    v_reason := format('Item in status %s — manual review needed', v_item.status);
  END IF;

  UPDATE deposit_items SET
    next_action = v_action,
    next_action_reason = v_reason,
    next_action_generated_at = now(),
    updated_at = now()
  WHERE id = p_deposit_item_id;

  RETURN jsonb_build_object('action', v_action, 'reason', v_reason);
END;
$$;

-- 7. Bulk action: resolve multiple exceptions at once
CREATE OR REPLACE FUNCTION public.bulk_resolve_deposit_exceptions(
  p_exception_ids uuid[],
  p_actor_id uuid,
  p_resolution_notes text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_count int;
  v_exc record;
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_resolution_notes IS NULL OR p_resolution_notes = '' THEN
    RAISE EXCEPTION 'Resolution notes required';
  END IF;

  UPDATE deposit_exceptions SET
    resolved_at = now(),
    resolved_by = p_actor_id,
    resolution_notes = p_resolution_notes,
    updated_at = now()
  WHERE id = ANY(p_exception_ids)
    AND resolved_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Audit each
  FOR v_exc IN SELECT id, deposit_item_id, exception_code FROM deposit_exceptions WHERE id = ANY(p_exception_ids)
  LOOP
    INSERT INTO deposit_audit_log (deposit_item_id, action, actor_id, notes, new_values)
    VALUES (v_exc.deposit_item_id, 'bulk_resolve_exception', p_actor_id, p_resolution_notes,
      jsonb_build_object('exception_id', v_exc.id, 'exception_code', v_exc.exception_code));
  END LOOP;

  RETURN jsonb_build_object('success', true, 'resolved', v_count);
END;
$$;

-- 8. Bulk sync accounting
CREATE OR REPLACE FUNCTION public.bulk_sync_deposit_accounting(
  p_deposit_item_ids uuid[],
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_count int;
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE deposit_items SET
    accounting_synced_at = now(),
    updated_at = now()
  WHERE id = ANY(p_deposit_item_ids)
    AND status IN ('succeeded','reconciled')
    AND accounting_synced_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO deposit_audit_log (deposit_item_id, action, actor_id, notes)
  SELECT unnest(p_deposit_item_ids), 'bulk_sync_accounting', p_actor_id, 'Bulk accounting sync';

  RETURN jsonb_build_object('success', true, 'synced', v_count);
END;
$$;

-- 9. Bulk closeout
CREATE OR REPLACE FUNCTION public.bulk_deposit_closeout(
  p_deposit_item_ids uuid[],
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_item record;
  v_closed int := 0;
  v_skipped int := 0;
  v_open_exc int;
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  FOR v_item IN SELECT * FROM deposit_items WHERE id = ANY(p_deposit_item_ids) AND NOT closeout_complete FOR UPDATE
  LOOP
    SELECT COUNT(*) INTO v_open_exc FROM deposit_exceptions WHERE deposit_item_id = v_item.id AND resolved_at IS NULL;
    IF v_item.status IN ('succeeded','reconciled')
       AND v_item.bank_confirmed_at IS NOT NULL
       AND v_item.reconciled_at IS NOT NULL
       AND v_item.accounting_synced_at IS NOT NULL
       AND v_open_exc = 0
    THEN
      UPDATE deposit_items SET closeout_complete = true, closeout_at = now(), closeout_by = p_actor_id, updated_at = now()
      WHERE id = v_item.id;
      INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount)
      VALUES (v_item.id, v_item.batch_id, 'bulk_closeout', p_actor_id, v_item.amount);
      v_closed := v_closed + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'closed', v_closed, 'skipped', v_skipped);
END;
$$;

-- 10. KPI RPCs
CREATE OR REPLACE FUNCTION public.get_deposit_ops_kpis()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT has_role(auth.uid(), 'staff') AND NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT row_to_json(k.*) INTO result FROM deposit_ops_kpis k;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_deposit_exception_kpis()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT has_role(auth.uid(), 'staff') AND NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT row_to_json(k.*) INTO result FROM deposit_exception_kpis k;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;
