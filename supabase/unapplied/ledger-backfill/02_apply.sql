-- CONTROLLED ledger backfill apply.
-- UNAPPLIED. Do not execute from this PR.
--
-- Idempotent. Tenant-safe. One check → one claim.
-- Stops on cross-tenant / duplicate-identity anomalies rather than repairing blindly.
-- Does not change check status, signatures, disbursements, or providers.
-- Does not delete legitimate history.
-- Discovers current state at execution time. Do not hardcode preflight counts.

BEGIN;

CREATE TEMP TABLE ledger_backfill_linked ON COMMIT DROP AS
SELECT
  ci.id,
  ci.claim_id,
  ci.tenant_id,
  ci.amount,
  ci.check_number,
  ci.carrier_name,
  ci.issue_date,
  ci.payee_line,
  ci.created_at,
  ci.status
FROM public.check_intake_items ci
WHERE ci.claim_id IS NOT NULL;

CREATE TEMP TABLE ledger_backfill_classified ON COMMIT DROP AS
SELECT
  l.id,
  l.claim_id,
  l.tenant_id AS check_tenant_id,
  EXISTS (SELECT 1 FROM public.claims c WHERE c.id = l.claim_id) AS claim_exists,
  ARRAY(
    SELECT DISTINCT x.tenant_id
    FROM (
      SELECT other.tenant_id
      FROM public.check_intake_items other
      WHERE other.claim_id = l.claim_id
        AND other.tenant_id IS NOT NULL
        AND other.id IS DISTINCT FROM l.id
      UNION
      SELECT cc.tenant_id
      FROM public.check_cases cc
      WHERE cc.external_claim_id = l.claim_id
        AND cc.tenant_id IS NOT NULL
      UNION
      SELECT cl.org_id
      FROM public.claims cl
      WHERE cl.id = l.claim_id
        AND cl.org_id IS NOT NULL
      UNION
      SELECT hle.tenant_id
      FROM public.homeowner_ledger_events hle
      WHERE hle.claim_id = l.claim_id
        AND hle.tenant_id IS NOT NULL
      UNION
      SELECT intake.tenant_id
      FROM public.claim_checks chk
      JOIN public.check_intake_items intake ON intake.id = chk.check_intake_item_id
      WHERE chk.claim_id = l.claim_id
        AND intake.tenant_id IS NOT NULL
        AND intake.id IS DISTINCT FROM l.id
      UNION
      SELECT intake.tenant_id
      FROM public.claim_payments cp
      JOIN public.check_intake_items intake ON intake.id = cp.check_intake_item_id
      WHERE cp.claim_id = l.claim_id
        AND intake.tenant_id IS NOT NULL
        AND intake.id IS DISTINCT FROM l.id
    ) x
    WHERE x.tenant_id IS NOT NULL
  ) AS claim_tenant_ids
FROM ledger_backfill_linked l;

DO $$
DECLARE
  v_anomalies integer := 0;
  v_dup_pay integer := 0;
  v_dup_recv integer := 0;
  v_cc_ins integer := 0;
  v_cc_upd integer := 0;
  v_pay_ins integer := 0;
  v_pay_upd integer := 0;
  v_recv_ins integer := 0;
