
-- Recreate reconciliation view with new columns
DROP VIEW IF EXISTS public.deposit_reconciliation_summary;

CREATE VIEW public.deposit_reconciliation_summary AS
SELECT
  COUNT(*) FILTER (WHERE status IN ('pending_assignment','provider_assigned','submitted','processing')) AS in_flight,
  COALESCE(SUM(amount) FILTER (WHERE status IN ('pending_assignment','provider_assigned','submitted','processing')), 0) AS in_flight_amount,
  COUNT(*) FILTER (WHERE status = 'succeeded') AS succeeded,
  COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0) AS cleared_amount,
  COUNT(*) FILTER (WHERE status = 'reconciled') AS reconciled,
  COALESCE(SUM(reconciled_amount) FILTER (WHERE status = 'reconciled'), 0) AS reconciled_amount,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
  COUNT(*) FILTER (WHERE status = 'returned') AS returned,
  COALESCE(SUM(amount) FILTER (WHERE status IN ('failed','returned')), 0) AS failed_amount,
  COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded' AND bank_confirmed_at IS NULL), 0) AS unconfirmed_amount,
  COUNT(*) FILTER (WHERE status = 'succeeded' AND bank_confirmed_at IS NULL) AS unconfirmed_count,
  COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded' AND reconciled_at IS NULL), 0) AS unreconciled_amount,
  COUNT(*) FILTER (WHERE nsf_flag = true) AS nsf_count,
  COALESCE(SUM(amount) FILTER (WHERE nsf_flag = true), 0) AS nsf_amount,
  COUNT(*) FILTER (WHERE variance_amount != 0 AND variance_amount IS NOT NULL) AS variance_count,
  COALESCE(SUM(ABS(variance_amount)) FILTER (WHERE variance_amount != 0 AND variance_amount IS NOT NULL), 0) AS total_variance,
  COUNT(*) FILTER (WHERE accounting_synced_at IS NULL AND status IN ('succeeded','reconciled')) AS unsynced_count,
  (SELECT COUNT(*) FROM deposit_exceptions WHERE resolved_at IS NULL) AS exceptions
FROM deposit_items;

