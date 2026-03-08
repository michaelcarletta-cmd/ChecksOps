
-- Phase 6: Exception Resolution, Closeout Controls, Aging/SLA, Reports

-- 1. Add exception resolution columns to deposit_exceptions
ALTER TABLE deposit_exceptions ADD COLUMN IF NOT EXISTS resolved_by uuid;
ALTER TABLE deposit_exceptions ADD COLUMN IF NOT EXISTS resolution_notes text;
ALTER TABLE deposit_exceptions ADD COLUMN IF NOT EXISTS reopened_at timestamptz;
ALTER TABLE deposit_exceptions ADD COLUMN IF NOT EXISTS reopened_by uuid;
ALTER TABLE deposit_exceptions ADD COLUMN IF NOT EXISTS reopen_reason text;
ALTER TABLE deposit_exceptions ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE deposit_exceptions ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- 2. Add closeout tracking to deposit_items
ALTER TABLE deposit_items ADD COLUMN IF NOT EXISTS closeout_complete boolean NOT NULL DEFAULT false;
ALTER TABLE deposit_items ADD COLUMN IF NOT EXISTS closeout_at timestamptz;
ALTER TABLE deposit_items ADD COLUMN IF NOT EXISTS closeout_by uuid;

-- 3. Deposit aging/SLA view
CREATE OR REPLACE VIEW deposit_aging_dashboard AS
SELECT
  di.id,
  di.check_number,
  di.carrier_name,
  di.amount,
  di.status,
  di.provider,
  di.created_at,
  di.cleared_at,
  di.bank_confirmed_at,
  di.reconciled_at,
  di.accounting_synced_at,
  di.closeout_complete,
  -- Aging buckets
  CASE
    WHEN di.status IN ('pending_assignment','provider_assigned') THEN 'awaiting_deposit'
    WHEN di.status = 'succeeded' AND di.bank_confirmed_at IS NULL THEN 'awaiting_bank_confirm'
    WHEN di.status = 'succeeded' AND di.bank_confirmed_at IS NOT NULL AND di.reconciled_at IS NULL THEN 'awaiting_reconciliation'
    WHEN di.status = 'reconciled' AND di.accounting_synced_at IS NULL THEN 'awaiting_accounting_sync'
    WHEN di.status IN ('failed','returned') THEN 'exception'
    WHEN di.closeout_complete THEN 'complete'
    ELSE 'in_progress'
  END AS aging_bucket,
  -- Days in current state
  EXTRACT(DAY FROM now() - COALESCE(
    CASE
      WHEN di.status IN ('pending_assignment','provider_assigned') THEN di.created_at
      WHEN di.status = 'succeeded' AND di.bank_confirmed_at IS NULL THEN di.cleared_at
      WHEN di.status = 'succeeded' AND di.bank_confirmed_at IS NOT NULL THEN di.bank_confirmed_at
      WHEN di.status = 'reconciled' THEN di.reconciled_at
      ELSE di.created_at
    END, di.created_at
  ))::int AS days_in_state,
  -- SLA breach flags
  CASE WHEN di.status IN ('pending_assignment','provider_assigned') AND di.created_at < now() - interval '2 days' THEN true ELSE false END AS sla_deposit_breach,
  CASE WHEN di.status = 'succeeded' AND di.bank_confirmed_at IS NULL AND di.cleared_at < now() - interval '3 days' THEN true ELSE false END AS sla_confirm_breach,
  CASE WHEN di.status IN ('succeeded','reconciled') AND di.accounting_synced_at IS NULL AND di.cleared_at < now() - interval '5 days' THEN true ELSE false END AS sla_sync_breach,
  -- Attachment flags
  (SELECT COUNT(*) FROM deposit_attachments da WHERE da.deposit_item_id = di.id AND da.attachment_type = 'deposit_slip') AS deposit_slip_count,
  (SELECT COUNT(*) FROM deposit_attachments da WHERE da.deposit_item_id = di.id AND da.attachment_type = 'stamped_receipt') AS stamped_receipt_count,
  (SELECT COUNT(*) FROM deposit_attachments da WHERE da.deposit_item_id = di.id AND da.attachment_type = 'bank_confirmation') AS bank_confirmation_count,
  -- Open exception count
  (SELECT COUNT(*) FROM deposit_exceptions de WHERE de.deposit_item_id = di.id AND de.resolved_at IS NULL) AS open_exception_count
FROM deposit_items di;

-- 4. Aging summary counts view
CREATE OR REPLACE VIEW deposit_aging_summary AS
SELECT
  COUNT(*) FILTER (WHERE aging_bucket = 'awaiting_deposit') AS awaiting_deposit,
  COUNT(*) FILTER (WHERE aging_bucket = 'awaiting_bank_confirm') AS awaiting_bank_confirm,
  COUNT(*) FILTER (WHERE aging_bucket = 'awaiting_reconciliation') AS awaiting_reconciliation,
  COUNT(*) FILTER (WHERE aging_bucket = 'awaiting_accounting_sync') AS awaiting_accounting_sync,
  COUNT(*) FILTER (WHERE aging_bucket = 'exception') AS open_exceptions,
  COUNT(*) FILTER (WHERE aging_bucket = 'complete') AS complete,
  COUNT(*) FILTER (WHERE sla_deposit_breach) AS sla_deposit_breaches,
  COUNT(*) FILTER (WHERE sla_confirm_breach) AS sla_confirm_breaches,
  COUNT(*) FILTER (WHERE sla_sync_breach) AS sla_sync_breaches,
  COUNT(*) FILTER (WHERE aging_bucket = 'awaiting_deposit' AND deposit_slip_count = 0 AND status NOT IN ('pending_assignment')) AS missing_deposit_slip,
  COUNT(*) FILTER (WHERE aging_bucket != 'complete' AND aging_bucket != 'exception' AND open_exception_count > 0) AS items_with_open_exceptions,
  COALESCE(SUM(amount) FILTER (WHERE aging_bucket = 'awaiting_reconciliation'), 0) AS unreconciled_amount,
  COALESCE(SUM(amount) FILTER (WHERE aging_bucket = 'awaiting_accounting_sync'), 0) AS unsynced_amount
