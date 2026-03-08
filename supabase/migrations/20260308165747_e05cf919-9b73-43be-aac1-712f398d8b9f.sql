
-- deposit_action RPC
CREATE OR REPLACE FUNCTION public.deposit_action(
  p_action text, p_actor_id uuid, p_deposit_item_id uuid DEFAULT NULL, p_check_id uuid DEFAULT NULL,
  p_batch_id uuid DEFAULT NULL, p_provider text DEFAULT NULL, p_amount numeric DEFAULT NULL,
  p_notes text DEFAULT NULL, p_extra jsonb DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_item record; v_check record; v_item_id uuid; v_batch_id uuid; v_attempt_id uuid; v_target_attempt_id uuid;
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;

  CASE p_action
  WHEN 'prepare_deposit' THEN
    IF p_check_id IS NULL THEN RAISE EXCEPTION 'check_id required'; END IF;
    SELECT * INTO v_check FROM check_intake_items WHERE id = p_check_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Check not found'; END IF;
    IF v_check.status != 'approved_for_deposit' THEN RAISE EXCEPTION 'Check must be approved_for_deposit, got: %', v_check.status; END IF;
    IF EXISTS (SELECT 1 FROM deposit_items WHERE check_id = p_check_id) THEN RAISE EXCEPTION 'duplicate_submission: Check already in deposit pipeline'; END IF;
    INSERT INTO deposit_items (check_id, amount, check_number, carrier_name, claim_id)
    VALUES (p_check_id, COALESCE(v_check.amount, 0), v_check.check_number, v_check.carrier_name, v_check.claim_id) RETURNING id INTO v_item_id;
    INSERT INTO deposit_audit_log (deposit_item_id, action, actor_id, amount, notes) VALUES (v_item_id, 'prepare_deposit', p_actor_id, v_check.amount, p_notes);
    RETURN jsonb_build_object('success', true, 'deposit_item_id', v_item_id);

  WHEN 'assign_provider' THEN
    IF p_deposit_item_id IS NULL OR p_provider IS NULL THEN RAISE EXCEPTION 'deposit_item_id and provider required'; END IF;
    SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
    IF v_item.status != 'pending_assignment' THEN RAISE EXCEPTION 'Invalid transition: % -> assign_provider', v_item.status; END IF;
    v_batch_id := p_batch_id;
    IF v_batch_id IS NULL THEN
      INSERT INTO deposit_batches (provider, total_items, total_amount, created_by) VALUES (p_provider::deposit_provider, 1, v_item.amount, p_actor_id) RETURNING id INTO v_batch_id;
    ELSE
      UPDATE deposit_batches SET total_items = total_items + 1, total_amount = total_amount + v_item.amount, updated_at = now() WHERE id = v_batch_id;
    END IF;
    UPDATE deposit_items SET provider = p_provider::deposit_provider, batch_id = v_batch_id, status = 'provider_assigned', updated_at = now() WHERE id = p_deposit_item_id;
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes, new_values)
    VALUES (p_deposit_item_id, v_batch_id, 'assign_provider', p_actor_id, v_item.amount, p_notes, jsonb_build_object('provider', p_provider, 'batch_id', v_batch_id));
    RETURN jsonb_build_object('success', true, 'batch_id', v_batch_id);

  WHEN 'mark_manual_deposit' THEN
    SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
    IF v_item.status NOT IN ('provider_assigned','pending_assignment') THEN RAISE EXCEPTION 'Invalid transition: % -> mark_manual_deposit', v_item.status; END IF;
    UPDATE deposit_items SET status = 'succeeded', provider = COALESCE(v_item.provider, 'manual_branch'), cleared_at = now(), updated_at = now() WHERE id = p_deposit_item_id;
    IF v_item.batch_id IS NOT NULL THEN UPDATE deposit_batches SET cleared_amount = cleared_amount + v_item.amount, updated_at = now() WHERE id = v_item.batch_id; END IF;
    UPDATE check_intake_items SET status = 'deposited', updated_at = now() WHERE id = v_item.check_id;
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes) VALUES (p_deposit_item_id, v_item.batch_id, 'mark_manual_deposit', p_actor_id, v_item.amount, p_notes);
    RETURN jsonb_build_object('success', true);

  WHEN 'record_submission' THEN
    SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
    IF v_item.status != 'provider_assigned' THEN RAISE EXCEPTION 'Invalid transition: % -> record_submission', v_item.status; END IF;
    UPDATE deposit_items SET status = 'submitted', submitted_at = now(), provider_payload = COALESCE(p_extra->'payload', v_item.provider_payload), provider_reference = COALESCE(p_extra->>'provider_reference', v_item.provider_reference), updated_at = now() WHERE id = p_deposit_item_id;
    INSERT INTO deposit_provider_attempts (deposit_item_id, provider, attempt_number, idempotency_key, request_payload, status)
    VALUES (p_deposit_item_id, v_item.provider, (SELECT COALESCE(MAX(attempt_number), 0) + 1 FROM deposit_provider_attempts WHERE deposit_item_id = p_deposit_item_id), v_item.idempotency_key, p_extra->'payload', 'submitted') RETURNING id INTO v_attempt_id;
    IF v_item.batch_id IS NOT NULL THEN UPDATE deposit_batches SET status = 'submitted', submitted_at = now(), updated_at = now() WHERE id = v_item.batch_id AND status = 'open'; END IF;
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes, new_values)
    VALUES (p_deposit_item_id, v_item.batch_id, 'record_submission', p_actor_id, v_item.amount, p_notes, jsonb_build_object('attempt_id', v_attempt_id));
    RETURN jsonb_build_object('success', true, 'attempt_id', v_attempt_id);

  WHEN 'record_success' THEN
    SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
    IF v_item.status NOT IN ('submitted','processing') THEN RAISE EXCEPTION 'Invalid transition: % -> record_success', v_item.status; END IF;
    IF p_amount IS NOT NULL AND p_amount != v_item.amount THEN
      INSERT INTO deposit_exceptions (deposit_item_id, exception_type, exception_code, description, provider, severity)
      VALUES (p_deposit_item_id, 'amount_mismatch', 'AMT_MISMATCH', format('Expected $%s, provider reported $%s', v_item.amount, p_amount), v_item.provider, 'critical');
    END IF;
    UPDATE deposit_items SET status = 'succeeded', cleared_at = now(), provider_response = COALESCE(p_extra->'response', v_item.provider_response), updated_at = now() WHERE id = p_deposit_item_id;
    SELECT id INTO v_target_attempt_id FROM deposit_provider_attempts WHERE deposit_item_id = p_deposit_item_id AND status != 'succeeded' ORDER BY attempt_number DESC LIMIT 1;
    IF v_target_attempt_id IS NOT NULL THEN UPDATE deposit_provider_attempts SET status = 'succeeded', completed_at = now(), response_payload = p_extra->'response', response_code = (p_extra->>'response_code')::integer WHERE id = v_target_attempt_id; END IF;
    IF v_item.batch_id IS NOT NULL THEN UPDATE deposit_batches SET cleared_amount = cleared_amount + v_item.amount, updated_at = now() WHERE id = v_item.batch_id; END IF;
    UPDATE check_intake_items SET status = 'deposited', updated_at = now() WHERE id = v_item.check_id;
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes) VALUES (p_deposit_item_id, v_item.batch_id, 'record_success', p_actor_id, v_item.amount, p_notes);
    RETURN jsonb_build_object('success', true);

  WHEN 'record_failure' THEN
    SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
    IF v_item.status NOT IN ('submitted','processing') THEN RAISE EXCEPTION 'Invalid transition: % -> record_failure', v_item.status; END IF;
    UPDATE deposit_items SET status = 'failed', exception_reason = COALESCE(p_extra->>'error', p_notes), exception_code = p_extra->>'error_code', provider_response = p_extra->'response', updated_at = now() WHERE id = p_deposit_item_id;
    SELECT id INTO v_target_attempt_id FROM deposit_provider_attempts WHERE deposit_item_id = p_deposit_item_id AND status NOT IN ('succeeded','failed') ORDER BY attempt_number DESC LIMIT 1;
    IF v_target_attempt_id IS NOT NULL THEN UPDATE deposit_provider_attempts SET status = 'failed', completed_at = now(), error_message = COALESCE(p_extra->>'error', p_notes), response_payload = p_extra->'response', response_code = (p_extra->>'response_code')::integer WHERE id = v_target_attempt_id; END IF;
    IF v_item.batch_id IS NOT NULL THEN UPDATE deposit_batches SET failed_amount = failed_amount + v_item.amount, status = 'exception', updated_at = now() WHERE id = v_item.batch_id; END IF;
    INSERT INTO deposit_exceptions (deposit_item_id, exception_type, exception_code, description, provider, severity) VALUES (p_deposit_item_id, 'provider_failure', COALESCE(p_extra->>'error_code', 'UNKNOWN'), COALESCE(p_extra->>'error', p_notes, 'Provider reported failure'), v_item.provider, 'critical');
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes) VALUES (p_deposit_item_id, v_item.batch_id, 'record_failure', p_actor_id, v_item.amount, p_notes);
    RETURN jsonb_build_object('success', true);

  WHEN 'record_return' THEN
    SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
    IF v_item.status NOT IN ('succeeded','processing','submitted') THEN RAISE EXCEPTION 'Invalid transition: % -> record_return', v_item.status; END IF;
    UPDATE deposit_items SET status = 'returned', exception_reason = COALESCE(p_notes, 'Deposit returned'), exception_code = 'RETURNED', updated_at = now() WHERE id = p_deposit_item_id;
    IF v_item.batch_id IS NOT NULL THEN UPDATE deposit_batches SET cleared_amount = GREATEST(0, cleared_amount - v_item.amount), failed_amount = failed_amount + v_item.amount, status = 'exception', updated_at = now() WHERE id = v_item.batch_id; END IF;
    INSERT INTO deposit_exceptions (deposit_item_id, exception_type, exception_code, description, provider, severity) VALUES (p_deposit_item_id, 'returned_deposit', 'RETURNED', COALESCE(p_notes, 'Deposit returned by bank'), v_item.provider, 'critical');
    UPDATE check_intake_items SET status = 'needs_review', updated_at = now() WHERE id = v_item.check_id;
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes) VALUES (p_deposit_item_id, v_item.batch_id, 'record_return', p_actor_id, v_item.amount, p_notes);
    RETURN jsonb_build_object('success', true);

  WHEN 'reconcile' THEN
    SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
    IF v_item.status != 'succeeded' THEN RAISE EXCEPTION 'Invalid transition: % -> reconcile', v_item.status; END IF;
    UPDATE deposit_items SET status = 'reconciled', reconciled_amount = COALESCE(p_amount, v_item.amount), reconciled_at = now(), reconciled_by = p_actor_id, updated_at = now() WHERE id = p_deposit_item_id;
    IF p_amount IS NOT NULL AND p_amount != v_item.amount THEN
      INSERT INTO deposit_exceptions (deposit_item_id, exception_type, exception_code, description, provider, severity) VALUES (p_deposit_item_id, 'reconciliation_mismatch', 'RECON_MISMATCH', format('Reconciled $%s vs deposited $%s', p_amount, v_item.amount), v_item.provider, 'warning');
    END IF;
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes) VALUES (p_deposit_item_id, v_item.batch_id, 'reconcile', p_actor_id, COALESCE(p_amount, v_item.amount), p_notes);
    IF v_item.batch_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM deposit_items WHERE batch_id = v_item.batch_id AND status NOT IN ('reconciled','failed','returned')) THEN
        UPDATE deposit_batches SET status = 'cleared', cleared_at = now(), updated_at = now() WHERE id = v_item.batch_id;
      END IF;
    END IF;
    RETURN jsonb_build_object('success', true);

  ELSE RAISE EXCEPTION 'Unknown action: %', p_action;
  END CASE;