BEGIN
  SELECT COUNT(*) INTO v_anomalies
  FROM ledger_backfill_classified
  WHERE NOT claim_exists
     OR check_tenant_id IS NULL
     OR COALESCE(array_length(claim_tenant_ids, 1), 0) > 1
     OR (
       COALESCE(array_length(claim_tenant_ids, 1), 0) = 1
       AND claim_tenant_ids[1] IS DISTINCT FROM check_tenant_id
     );

  SELECT COUNT(*) INTO v_dup_pay
  FROM (
    SELECT check_intake_item_id
    FROM public.claim_payments
    WHERE check_intake_item_id IS NOT NULL
    GROUP BY check_intake_item_id
    HAVING COUNT(*) > 1
  ) d;

  SELECT COUNT(*) INTO v_dup_recv
  FROM (
    SELECT check_id
    FROM public.homeowner_ledger_events
    WHERE event_type = 'check_received'
      AND check_id IS NOT NULL
    GROUP BY check_id
    HAVING COUNT(*) > 1
  ) d;

  IF v_anomalies > 0 THEN
    RAISE EXCEPTION 'ledger_backfill_stop: cross_tenant_anomaly (%)', v_anomalies;
  END IF;
  IF v_dup_pay > 0 THEN
    RAISE EXCEPTION 'ledger_backfill_stop: duplicate_claim_payments (%)', v_dup_pay;
  END IF;
  IF v_dup_recv > 0 THEN
    RAISE EXCEPTION 'ledger_backfill_stop: duplicate_check_received (%)', v_dup_recv;
  END IF;

  INSERT INTO public.claim_checks (
    claim_id, check_intake_item_id, check_number, amount, carrier_name,
    check_date, payee_line, source, check_type
  )
  SELECT
    l.claim_id,
    l.id,
    COALESCE(l.check_number, 'OCR-' || l.id::text),
    l.amount,
    l.carrier_name,
    COALESCE(l.issue_date, CURRENT_DATE),
    l.payee_line,
    'uploaded_check_ocr',
    'insurance_check'
  FROM ledger_backfill_linked l
  WHERE NOT EXISTS (
    SELECT 1 FROM public.claim_checks chk
    WHERE chk.check_intake_item_id = l.id
  );
  GET DIAGNOSTICS v_cc_ins = ROW_COUNT;

  UPDATE public.claim_checks chk
  SET claim_id = l.claim_id,
      updated_at = now()
  FROM ledger_backfill_linked l
  WHERE chk.check_intake_item_id = l.id
    AND chk.claim_id IS DISTINCT FROM l.claim_id;
  GET DIAGNOSTICS v_cc_upd = ROW_COUNT;

  INSERT INTO public.claim_payments (
    claim_id, check_intake_item_id, amount, payment_method, payment_date,
    recipient_type, direction, check_number, notes
  )
  SELECT
    l.claim_id,
    l.id,
    l.amount,
    'insurance_check',
    COALESCE(l.issue_date, CURRENT_DATE),
    'insured',
    'inbound',
    l.check_number,
    'Insurance check from ' || COALESCE(l.carrier_name, 'Unknown carrier')
  FROM ledger_backfill_linked l
  WHERE l.amount IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.claim_payments cp
      WHERE cp.check_intake_item_id = l.id
    );
  GET DIAGNOSTICS v_pay_ins = ROW_COUNT;

  UPDATE public.claim_payments cp
  SET claim_id = l.claim_id,
      updated_at = now()
  FROM ledger_backfill_linked l
  WHERE cp.check_intake_item_id = l.id
    AND cp.claim_id IS DISTINCT FROM l.claim_id;
  GET DIAGNOSTICS v_pay_upd = ROW_COUNT;

  INSERT INTO public.homeowner_ledger_events (
    tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json
  )
  SELECT
    l.tenant_id,
    l.claim_id,
    l.id,
    'check_received',
    COALESCE(l.created_at, now()),
    l.amount,
    'System',
    jsonb_build_object('status', l.status, 'source', 'ledger_backfill')
  FROM ledger_backfill_linked l
  ON CONFLICT (check_id) WHERE event_type = 'check_received' AND check_id IS NOT NULL
  DO NOTHING;
  GET DIAGNOSTICS v_recv_ins = ROW_COUNT;

  RAISE NOTICE 'ledger_backfill_apply claim_checks_ins=% claim_checks_upd=% payments_ins=% payments_upd=% check_received_ins=%',
    v_cc_ins, v_cc_upd, v_pay_ins, v_pay_upd, v_recv_ins;
END $$;

COMMIT;