FROM deposit_aging_dashboard;

-- 5. Exception resolution RPC
CREATE OR REPLACE FUNCTION public.resolve_deposit_exception(
  p_exception_id uuid,
  p_actor_id uuid,
  p_resolution_notes text,
  p_action text DEFAULT 'resolve' -- 'resolve' or 'reopen'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_exc record;
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_exc FROM deposit_exceptions WHERE id = p_exception_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exception not found'; END IF;

  IF p_action = 'resolve' THEN
    IF v_exc.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'Exception already resolved'; END IF;
    IF p_resolution_notes IS NULL OR p_resolution_notes = '' THEN RAISE EXCEPTION 'Resolution notes required'; END IF;
    UPDATE deposit_exceptions SET
      resolved_at = now(), resolved_by = p_actor_id, resolution_notes = p_resolution_notes, updated_at = now()
    WHERE id = p_exception_id;
    INSERT INTO deposit_audit_log (deposit_item_id, action, actor_id, notes, new_values)
    VALUES (v_exc.deposit_item_id, 'resolve_exception', p_actor_id, p_resolution_notes,
      jsonb_build_object('exception_id', p_exception_id, 'exception_code', v_exc.exception_code));
  ELSIF p_action = 'reopen' THEN
    IF v_exc.resolved_at IS NULL THEN RAISE EXCEPTION 'Exception is not resolved'; END IF;
    IF p_resolution_notes IS NULL OR p_resolution_notes = '' THEN RAISE EXCEPTION 'Reopen reason required'; END IF;
    UPDATE deposit_exceptions SET
      resolved_at = NULL, resolved_by = NULL, resolution_notes = NULL,
      reopened_at = now(), reopened_by = p_actor_id, reopen_reason = p_resolution_notes, updated_at = now()
    WHERE id = p_exception_id;
    INSERT INTO deposit_audit_log (deposit_item_id, action, actor_id, notes, new_values)
    VALUES (v_exc.deposit_item_id, 'reopen_exception', p_actor_id, p_resolution_notes,
      jsonb_build_object('exception_id', p_exception_id, 'exception_code', v_exc.exception_code));
  ELSE
    RAISE EXCEPTION 'Unknown action: %', p_action;
  END IF;

  RETURN jsonb_build_object('success', true, 'action', p_action, 'exception_id', p_exception_id);
END;
$$;

-- 6. Closeout validation RPC
CREATE OR REPLACE FUNCTION public.mark_deposit_closeout(
  p_deposit_item_id uuid,
  p_actor_id uuid,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_item record;
  v_open_exc int;
  v_missing text[];
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
  IF v_item.closeout_complete THEN RAISE EXCEPTION 'Already closed out'; END IF;

  -- Validate all closeout requirements
  v_missing := ARRAY[]::text[];
  IF v_item.status NOT IN ('succeeded','reconciled') THEN v_missing := v_missing || 'not_deposited'; END IF;
  IF v_item.bank_confirmed_at IS NULL THEN v_missing := v_missing || 'no_bank_confirmation'; END IF;
  IF v_item.reconciled_at IS NULL THEN v_missing := v_missing || 'not_reconciled'; END IF;
  IF v_item.accounting_synced_at IS NULL THEN v_missing := v_missing || 'not_accounting_synced'; END IF;

  SELECT COUNT(*) INTO v_open_exc FROM deposit_exceptions WHERE deposit_item_id = p_deposit_item_id AND resolved_at IS NULL;
  IF v_open_exc > 0 THEN v_missing := v_missing || format('%s_open_exceptions', v_open_exc); END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'Closeout blocked: %', array_to_string(v_missing, ', ');
  END IF;

  UPDATE deposit_items SET closeout_complete = true, closeout_at = now(), closeout_by = p_actor_id, updated_at = now()
  WHERE id = p_deposit_item_id;

  INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes)
  VALUES (p_deposit_item_id, v_item.batch_id, 'mark_closeout_complete', p_actor_id, v_item.amount, p_notes);

  RETURN jsonb_build_object('success', true);
END;
$$;

-- 7. Aging summary RPC
CREATE OR REPLACE FUNCTION public.get_deposit_aging_summary()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT has_role(auth.uid(), 'staff') AND NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT row_to_json(s.*) INTO result FROM deposit_aging_summary s;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

-- 8. Daily deposit log view (for reports)
CREATE OR REPLACE VIEW deposit_daily_log AS
SELECT
  date_trunc('day', di.cleared_at)::date AS deposit_date,
  di.provider,
  COUNT(*) AS item_count,
  SUM(di.amount) AS total_amount,
  SUM(CASE WHEN di.bank_confirmed_at IS NOT NULL THEN di.amount ELSE 0 END) AS confirmed_amount,
  SUM(CASE WHEN di.reconciled_at IS NOT NULL THEN di.amount ELSE 0 END) AS reconciled_amount,
  COUNT(*) FILTER (WHERE di.nsf_flag) AS nsf_count,
  SUM(COALESCE(di.variance_amount, 0)) AS total_variance
FROM deposit_items di
WHERE di.cleared_at IS NOT NULL
GROUP BY date_trunc('day', di.cleared_at)::date, di.provider
ORDER BY deposit_date DESC, di.provider;
