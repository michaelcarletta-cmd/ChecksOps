-- SQL 147: record a payment made outside ChecksOps against a check, in one server transaction.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: owner report 2026-11-09 (production): "i could not record an external payment. If someone
-- disburses the check outside of checksops but wants to track it, they still should be able to.
-- Disburse outside of Checksops should allow them to input the check #, amount, recipient, memo and
-- the funds will move as if they were sent via moov for tracking".
-- Both screens that record such a payment (the check's Funds tab "Disburse Outside ChecksOps" form,
-- src/components/payments/FundsTab.tsx, and the Disbursement Console's "External / Manual" speed,
-- src/components/disbursement/DisbursementConsole.tsx) write public.disbursement_batches and
-- public.disbursement_splits from the browser through the generic /data/write route. On AWS that
-- route refuses both tables before any SQL runs (aws/functions/api/write-allowlist.mjs:
-- FINANCIAL_OR_PROVIDER_TABLES; 403 table_not_allowlisted, reason financial_or_provider), so the
-- first insert fails and nothing is recorded. No API route writes these tables for a tenant today.
--
-- What an external payment records, and why: exactly the rows the tracking screens already read for
-- a payment, and nothing that belongs to the payment provider:
--   - one public.disbursement_batches row: the check, the organization, created_by / approved_by =
--     the signed-in user, status 'completed', completed_at / approved_at now();
--   - one public.disbursement_splits row per payee: status 'settled', method 'external_check' (in
--     disbursement_splits_method_check), the payee's name / type / stakeholder account, the outside
--     check number, the memo (external_notes), settled_at now().
--   The existing SECURITY DEFINER triggers then move the check exactly as for any settled payout
--   (trg_advance_stage_on_disbursement / trg_advance_stage_on_batch_complete ->
--   recompute_check_release_stage: Deposited -> Funds Released). Remaining-to-disburse, the Funds
--   Released tab, stakeholder balances, Payments & Financials, the recipient and tax reports all read
--   settled splits, so they count it as they count a payment.
--   Not written: public.payment_transfers (a Moov transfer leg: the Moov webhook, status catch-up
--   and the send planner act on those rows), public.payment_wallet_ledger and the wallet balance
--   (they mirror the provider's real balance, which an outside check does not change),
--   payment_event_log. No provider call is possible from SQL.
--
-- What this file does:
-- 1) public.aws_record_external_disbursement(_tenant_id uuid, _check_intake_item_id uuid,
--    _payments jsonb, _idempotency_key text) RETURNS jsonb: new, plpgsql, VOLATILE, SECURITY DEFINER,
--    search_path = public, pg_temp, owned by the applying login.
--      a. caller: auth.uid() present and a member of _tenant_id (public.aws_can_write_tenant, SQL 90:
--         membership only; the platform owner, partners and other tenants are refused) else 42501
--         external_disbursement_forbidden;
--      b. inputs (22023 external_disbursement_invalid: <what>): an idempotency key of 8-100 characters
--         [A-Za-z0-9_:-]; 1-10 payments, each amount_cents a whole number > 0, a recipient_name
--         (<= 200) or a stakeholder_account_id, recipient_type null or one of the Funds tab's types,
--         external_check_number <= 40, memo <= 500. A stakeholder account must be the tenant's own or
--         the payout account on this tenant's check_stakeholders row for this check (a partner's);
--      c. the check, locked FOR UPDATE (so two records for the same check run one after the other):
--         it must exist and belong to _tenant_id, else P0002 external_disbursement_check_not_found
--         (the same answer for another tenant's check: tenant isolation);
--      d. idempotency: when splits with idempotence_key 'external:<key>:<n>' already exist for the
--         tenant, the same payments return the recorded batch with duplicate true and nothing new is
--         written; different payments under the key are 23505 external_disbursement_key_reused;
--      e. available = the check amount - the saved PA fee (pa_fee_pct of the amount when set, else
--         pa_fee_amount; the Funds tab's rule) - this tenant's splits on the check that did not fail
--         (batch not failed / cancelled; split not failed / cancelled / returned) - this tenant's Moov
--         send legs for the check (payment_transfers leg_role send_wallet / send_bank) that did not
--         fail (not failed / failure / canceled / cancelled / returned / reversed), all in cents.
--         A total above it is P0001 external_disbursement_exceeds_available: available_cents=<n>;
--      f. writes the batch and the splits above. Returns {batch_id, split_ids, duplicate, total_cents,
--         available_before_cents, remaining_cents, fully_disbursed}.
-- 2) EXECUTE: REVOKE ALL FROM PUBLIC, and from anon, authenticated and service_role where those roles
--    exist; GRANT EXECUTE TO checksops (the API login). No generic RPC route lists it
--    (aws/functions/api/data.mjs READ_RPCS, workflow-rpc.mjs SAFE_WRITE_RPCS); only
--    aws/functions/api/external-disbursement.mjs (route record-external-disbursement) calls it.
--
-- Not changed: no table, column, index, policy, RLS setting, table grant, trigger or existing row; no
-- other function. The generic /data/write route keeps refusing both tables.
--
-- Refuses to run (55000 sql147_prerequisite_missing) without the relations, columns, helper functions
-- and the role it uses, and (55000 sql147_definer_cannot_write) unless the applying login owns
-- public.disbursement_batches, public.disbursement_splits, public.check_intake_items,
-- public.payment_transfers, public.stakeholder_accounts and public.check_stakeholders without FORCE
-- ROW LEVEL SECURITY, or is a superuser or BYPASSRLS: a DEFINER filtered by RLS would under-count
-- what was already paid.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change: staging first, then production,
-- through the guarded SQL path (AGENTS.md).

DO $sql147_prereq$
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
      ('check_intake_items', 'amount'), ('check_intake_items', 'pa_fee_pct'),
      ('check_intake_items', 'pa_fee_amount'),
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
    RAISE EXCEPTION 'sql147_prerequisite_missing: SQL 147 needs the disbursement, check, transfer and stakeholder schema and SQL 90 first; missing %',
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
    RAISE EXCEPTION 'sql147_definer_cannot_write: the login running SQL 147 must own % (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS',
      v_unreachable
      USING ERRCODE = '55000';
  END IF;
END
$sql147_prereq$;

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
  v_fee bigint;
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
  SELECT ci.id, ci.tenant_id, ci.amount, ci.pa_fee_pct, ci.pa_fee_amount INTO v_check
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

  -- Available on this check, in cents (the Funds tab's rule, server side).
  v_gross := round(COALESCE(v_check.amount, 0) * 100)::bigint;
  IF v_check.pa_fee_pct IS NOT NULL THEN
    v_fee := CASE WHEN v_check.pa_fee_pct > 0 THEN round(v_gross * v_check.pa_fee_pct / 100)::bigint ELSE 0 END;
  ELSE
    v_fee := round(COALESCE(v_check.pa_fee_amount, 0) * 100)::bigint;
  END IF;
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
  v_available := GREATEST(0, v_gross - v_fee - v_split_out - v_sent_out);

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

DO $sql147_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_record_external_disbursement(uuid, uuid, jsonb, text) FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql147_revoke$;

GRANT EXECUTE ON FUNCTION public.aws_record_external_disbursement(uuid, uuid, jsonb, text) TO checksops;
