
-- 1. Add columns to claim_checks for linking to check intake pipeline
ALTER TABLE public.claim_checks
  ADD COLUMN IF NOT EXISTS check_intake_item_id uuid REFERENCES public.check_intake_items(id),
  ADD COLUMN IF NOT EXISTS carrier_name text,
  ADD COLUMN IF NOT EXISTS payee_line text,
  ADD COLUMN IF NOT EXISTS deposit_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS eligibility_status text,
  ADD COLUMN IF NOT EXISTS mortgage_flag boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'manual';

-- Unique constraint to prevent duplicates from OCR auto-post
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_checks_intake_item
  ON public.claim_checks(check_intake_item_id)
  WHERE check_intake_item_id IS NOT NULL;

-- 2. Update ocr_commit_results to auto-upsert into claim_checks
CREATE OR REPLACE FUNCTION public.ocr_commit_results(
  p_check_id uuid, p_carrier_name text, p_check_number text, p_amount numeric,
  p_issue_date text, p_claim_number text, p_payee_line text, p_is_multi_payee boolean,
  p_raw_ocr jsonb, p_ocr_status text, p_check_status text, p_payees jsonb,
  p_recommendation text, p_reasons jsonb, p_rules jsonb, p_evaluated_by uuid,
  p_claim_id uuid DEFAULT NULL, p_has_active_endorsements boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payment_id uuid;
  v_payee record;
  v_existing_payment_id uuid;
  v_accounting_id uuid;
  v_has_mortgage boolean;
  v_payee_names text[];
BEGIN
  -- Step 1: Update check record AND clear heartbeat transactionally
  UPDATE check_intake_items SET
    carrier_name = p_carrier_name,
    check_number = p_check_number,
    amount = p_amount,
    issue_date = p_issue_date::date,
    detected_claim_number = p_claim_number,
    payee_line = p_payee_line,
    is_multi_payee = p_is_multi_payee,
    raw_ocr_front = p_raw_ocr,
    ocr_status = p_ocr_status,
    ocr_heartbeat_at = NULL,
    status = p_check_status,
    deposit_recommendation = p_recommendation,
    deposit_recommendation_reasons = p_reasons,
    updated_at = now()
  WHERE id = p_check_id;

  -- Step 2: Handle payees
  v_has_mortgage := false;
  v_payee_names := ARRAY[]::text[];

  IF NOT p_has_active_endorsements THEN
    DELETE FROM check_payees WHERE check_id = p_check_id;
    
    FOR v_payee IN SELECT * FROM jsonb_array_elements(p_payees)
    LOOP
      INSERT INTO check_payees (check_id, payee_name, payee_type, endorsement_token, endorsement_token_expires_at)
      VALUES (
        p_check_id,
        v_payee.value->>'name',
        COALESCE(v_payee.value->>'type', 'unknown'),
        gen_random_uuid()::text,
        now() + interval '30 days'
      );
      v_payee_names := array_append(v_payee_names, v_payee.value->>'name');
      IF COALESCE(v_payee.value->>'type', 'unknown') = 'mortgage_company' THEN
        v_has_mortgage := true;
      END IF;
    END LOOP;
  ELSE
    -- Check existing payees for mortgage flag
    SELECT EXISTS(
      SELECT 1 FROM check_payees WHERE check_id = p_check_id AND payee_type = 'mortgage_company'
    ) INTO v_has_mortgage;
    SELECT array_agg(payee_name) INTO v_payee_names FROM check_payees WHERE check_id = p_check_id;
  END IF;

  -- Step 3: Upsert eligibility
  DELETE FROM check_eligibility_results WHERE check_id = p_check_id;
  INSERT INTO check_eligibility_results (check_id, recommendation, reasons, rule_results, evaluated_by)
  VALUES (p_check_id, p_recommendation, p_reasons, p_rules, p_evaluated_by);

  -- Step 4: Upsert claim payment linked by check_intake_item_id
  IF p_claim_id IS NOT NULL AND p_amount IS NOT NULL AND p_amount > 0 THEN
    SELECT id INTO v_existing_payment_id
    FROM claim_payments
    WHERE check_intake_item_id = p_check_id
    LIMIT 1;

    IF v_existing_payment_id IS NOT NULL THEN
      UPDATE claim_payments SET
        amount = p_amount,
        check_number = p_check_number,
        notes = 'Insurance check from ' || COALESCE(p_carrier_name, 'Unknown carrier'),
        updated_at = now()
      WHERE id = v_existing_payment_id;
      v_payment_id := v_existing_payment_id;
    ELSE
      INSERT INTO claim_payments (
        claim_id, amount, payment_method, check_number, notes, payment_date,
        recipient_type, direction, check_intake_item_id
      ) VALUES (
        p_claim_id, p_amount, 'insurance_check', p_check_number,
        'Insurance check from ' || COALESCE(p_carrier_name, 'Unknown carrier'),
        COALESCE(p_issue_date::date, now()::date),
        'insured', 'inbound', p_check_id
      )
      RETURNING id INTO v_payment_id;
    END IF;
  END IF;

  -- Step 5: AUTO-POST to Accounting > Checks Received (claim_checks)
  IF p_claim_id IS NOT NULL AND p_amount IS NOT NULL AND p_amount > 0 THEN
    -- Upsert: if a record for this check_intake_item_id already exists, update it
    INSERT INTO claim_checks (
      claim_id, amount, check_date, check_number, check_type, received_date,
      notes, check_intake_item_id, carrier_name, payee_line,
      deposit_status, eligibility_status, mortgage_flag, source, created_by
    ) VALUES (
      p_claim_id,
      p_amount,
      COALESCE(p_issue_date::date, CURRENT_DATE),
      p_check_number,
      'initial',
      CURRENT_DATE,
      format('Auto-posted from check intake. Carrier: %s. Payees: %s',
        COALESCE(p_carrier_name, 'Unknown'),
        array_to_string(COALESCE(v_payee_names, ARRAY['Unknown']), ', ')),
      p_check_id,
      p_carrier_name,
      p_payee_line,
      CASE
        WHEN p_recommendation = 'ready_for_deposit' THEN 'ready'
        WHEN p_recommendation = 'endorsements_pending' THEN 'endorsements_pending'
        WHEN p_recommendation = 'branch_deposit_recommended' THEN 'branch_required'
        ELSE 'pending_review'
      END,
      p_recommendation,
      v_has_mortgage,
      'uploaded_check_ocr',
      p_evaluated_by
    )
    ON CONFLICT (check_intake_item_id) WHERE check_intake_item_id IS NOT NULL
    DO UPDATE SET
      amount = EXCLUDED.amount,
      check_date = EXCLUDED.check_date,
      check_number = EXCLUDED.check_number,
      carrier_name = EXCLUDED.carrier_name,
      payee_line = EXCLUDED.payee_line,
      deposit_status = EXCLUDED.deposit_status,
      eligibility_status = EXCLUDED.eligibility_status,
      mortgage_flag = EXCLUDED.mortgage_flag,
      notes = EXCLUDED.notes,
      updated_at = now()
    RETURNING id INTO v_accounting_id;
  END IF;

  -- Step 6: Audit entries
  INSERT INTO check_audit_log (check_id, event_type, event_description, event_data, actor_id)
  VALUES
    (p_check_id, 'ocr_completed',
     format('OCR extracted %s payee(s), amount: $%s', jsonb_array_length(p_payees), p_amount),
     p_raw_ocr, p_evaluated_by),
    (p_check_id, 'eligibility_evaluated',
     format('Recommendation: %s', p_recommendation),
     jsonb_build_object('recommendation', p_recommendation, 'reasons', p_reasons), p_evaluated_by);

  IF v_payment_id IS NOT NULL THEN
    INSERT INTO check_audit_log (check_id, event_type, event_description, event_data, actor_id)
    VALUES (p_check_id, 'claim_wallet_entry',
      format('Payment of $%s linked to claim', p_amount),
      jsonb_build_object('claim_id', p_claim_id, 'payment_id', v_payment_id), p_evaluated_by);
  END IF;

  IF v_accounting_id IS NOT NULL THEN
    INSERT INTO check_audit_log (check_id, event_type, event_description, event_data, actor_id)
    VALUES (p_check_id, 'accounting_auto_posted',
      format('Auto-posted $%s to Accounting > Checks Received', p_amount),
      jsonb_build_object('claim_id', p_claim_id, 'accounting_check_id', v_accounting_id, 'mortgage_flag', v_has_mortgage), p_evaluated_by);
  END IF;

  RETURN jsonb_build_object('success', true, 'payment_id', v_payment_id, 'accounting_id', v_accounting_id);
END;
$function$;

-- 3. Create view for stale unsigned endorsements (for work queue)
CREATE OR REPLACE VIEW public.stale_endorsements AS
SELECT
  ce.id AS endorsement_id,
  ce.check_id,
  ce.payee_name,
  ce.payee_type,
  ce.status,
  ce.contact_email,
  ce.contact_phone,
  ce.request_sent_at,
  ce.last_reminder_at,
  ce.reminder_count,
  ce.created_at,
  ci.check_number,
  ci.carrier_name,
  ci.amount,
  ci.claim_id,
  EXTRACT(EPOCH FROM (now() - COALESCE(ce.last_reminder_at, ce.request_sent_at, ce.created_at))) / 3600 AS hours_since_last_contact,
  CASE
    WHEN ce.reminder_count >= 5 THEN 'escalation_needed'
    WHEN EXTRACT(EPOCH FROM (now() - COALESCE(ce.last_reminder_at, ce.request_sent_at, ce.created_at))) / 3600 > 48 THEN 'reminder_due'
    ELSE 'ok'
  END AS staleness_status
FROM check_endorsements ce
JOIN check_intake_items ci ON ci.id = ce.check_id
WHERE ce.status IN ('pending', 'sent')
  AND ce.payee_type != 'mortgage_company'
ORDER BY hours_since_last_contact DESC;

-- 4. Function to sync check status when deposit status changes
CREATE OR REPLACE FUNCTION public.sync_accounting_deposit_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- When check_intake_items status changes, update the accounting entry
  IF NEW.status IS DISTINCT FROM OLD.status AND EXISTS (
    SELECT 1 FROM claim_checks WHERE check_intake_item_id = NEW.id
  ) THEN
    UPDATE claim_checks SET
      deposit_status = CASE
        WHEN NEW.status = 'approved_for_deposit' THEN 'approved'
        WHEN NEW.status = 'deposited' THEN 'deposited'
        WHEN NEW.status = 'reissue_requested' THEN 'reissue_requested'
        WHEN NEW.status = 'needs_review' THEN 'pending_review'
        WHEN NEW.status = 'endorsements_in_progress' THEN 'endorsements_pending'
        WHEN NEW.status = 'endorsements_complete' THEN 'endorsements_complete'
        WHEN NEW.status = 'branch_deposit_required' THEN 'branch_required'
        WHEN NEW.status = 'ready' THEN 'ready'
        ELSE deposit_status
      END,
      updated_at = now()
    WHERE check_intake_item_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER trg_sync_accounting_deposit_status
  AFTER UPDATE ON public.check_intake_items
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_accounting_deposit_status();