END; $$;

-- Reconciliation summary view
CREATE OR REPLACE VIEW public.deposit_reconciliation_summary AS
SELECT
  COUNT(*) FILTER (WHERE di.status = 'pending_assignment') AS pending_assignment,
  COUNT(*) FILTER (WHERE di.status = 'provider_assigned') AS provider_assigned,
  COUNT(*) FILTER (WHERE di.status = 'submitted') AS submitted,
  COUNT(*) FILTER (WHERE di.status = 'succeeded') AS succeeded,
  COUNT(*) FILTER (WHERE di.status = 'failed') AS failed,
  COUNT(*) FILTER (WHERE di.status = 'returned') AS returned,
  COUNT(*) FILTER (WHERE di.status = 'reconciled') AS reconciled,
  COUNT(*) FILTER (WHERE di.status = 'exception') AS exceptions,
  COALESCE(SUM(di.amount) FILTER (WHERE di.status IN ('pending_assignment','provider_assigned','submitted','processing')), 0) AS in_flight_amount,
  COALESCE(SUM(di.amount) FILTER (WHERE di.status = 'succeeded'), 0) AS cleared_amount,
  COALESCE(SUM(di.amount) FILTER (WHERE di.status = 'reconciled'), 0) AS reconciled_amount,
  COALESCE(SUM(di.amount) FILTER (WHERE di.status IN ('failed','returned','exception')), 0) AS failed_amount,
  COALESCE(SUM(di.amount) FILTER (WHERE di.status = 'succeeded'), 0) - COALESCE(SUM(COALESCE(di.reconciled_amount, 0)) FILTER (WHERE di.status = 'reconciled'), 0) AS unreconciled_amount
