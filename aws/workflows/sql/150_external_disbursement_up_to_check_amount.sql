-- SQL 150: a payment made outside ChecksOps can be recorded up to the check amount (the PA fee is not subtracted).
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: owner report 2026-11-10 (production): recording an outside payment on the check's Funds tab was refused with
-- "Amount exceeds what is left on this check" although the form showed the whole check amount available; "I should be
-- able to disburse the whole thing if I want ... there should be no rules holding back disbursing here", then "I want
-- to be able to record up to the check amount". SQL 147 (applied in staging and production 2026-11-10) caps an
-- outside payment at the check amount less the saved PA fee (pa_fee_pct of the amount when set, else pa_fee_amount)
-- less what was already paid out of the check. A payment made outside ChecksOps is not bound by the PA fee ChecksOps
-- would hold back on its own sends.
--
-- What this file does: CREATE OR REPLACE public.aws_record_external_disbursement(uuid, uuid, jsonb, text), the
-- function SQL 147 created, with one change: available = the check amount - this tenant's splits on the check that
-- did not fail (batch not failed / cancelled; split not failed / cancelled / returned) - this tenant's Moov send legs
-- for the check (payment_transfers leg_role send_wallet / send_bank) that did not fail (not failed / failure /
-- canceled / cancelled / returned / reversed), in cents. The saved PA fee is no longer subtracted, so the check
-- columns pa_fee_pct and pa_fee_amount are no longer read. Everything else is SQL 147's, unchanged: the caller check
-- (auth.uid() a member of the tenant: SQL 90's aws_can_write_tenant, else 42501 external_disbursement_forbidden), the
-- input checks (22023 external_disbursement_invalid), the check locked FOR UPDATE and owned by the tenant (P0002
-- external_disbursement_check_not_found), the idempotency key (a repeat returns the recorded batch; other payments
-- under the key are 23505 external_disbursement_key_reused), a total above what is available is still P0001
-- external_disbursement_exceeds_available: available_cents=<n> (what was already recorded still counts, so the check
-- cannot be recorded past its amount), the batch and split rows written, the result object, SECURITY DEFINER,
-- VOLATILE, search_path public, pg_temp, RETURNS jsonb, owned by the applying login. EXECUTE: REVOKE ALL FROM PUBLIC,
-- and from anon, authenticated and service_role where those roles exist; GRANT EXECUTE TO checksops (the API login),
-- as in SQL 147.
--
-- Not changed: no table, column, index, policy, RLS setting, table grant, trigger or existing row; no other function.
-- The PA fee stays saved on the check and still applies to ChecksOps sends on the Funds tab.
--
-- Refuses to run (55000 sql150_prerequisite_missing) without the relations, columns, helper functions and the role it
-- uses, and (55000 sql150_definer_cannot_write) unless the applying login owns public.disbursement_batches,
-- public.disbursement_splits, public.check_intake_items, public.payment_transfers, public.stakeholder_accounts and
-- public.check_stakeholders without FORCE ROW LEVEL SECURITY, or is a superuser or BYPASSRLS.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction.
-- Idempotent: safe to run more than once; it also installs the function where SQL 147 never ran. Not applied by this
-- change: staging first, then production, through the guarded SQL path (AGENTS.md).

DO $sql150_prereq$
DECLARE
  v_missing text[];
  v_unreachable text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.disbursement_batches', pg_catalog.to_regclass('public.disbursement_batches')::oid),
      ('public.disbursement_splits', pg_catalog.to_regclass('public.disbursement_splits')::oid),
      ('public.check_intake_items', pg_catalog.to_regclass('public.check_intake_items')::oid),
      ('public.payment_transfers', pg_catalog.to_regclass('public.payment_transfers')::oid),
      ('public.stakeholder_accounts', pg_catalog.to_regclass('public.stakeholder_accounts')::oid),
      ('public.check_stakeholders', pg_catalog.to_regclass('public.check_stakeholders')::oid),
      ('public.aws_can_write_tenant(uuid)', pg_catalog.to_regprocedure('public.aws_can_write_tenant(uuid)')::oid),
      ('auth.uid()', pg_catalog.to_regprocedure('auth.uid()')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('disbursement_batches', 'id'), ('disbursement_batches', 'tenant_id'),
      ('disbursement_batches', 'check_intake_item_id'), ('disbursement_batches', 'created_by'),
      ('disbursement_batches', 'check_amount'), ('disbursement_batches', 'available_amount'),
      ('disbursement_batches', 'reserve_held'), ('disbursement_batches', 'status'),
      ('disbursement_batches', 'notes'), ('disbursement_batches', 'completed_at'),
      ('disbursement_batches', 'approved_at'), ('disbursement_batches', 'approved_by'),
      ('disbursement_batches', 'approved_amount_cents'),
      ('disbursement_splits', 'id'), ('disbursement_splits', 'batch_id'),
      ('disbursement_splits', 'tenant_id'), ('disbursement_splits', 'amount'),
      ('disbursement_splits', 'status'), ('disbursement_splits', 'method'),
      ('disbursement_splits', 'external_check_number'), ('disbursement_splits', 'recipient_name'),
      ('disbursement_splits', 'recipient_type'), ('disbursement_splits', 'external_notes'),
      ('disbursement_splits', 'stakeholder_account_id'), ('disbursement_splits', 'idempotence_key'),
      ('disbursement_splits', 'settled_at'),
      ('check_intake_items', 'id'), ('check_intake_items', 'tenant_id'),
      ('check_intake_items', 'amount'),
      ('payment_transfers', 'tenant_id'), ('payment_transfers', 'check_id'),
      ('payment_transfers', 'leg_role'), ('payment_transfers', 'status'),
      ('payment_transfers', 'amount_cents'),
      ('stakeholder_accounts', 'id'), ('stakeholder_accounts', 'tenant_id'),
      ('stakeholder_accounts', 'nickname'),
      ('check_stakeholders', 'check_intake_item_id'), ('check_stakeholders', 'tenant_id'),
      ('check_stakeholders', 'stakeholder_account_id')) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql150_prerequisite_missing: SQL 150 needs the disbursement, check, transfer and stakeholder schema and SQL 90 first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(t.oid::regclass::text, ', ' ORDER BY t.oid::regclass::text) INTO v_unreachable
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_roles me ON me.rolname = current_user
  WHERE t.oid IN (
      pg_catalog.to_regclass('public.disbursement_batches'), pg_catalog.to_regclass('public.disbursement_splits'),
      pg_catalog.to_regclass('public.check_intake_items'), pg_catalog.to_regclass('public.payment_transfers'),
      pg_catalog.to_regclass('public.stakeholder_accounts'), pg_catalog.to_regclass('public.check_stakeholders'))
    AND NOT (me.rolsuper OR me.rolbypassrls
             OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity));
  IF v_unreachable IS NOT NULL THEN
    RAISE EXCEPTION 'sql150_definer_cannot_write: the login running SQL 150 must own % (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS',
      v_unreachable
      USING ERRCODE = '55000';
  END IF;