-- Update deposit_action with new Phase 5 actions
CREATE OR REPLACE FUNCTION public.deposit_action(
  p_action text, p_actor_id uuid,
  p_deposit_item_id uuid DEFAULT NULL, p_check_id uuid DEFAULT NULL,
  p_batch_id uuid DEFAULT NULL, p_provider text DEFAULT NULL,
  p_amount numeric DEFAULT NULL, p_notes text DEFAULT NULL,
  p_extra jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_item record; v_check record; v_item_id uuid; v_batch_id uuid;
  v_attempt_id uuid; v_target_attempt_id uuid;
  v_active_providers text[];
  v_variance numeric;
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT array_agg(provider) INTO v_active_providers FROM deposit_provider_config WHERE is_active = true;

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
    IF NOT (p_provider = ANY(COALESCE(v_active_providers, ARRAY[]::text[]))) THEN RAISE EXCEPTION 'Provider "%" is not active or not configured', p_provider; END IF;
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
    UPDATE deposit_items SET status = 'succeeded', provider = COALESCE(v_item.provider, 'manual_branch'), cleared_at = now(),
      deposit_slip_number = COALESCE(p_extra->>'deposit_slip_number', v_item.deposit_slip_number), updated_at = now()
    WHERE id = p_deposit_item_id;
    IF v_item.batch_id IS NOT NULL THEN UPDATE deposit_batches SET cleared_amount = cleared_amount + v_item.amount, updated_at = now() WHERE id = v_item.batch_id; END IF;
    UPDATE check_intake_items SET status = 'deposited', updated_at = now() WHERE id = v_item.check_id;
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes) VALUES (p_deposit_item_id, v_item.batch_id, 'mark_manual_deposit', p_actor_id, v_item.amount, p_notes);
    RETURN jsonb_build_object('success', true);

  WHEN 'bank_confirm' THEN
    SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
    IF v_item.status != 'succeeded' THEN RAISE EXCEPTION 'Can only confirm succeeded deposits, got: %', v_item.status; END IF;
    v_variance := COALESCE(p_amount, v_item.amount) - v_item.amount;
    UPDATE deposit_items SET bank_reference = COALESCE(p_extra->>'bank_reference', v_item.bank_reference),
      bank_confirmed_at = now(), bank_confirmed_by = p_actor_id, variance_amount = v_variance,
      variance_reason = CASE WHEN v_variance != 0 THEN COALESCE(p_extra->>'variance_reason', 'Amount mismatch') ELSE NULL END,
      updated_at = now() WHERE id = p_deposit_item_id;
    IF v_variance != 0 THEN
      INSERT INTO deposit_exceptions (deposit_item_id, exception_type, exception_code, description, provider, severity)
      VALUES (p_deposit_item_id, 'amount_mismatch', 'BANK_VARIANCE',
        format('Bank confirmed $%s vs deposited $%s (Δ $%s)', COALESCE(p_amount, v_item.amount), v_item.amount, v_variance),
        v_item.provider, CASE WHEN abs(v_variance) > 100 THEN 'critical' ELSE 'warning' END);
    END IF;
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes, new_values)
    VALUES (p_deposit_item_id, v_item.batch_id, 'bank_confirm', p_actor_id, COALESCE(p_amount, v_item.amount), p_notes,
      jsonb_build_object('bank_reference', p_extra->>'bank_reference', 'variance', v_variance));
    RETURN jsonb_build_object('success', true, 'variance', v_variance);

  WHEN 'record_nsf' THEN
    SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
    IF v_item.status NOT IN ('succeeded','reconciled') THEN RAISE EXCEPTION 'Can only record NSF for succeeded/reconciled, got: %', v_item.status; END IF;
    UPDATE deposit_items SET status = 'returned', nsf_flag = true, return_reason = COALESCE(p_notes, 'NSF / Insufficient Funds'),
      exception_reason = 'NSF Return', exception_code = 'NSF', updated_at = now() WHERE id = p_deposit_item_id;
    IF v_item.batch_id IS NOT NULL THEN
      UPDATE deposit_batches SET cleared_amount = GREATEST(0, cleared_amount - v_item.amount), failed_amount = failed_amount + v_item.amount, status = 'exception', updated_at = now() WHERE id = v_item.batch_id;
    END IF;
    INSERT INTO deposit_exceptions (deposit_item_id, exception_type, exception_code, description, provider, severity)
    VALUES (p_deposit_item_id, 'returned_deposit', 'NSF', COALESCE(p_notes, 'Check returned NSF'), v_item.provider, 'critical');
    UPDATE check_intake_items SET status = 'needs_review', updated_at = now() WHERE id = v_item.check_id;
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes) VALUES (p_deposit_item_id, v_item.batch_id, 'record_nsf', p_actor_id, v_item.amount, p_notes);
    RETURN jsonb_build_object('success', true);

  WHEN 'sync_accounting' THEN
    SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
    IF v_item.status NOT IN ('succeeded','reconciled') THEN RAISE EXCEPTION 'Can only sync for succeeded/reconciled, got: %', v_item.status; END IF;
    UPDATE deposit_items SET accounting_synced_at = now(), updated_at = now() WHERE id = p_deposit_item_id;
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes) VALUES (p_deposit_item_id, v_item.batch_id, 'sync_accounting', p_actor_id, v_item.amount, p_notes);
    RETURN jsonb_build_object('success', true);

  WHEN 'record_submission' THEN
    SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
    IF v_item.status != 'provider_assigned' THEN RAISE EXCEPTION 'Invalid transition: % -> record_submission', v_item.status; END IF;
    IF EXISTS (SELECT 1 FROM deposit_provider_config WHERE provider = v_item.provider::text AND is_stubbed = true) THEN
      RAISE EXCEPTION 'Provider "%" is stubbed and not available for API submission', v_item.provider;
    END IF;
    UPDATE deposit_items SET status = 'submitted', submitted_at = now(), provider_payload = COALESCE(p_extra->'payload', v_item.provider_payload),
      provider_reference = COALESCE(p_extra->>'provider_reference', v_item.provider_reference), updated_at = now() WHERE id = p_deposit_item_id;
    INSERT INTO deposit_provider_attempts (deposit_item_id, provider, attempt_number, idempotency_key, request_payload, status)
    VALUES (p_deposit_item_id, v_item.provider, (SELECT COALESCE(MAX(attempt_number),0)+1 FROM deposit_provider_attempts WHERE deposit_item_id = p_deposit_item_id), v_item.idempotency_key, p_extra->'payload', 'submitted') RETURNING id INTO v_attempt_id;
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
    UPDATE deposit_items SET status = 'returned', return_reason = COALESCE(p_notes, 'Deposit returned'), exception_reason = COALESCE(p_notes, 'Deposit returned'), exception_code = 'RETURNED', updated_at = now() WHERE id = p_deposit_item_id;
    IF v_item.batch_id IS NOT NULL THEN UPDATE deposit_batches SET cleared_amount = GREATEST(0, cleared_amount - v_item.amount), failed_amount = failed_amount + v_item.amount, status = 'exception', updated_at = now() WHERE id = v_item.batch_id; END IF;
    INSERT INTO deposit_exceptions (deposit_item_id, exception_type, exception_code, description, provider, severity) VALUES (p_deposit_item_id, 'returned_deposit', 'RETURNED', COALESCE(p_notes, 'Deposit returned by bank'), v_item.provider, 'critical');
    UPDATE check_intake_items SET status = 'needs_review', updated_at = now() WHERE id = v_item.check_id;
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes) VALUES (p_deposit_item_id, v_item.batch_id, 'record_return', p_actor_id, v_item.amount, p_notes);
    RETURN jsonb_build_object('success', true);

  WHEN 'reconcile' THEN
    SELECT * INTO v_item FROM deposit_items WHERE id = p_deposit_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit item not found'; END IF;
    IF v_item.status != 'succeeded' THEN RAISE EXCEPTION 'Invalid transition: % -> reconcile', v_item.status; END IF;
    v_variance := COALESCE(p_amount, v_item.amount) - v_item.amount;
    UPDATE deposit_items SET status = 'reconciled', reconciled_amount = COALESCE(p_amount, v_item.amount), reconciled_at = now(), reconciled_by = p_actor_id,
      variance_amount = v_variance, variance_reason = CASE WHEN v_variance != 0 THEN COALESCE(p_extra->>'variance_reason', 'Reconciliation mismatch') ELSE NULL END, updated_at = now()
    WHERE id = p_deposit_item_id;
    IF v_variance != 0 THEN
      INSERT INTO deposit_exceptions (deposit_item_id, exception_type, exception_code, description, provider, severity)
      VALUES (p_deposit_item_id, 'reconciliation_mismatch', 'RECON_MISMATCH', format('Reconciled $%s vs deposited $%s (Δ $%s)', COALESCE(p_amount, v_item.amount), v_item.amount, v_variance), v_item.provider, CASE WHEN abs(v_variance) > 100 THEN 'critical' ELSE 'warning' END);
    END IF;
    INSERT INTO deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes) VALUES (p_deposit_item_id, v_item.batch_id, 'reconcile', p_actor_id, COALESCE(p_amount, v_item.amount), p_notes);
    IF v_item.batch_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM deposit_items WHERE batch_id = v_item.batch_id AND status NOT IN ('reconciled','failed','returned')) THEN
        UPDATE deposit_batches SET status = 'cleared', cleared_at = now(), updated_at = now() WHERE id = v_item.batch_id;
      END IF;
    END IF;
    RETURN jsonb_build_object('success', true, 'variance', v_variance);

  ELSE RAISE EXCEPTION 'Unknown action: %', p_action;
  END CASE;
END; $function$;

-- Storage policy for deposit attachments
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='objects' AND policyname='Staff can manage deposit attachment files') THEN
    CREATE POLICY "Staff can manage deposit attachment files" ON storage.objects
      FOR ALL TO authenticated
      USING (bucket_id = 'deposit-attachments' AND (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin')))
      WITH CHECK (bucket_id = 'deposit-attachments' AND (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin')));
  END IF;
END $$;