FROM deposit_items di;

-- RPC wrapper
CREATE OR REPLACE FUNCTION public.get_deposit_reconciliation_summary() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE result jsonb;
BEGIN
  IF NOT has_role(auth.uid(), 'staff') AND NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT row_to_json(r.*) INTO result FROM deposit_reconciliation_summary r;
  RETURN COALESCE(result, '{}'::jsonb);
END; $$;

-- Webhook replay protection
CREATE OR REPLACE FUNCTION public.process_deposit_webhook(p_provider text, p_event_type text, p_event_id text, p_payload jsonb, p_deposit_item_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_existing_id uuid;
BEGIN
  SELECT id INTO v_existing_id FROM deposit_webhook_events WHERE provider = p_provider::deposit_provider AND event_id = p_event_id;
  IF v_existing_id IS NOT NULL THEN
    INSERT INTO deposit_webhook_events (provider, event_type, event_id, payload, deposit_item_id, processed, replay_of)
    VALUES (p_provider::deposit_provider, p_event_type, p_event_id || '_replay_' || substr(gen_random_uuid()::text,1,8), p_payload, p_deposit_item_id, false, v_existing_id);
    RETURN jsonb_build_object('success', false, 'reason', 'duplicate_event', 'original_id', v_existing_id);
  END IF;
  INSERT INTO deposit_webhook_events (provider, event_type, event_id, payload, deposit_item_id, processed, processed_at)
  VALUES (p_provider::deposit_provider, p_event_type, p_event_id, p_payload, p_deposit_item_id, true, now());
  RETURN jsonb_build_object('success', true, 'event_id', p_event_id);
END; $$;