END
$sql150_prereq$;

CREATE OR REPLACE FUNCTION public.aws_record_external_disbursement(
  _tenant_id uuid,
  _check_intake_item_id uuid,
  _payments jsonb,
  _idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_check record;
  v_payment jsonb;
  v_n integer;
  v_i integer;
  v_cents bigint;
  v_total bigint := 0;
  v_name text;
  v_type text;
  v_number text;
  v_memo text;
  v_account uuid;
  v_account_name text;
  v_rows jsonb := '[]'::jsonb;
  v_existing jsonb;
  v_existing_batch uuid;
  v_gross bigint;
  v_split_out bigint;
  v_sent_out bigint;
  v_available bigint;
  v_batch uuid;
  v_split uuid;
  v_split_ids jsonb := '[]'::jsonb;
  v_row jsonb;
BEGIN
  IF v_uid IS NULL OR _tenant_id IS NULL OR NOT COALESCE(public.aws_can_write_tenant(_tenant_id), false) THEN
    RAISE EXCEPTION 'external_disbursement_forbidden'
      USING ERRCODE = '42501';
  END IF;

  IF _idempotency_key IS NULL OR _idempotency_key !~ '^[A-Za-z0-9_:-]{8,100}$' THEN
    RAISE EXCEPTION 'external_disbursement_invalid: idempotency_key'
      USING ERRCODE = '22023';
  END IF;
  IF _check_intake_item_id IS NULL THEN
    RAISE EXCEPTION 'external_disbursement_invalid: check'
      USING ERRCODE = '22023';
  END IF;
  IF _payments IS NULL OR jsonb_typeof(_payments) <> 'array' THEN
    RAISE EXCEPTION 'external_disbursement_invalid: payments'
      USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(_payments);
  IF v_n < 1 OR v_n > 10 THEN
    RAISE EXCEPTION 'external_disbursement_invalid: payments'
      USING ERRCODE = '22023';
  END IF;

  -- The check, locked: records for one check run one after the other.
  SELECT ci.id, ci.tenant_id, ci.amount INTO v_check
    FROM public.check_intake_items ci
   WHERE ci.id = _check_intake_item_id
   FOR UPDATE;
  IF NOT FOUND OR v_check.tenant_id IS DISTINCT FROM _tenant_id THEN
    RAISE EXCEPTION 'external_disbursement_check_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Normalize and validate each payment.
  FOR v_i IN 0 .. v_n - 1 LOOP
    v_payment := _payments -> v_i;
    IF jsonb_typeof(v_payment) <> 'object' THEN
      RAISE EXCEPTION 'external_disbursement_invalid: payment %', v_i
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_payment -> 'amount_cents') <> 'number'
       OR (v_payment ->> 'amount_cents') !~ '^[0-9]{1,12}$'
       OR (v_payment ->> 'amount_cents')::bigint <= 0 THEN
      RAISE EXCEPTION 'external_disbursement_invalid: amount_cents'
        USING ERRCODE = '22023';
    END IF;
    v_cents := (v_payment ->> 'amount_cents')::bigint;
    v_name := NULLIF(btrim(COALESCE(v_payment ->> 'recipient_name', '')), '');
    v_type := NULLIF(btrim(COALESCE(v_payment ->> 'recipient_type', '')), '');
    v_number := NULLIF(btrim(COALESCE(v_payment ->> 'external_check_number', '')), '');
    v_memo := NULLIF(btrim(COALESCE(v_payment ->> 'memo', '')), '');
    v_account := NULL;
    IF NULLIF(v_payment ->> 'stakeholder_account_id', '') IS NOT NULL THEN
      IF (v_payment ->> 'stakeholder_account_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'external_disbursement_invalid: stakeholder_account_id'
          USING ERRCODE = '22023';
      END IF;
      v_account := (v_payment ->> 'stakeholder_account_id')::uuid;
      -- The tenant's own account, or the payout account on this tenant's row for this check (a partner's).
      SELECT sa.nickname INTO v_account_name
        FROM public.stakeholder_accounts sa
       WHERE sa.id = v_account
         AND (sa.tenant_id = _tenant_id
              OR EXISTS (SELECT 1 FROM public.check_stakeholders cs
                          WHERE cs.check_intake_item_id = _check_intake_item_id
                            AND cs.tenant_id = _tenant_id
                            AND cs.stakeholder_account_id = v_account));
      IF NOT FOUND THEN
        RAISE EXCEPTION 'external_disbursement_invalid: stakeholder_account_id'
          USING ERRCODE = '22023';
      END IF;
      v_name := COALESCE(v_name, NULLIF(btrim(COALESCE(v_account_name, '')), ''));
    END IF;
    IF v_name IS NULL AND v_account IS NULL THEN
      RAISE EXCEPTION 'external_disbursement_invalid: recipient_name'
        USING ERRCODE = '22023';
    END IF;
    IF length(COALESCE(v_name, '')) > 200
       OR length(COALESCE(v_number, '')) > 40
       OR length(COALESCE(v_memo, '')) > 500 THEN
      RAISE EXCEPTION 'external_disbursement_invalid: text too long'
        USING ERRCODE = '22023';
    END IF;
    IF v_type IS NOT NULL AND v_type NOT IN
       ('subcontractor', 'contractor', 'sales_rep', 'appraisal', 'supplier', 'adjuster', 'vendor', 'insured', 'other') THEN
      RAISE EXCEPTION 'external_disbursement_invalid: recipient_type'
        USING ERRCODE = '22023';
    END IF;
    v_total := v_total + v_cents;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'amount_cents', v_cents, 'recipient_name', v_name, 'recipient_type', v_type,
      'external_check_number', v_number, 'memo', v_memo, 'stakeholder_account_id', v_account));
  END LOOP;

  -- Idempotency: the same key returns what it recorded; different payments under it are refused.
  SELECT jsonb_agg(jsonb_build_object(
           'amount_cents', round(s.amount * 100)::bigint,
           'recipient_name', s.recipient_name,
           'stakeholder_account_id', s.stakeholder_account_id,
           'external_check_number', s.external_check_number,
           'id', s.id) ORDER BY s.idempotence_key),
         min(s.batch_id::text)::uuid
    INTO v_existing, v_existing_batch
    FROM public.disbursement_splits s
   WHERE s.tenant_id = _tenant_id
     AND s.idempotence_key LIKE 'external:' || _idempotency_key || ':%';
  IF v_existing IS NOT NULL THEN
    IF jsonb_array_length(v_existing) <> v_n THEN
      RAISE EXCEPTION 'external_disbursement_key_reused'
        USING ERRCODE = '23505';
    END IF;
    FOR v_i IN 0 .. v_n - 1 LOOP
      IF (v_existing -> v_i ->> 'amount_cents') IS DISTINCT FROM (v_rows -> v_i ->> 'amount_cents')
         OR (v_existing -> v_i ->> 'recipient_name') IS DISTINCT FROM (v_rows -> v_i ->> 'recipient_name')
         OR (v_existing -> v_i ->> 'stakeholder_account_id') IS DISTINCT FROM (v_rows -> v_i ->> 'stakeholder_account_id')
         OR (v_existing -> v_i ->> 'external_check_number') IS DISTINCT FROM (v_rows -> v_i ->> 'external_check_number') THEN
        RAISE EXCEPTION 'external_disbursement_key_reused'
          USING ERRCODE = '23505';
      END IF;
      v_split_ids := v_split_ids || jsonb_build_array(v_existing -> v_i -> 'id');
    END LOOP;
  END IF;

  -- Available on this check, in cents: up to the check amount, less what was already paid out of it (SQL 150: the PA
  -- fee is not subtracted for a payment made outside ChecksOps).
  v_gross := round(COALESCE(v_check.amount, 0) * 100)::bigint;
  SELECT COALESCE(sum(round(s.amount * 100)), 0)::bigint INTO v_split_out
    FROM public.disbursement_splits s
    JOIN public.disbursement_batches b ON b.id = s.batch_id
   WHERE b.check_intake_item_id = _check_intake_item_id
     AND b.tenant_id = _tenant_id
     AND lower(COALESCE(b.status, '')) NOT IN ('failed', 'cancelled', 'canceled')
     AND lower(COALESCE(s.status, '')) NOT IN ('failed', 'cancelled', 'canceled', 'returned');
  SELECT COALESCE(sum(pt.amount_cents), 0)::bigint INTO v_sent_out
    FROM public.payment_transfers pt
   WHERE pt.check_id = _check_intake_item_id
     AND pt.tenant_id = _tenant_id
     AND pt.leg_role IN ('send_wallet', 'send_bank')
     AND lower(COALESCE(pt.status, '')) NOT IN ('failed', 'failure', 'canceled', 'cancelled', 'returned', 'reversed');
  v_available := GREATEST(0, v_gross - v_split_out - v_sent_out);

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'batch_id', v_existing_batch, 'split_ids', v_split_ids, 'duplicate', true,
      'total_cents', v_total, 'available_before_cents', v_available + v_total,
      'remaining_cents', v_available, 'fully_disbursed', v_available = 0);
  END IF;

  IF v_total > v_available THEN
    RAISE EXCEPTION 'external_disbursement_exceeds_available: available_cents=%', v_available
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.disbursement_batches
    (tenant_id, check_intake_item_id, created_by, check_amount, available_amount, reserve_held,
     status, notes, completed_at, approved_at, approved_by, approved_amount_cents)
  VALUES (_tenant_id, _check_intake_item_id, v_uid, v_gross::numeric / 100, v_available::numeric / 100, 0,
          'completed',
          left('Recorded outside ChecksOps (no money moved by ChecksOps): '
               || (SELECT string_agg(
                      COALESCE('check #' || (r ->> 'external_check_number') || ' ', '')
                      || 'to ' || COALESCE(r ->> 'recipient_name', 'stakeholder'), '; ')
                     FROM jsonb_array_elements(v_rows) AS r), 1000),
          now(), now(), v_uid, v_total)
  RETURNING id INTO v_batch;

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_row := v_rows -> v_i;
    INSERT INTO public.disbursement_splits
      (batch_id, tenant_id, amount, status, method, external_check_number, recipient_name,
       recipient_type, external_notes, stakeholder_account_id, idempotence_key, settled_at)
    VALUES (v_batch, _tenant_id, (v_row ->> 'amount_cents')::bigint::numeric / 100, 'settled', 'external_check',
            v_row ->> 'external_check_number', v_row ->> 'recipient_name', v_row ->> 'recipient_type',
            v_row ->> 'memo', NULLIF(v_row ->> 'stakeholder_account_id', '')::uuid,
            'external:' || _idempotency_key || ':' || lpad(v_i::text, 2, '0'), now())
    RETURNING id INTO v_split;
    v_split_ids := v_split_ids || jsonb_build_array(v_split);
  END LOOP;

  RETURN jsonb_build_object(
    'batch_id', v_batch, 'split_ids', v_split_ids, 'duplicate', false,
    'total_cents', v_total, 'available_before_cents', v_available,
    'remaining_cents', v_available - v_total, 'fully_disbursed', v_available - v_total = 0);
END;
$$;

REVOKE ALL ON FUNCTION public.aws_record_external_disbursement(uuid, uuid, jsonb, text) FROM PUBLIC;

DO $sql150_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_record_external_disbursement(uuid, uuid, jsonb, text) FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql150_revoke$;

GRANT EXECUTE ON FUNCTION public.aws_record_external_disbursement(uuid, uuid, jsonb, text) TO checksops;
