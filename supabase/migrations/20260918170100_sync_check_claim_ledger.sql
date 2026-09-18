-- One check → one claim. Trigger-driven ledger sync.
-- UNAPPLIED in Wave 1 / review patches. Repo artifact only.
--
-- Security model:
-- * SECURITY DEFINER + search_path = public
-- * Trigger-internal only. No authenticated EXECUTE.
-- * PUBLIC/authenticated EXECUTE revoked. service_role only.
-- * Function writes only rows for p_check_id / NEW.id.
-- * RLS is bypassed by SECURITY DEFINER so related claim rows can be
--   mirrored after an RLS-allowed check_intake_items.claim_id write.
-- * Tenant isolation comes from that prior RLS write + scoped WHERE
--   clauses on check_intake_item_id / check_id.

-- Unique payment row per physical check. Index already exists from
-- 20260308154243 (partial unique). Recreate only if missing. If
-- duplicates exist and the index is absent, STOP — do not delete data.
DO $$
DECLARE
  v_dupes integer := 0;
  v_index_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_claim_payments_check_intake'
  ) INTO v_index_exists;

  SELECT COUNT(*) INTO v_dupes
  FROM (
    SELECT check_intake_item_id
    FROM public.claim_payments
    WHERE check_intake_item_id IS NOT NULL
    GROUP BY check_intake_item_id
    HAVING COUNT(*) > 1
  ) d;

  IF v_dupes > 0 AND NOT v_index_exists THEN
    RAISE EXCEPTION
      'sync_check_claim_ledger: % duplicate claim_payments.check_intake_item_id group(s) exist; stop before apply — no data deleted',
      v_dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_payments_check_intake
  ON public.claim_payments(check_intake_item_id)
  WHERE check_intake_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_check_claim_ledger(p_check_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_check public.check_intake_items%ROWTYPE;
  v_claim_check_id uuid;
  v_payment_id uuid;
  v_inserted_received boolean := false;
  v_payment_date date;
BEGIN
  SELECT * INTO v_check
  FROM public.check_intake_items
  WHERE id = p_check_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Check not found';
  END IF;

  IF v_check.claim_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'skipped', true, 'reason', 'unlinked');
  END IF;

  v_payment_date := COALESCE(v_check.issue_date, CURRENT_DATE);

  INSERT INTO public.claim_checks (
    claim_id,
    check_intake_item_id,
    check_number,
    amount,
    carrier_name,
    check_date,
    payee_line,
    source,
    check_type
  ) VALUES (
    v_check.claim_id,
    v_check.id,
    COALESCE(v_check.check_number, 'OCR-' || v_check.id::text),
    v_check.amount,
    v_check.carrier_name,
    v_payment_date,
    v_check.payee_line,
    'uploaded_check_ocr',
    'insurance_check'
  )
  ON CONFLICT (check_intake_item_id)
  DO UPDATE SET
    claim_id = EXCLUDED.claim_id,
    check_number = EXCLUDED.check_number,
    amount = EXCLUDED.amount,
    carrier_name = EXCLUDED.carrier_name,
    check_date = EXCLUDED.check_date,
    payee_line = EXCLUDED.payee_line,
    updated_at = now()
  RETURNING id INTO v_claim_check_id;

  IF v_check.amount IS NOT NULL THEN
    INSERT INTO public.claim_payments (
      claim_id, check_intake_item_id, amount, payment_method, payment_date,
      recipient_type, direction, check_number, notes
    ) VALUES (
      v_check.claim_id,
      v_check.id,
      v_check.amount,
      'insurance_check',
      v_payment_date,
      'insured',
      'inbound',
      v_check.check_number,
      'Insurance check from ' || COALESCE(v_check.carrier_name, 'Unknown carrier')
    )
    ON CONFLICT (check_intake_item_id) WHERE check_intake_item_id IS NOT NULL
    DO UPDATE SET
      claim_id = EXCLUDED.claim_id,
      amount = EXCLUDED.amount,
      check_number = EXCLUDED.check_number,
      notes = EXCLUDED.notes,
      updated_at = now()
    RETURNING id INTO v_payment_id;
  END IF;

  UPDATE public.homeowner_ledger_events
  SET claim_id = v_check.claim_id
  WHERE check_id = v_check.id
    AND (v_check.tenant_id IS NULL OR tenant_id IS NOT DISTINCT FROM v_check.tenant_id)
    AND claim_id IS DISTINCT FROM v_check.claim_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.homeowner_ledger_events
    WHERE check_id = v_check.id AND event_type = 'check_received'
  ) THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json
    ) VALUES (
      v_check.tenant_id,
      v_check.claim_id,
      v_check.id,
      'check_received',
      COALESCE(v_check.created_at, now()),
      v_check.amount,
      'System',
      jsonb_build_object('status', v_check.status, 'source', 'claim_link_sync')
    );
    v_inserted_received := true;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'claim_id', v_check.claim_id,
    'claim_check_id', v_claim_check_id,
    'payment_id', v_payment_id,
    'inserted_check_received', v_inserted_received
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_sync_check_claim_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.claim_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.claim_id IS DISTINCT FROM OLD.claim_id THEN
    PERFORM public.sync_check_claim_ledger(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_check_claim_ledger ON public.check_intake_items;
CREATE TRIGGER trg_sync_check_claim_ledger
AFTER INSERT OR UPDATE OF claim_id ON public.check_intake_items
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_check_claim_ledger();

REVOKE ALL ON FUNCTION public.sync_check_claim_ledger(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_check_claim_ledger(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.trg_sync_check_claim_ledger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_sync_check_claim_ledger() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sync_check_claim_ledger(uuid) TO service_role;
