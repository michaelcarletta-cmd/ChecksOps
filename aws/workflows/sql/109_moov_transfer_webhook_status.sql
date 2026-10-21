-- SQL 109: Moov transfer status, returns and NOCs written back from the verified webhook.
--
-- Why: production Moov webhooks are verified and logged (aws_provider_webhook_receipts), but
-- the API writes back only onboarding status and tenant fee-collection outcomes. A wallet
-- funding (bank -> wallet) or a send (wallet or bank -> stakeholder / partner) keeps the status
-- Moov gave when it was created, so a later failure, an ACH return (R01 insufficient funds,
-- R10 not authorized, ...) or a reversal never reaches ChecksOps. The webhook runs as
-- checksops with no user: under RLS it can neither read nor update another tenant's
-- payment_transfers rows (aws_select_payment_transfers / aws_write_payment_transfers need a
-- signed-in member or platform role), so the write-back needs one narrow SECURITY DEFINER
-- writer, as SQL 99 did for check_messages.
--
-- What this file does:
-- 1) public.aws_moov_webhook_apply_transfer_status(...) (new, SECURITY DEFINER,
--    search_path = public, owned by the applying login like the other aws/workflows/sql
--    DEFINER functions). Callable only while the webhook route has set
--    request.provider_webhook_apply = '1' (public.aws_moov_webhook_apply_active(), SQL 91);
--    42501 moov_webhook_apply_required otherwise. EXECUTE: checksops only (revoked from PUBLIC).
--    It touches exactly one public.payment_transfers row: provider 'moov', the given
--    environment ('production' or 'sandbox'), the given provider_transfer_id (unique by
--    payment_transfers_provider_id_uniq), locked FOR UPDATE, and only when its leg_role is
--    wallet_funding, send_wallet or send_bank (the funding and send legs the API creates;
--    tenant fee collection legs stay with tenant-collection-v2-settlement.mjs). The tenant is
--    the row's own tenant_id; nothing in the webhook payload chooses a tenant.
--      a. Idempotent per Moov event: an event id already recorded for this transfer in
--         payment_event_log (provider_metadata.moov_event_id) is answered duplicate_event
--         and changes nothing.
--      b. Never backwards: statuses rank draft/ready/submitting/unknown 0, submitted 1,
--         pending/processing 2, completed 3, failed/canceled 4, returned 5. The status moves
--         only to a higher rank, so a late or replayed 'pending' or 'completed' never
--         overwrites a failure or a return, and a return after completion is applied.
--         An equal rank with a different status (canceled after failed) keeps the first.
--      c. On a move it sets status, provider_status, completed_at (completed only, kept when
--         set), failure_reason (failed / returned / canceled: "ACH return R01: <reason>" when
--         Moov gave a return code) and merges into provider_metadata: moov_last_webhook
--         {event_id, event_type, provider_status, status, at}, moov_return {code, reason,
--         event_id, at} for an R code, and manual_follow_up {reason, at} when an accepted
--         transfer (rank >= 1) failed, was returned or was canceled.
--      d. A notification of change (NOC, a C code) never changes the status: it is merged as
--         moov_correction {code, reason, event_id, at} with manual_follow_up, so the bank
--         details are corrected by a person; nothing here edits a payment method.
--      e. Every handled event (applied, unchanged, stale, correction) appends one
--         payment_event_log row: provider 'moov', the row's environment and tenant_id,
--         transfer_id, provider_transfer_id, event_type (the Moov type), previous_status,
--         new_status (the row's status afterwards), provider_metadata {moov_event_id,
--         outcome, provider_status, return_code, return_reason, correction_code,
--         correction_reason, manual_follow_up}. Duplicate, not owned and unknown transfers
--         write nothing (the webhook receipt already records the delivery).
--    Returns jsonb {transfer_id, tenant_id, leg_role, previous_status, new_status, outcome
--    (applied | unchanged | stale | correction | duplicate_event | not_owned |
--    unknown_transfer), notify (true only on the one move into failed or returned)}.
--    Input checks: an environment other than production / sandbox, an empty transfer or event
--    id, or a status outside the ChecksOps set is refused with 22023; a return code not shaped
--    R + two digits, or a correction code not shaped C + two digits, is ignored (NULL). Text
--    inputs are cut to the lengths the columns are used with.
--
-- Not changed: no table, column, policy or grant on any table; no wallet ledger entry (the
-- production funding and send paths post none: the balance shown is Moov's, which already
-- reflects a return), no new money movement, no payment method change, no row of another
-- leg_role. Browsers cannot set request.provider_webhook_apply and checksops alone may call
-- the function.
--
-- Refuses to run (55000 sql109_prerequisite_missing) without SQL 91's
-- aws_moov_webhook_apply_active(), the two tables and the columns it uses, and (55000
-- sql109_definer_cannot_write) unless the applying login owns public.payment_transfers and
-- public.payment_event_log without FORCE ROW LEVEL SECURITY (or is a superuser or BYPASSRLS).
--
-- Transactions: no BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql109_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.aws_moov_webhook_apply_active() (SQL 91)', to_regprocedure('public.aws_moov_webhook_apply_active()')::oid),
      ('public.payment_transfers', to_regclass('public.payment_transfers')::oid),
      ('public.payment_event_log', to_regclass('public.payment_event_log')::oid),
      ('role checksops', (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (
      VALUES
        ('payment_transfers', 'id'), ('payment_transfers', 'tenant_id'),
        ('payment_transfers', 'provider'), ('payment_transfers', 'environment'),
        ('payment_transfers', 'provider_transfer_id'), ('payment_transfers', 'provider_status'),
        ('payment_transfers', 'status'), ('payment_transfers', 'leg_role'),
        ('payment_transfers', 'failure_reason'), ('payment_transfers', 'provider_metadata'),
        ('payment_transfers', 'completed_at'), ('payment_transfers', 'updated_at'),
        ('payment_event_log', 'provider'), ('payment_event_log', 'environment'),
        ('payment_event_log', 'tenant_id'), ('payment_event_log', 'transfer_id'),
        ('payment_event_log', 'provider_transfer_id'), ('payment_event_log', 'event_type'),
        ('payment_event_log', 'previous_status'), ('payment_event_log', 'new_status'),
        ('payment_event_log', 'provider_metadata')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql109_prerequisite_missing: SQL 109 needs SQL 91 and the payment tables applied first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid IN ('public.payment_transfers'::regclass, 'public.payment_event_log'::regclass)
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql109_definer_cannot_write: the applying login must own public.payment_transfers and public.payment_event_log (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;
END
$sql109_prereq$;

CREATE OR REPLACE FUNCTION public.aws_moov_webhook_apply_transfer_status(
  _environment text,
  _provider_transfer_id text,
  _status text,
  _provider_status text,
  _event_id text,
  _event_type text,
  _return_code text,
  _return_reason text,
  _correction_code text,
  _correction_reason text,
  _completed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.payment_transfers%ROWTYPE;
  v_old text;
  v_new text;
  v_old_rank integer;
  v_new_rank integer;
  v_outcome text;
  v_notify boolean := false;
  v_return_code text;
  v_return_reason text;
  v_correction_code text;
  v_correction_reason text;
  v_event_id text := left(btrim(COALESCE(_event_id, '')), 200);
  v_event_type text := left(COALESCE(NULLIF(btrim(COALESCE(_event_type, '')), ''), 'transfer.updated'), 120);
  v_provider_status text := NULLIF(left(btrim(COALESCE(_provider_status, '')), 40), '');
  v_follow_up text;
  v_failure text;
  v_meta jsonb := '{}'::jsonb;
BEGIN
  IF NOT COALESCE(public.aws_moov_webhook_apply_active(), false) THEN
    RAISE EXCEPTION 'moov_webhook_apply_required: Moov transfer status is written by the webhook route only'
      USING ERRCODE = '42501';
  END IF;
  IF _environment IS NULL OR _environment NOT IN ('production', 'sandbox') THEN
    RAISE EXCEPTION 'moov_webhook_environment_invalid' USING ERRCODE = '22023';
  END IF;
  IF btrim(COALESCE(_provider_transfer_id, '')) = '' OR v_event_id = '' THEN
    RAISE EXCEPTION 'moov_webhook_ids_required' USING ERRCODE = '22023';
  END IF;
  IF _status IS NOT NULL
     AND _status NOT IN ('submitted', 'pending', 'processing', 'completed', 'failed', 'canceled', 'returned') THEN
    RAISE EXCEPTION 'moov_webhook_status_invalid' USING ERRCODE = '22023';
  END IF;

  IF upper(btrim(COALESCE(_return_code, ''))) ~ '^R[0-9]{2}$' THEN
    v_return_code := upper(btrim(_return_code));
    v_return_reason := NULLIF(left(btrim(COALESCE(_return_reason, '')), 200), '');
  END IF;
  IF upper(btrim(COALESCE(_correction_code, ''))) ~ '^C[0-9]{2}$' THEN
    v_correction_code := upper(btrim(_correction_code));
    v_correction_reason := NULLIF(left(btrim(COALESCE(_correction_reason, '')), 200), '');
  END IF;

  SELECT t.* INTO v_row
    FROM public.payment_transfers t
   WHERE t.provider = 'moov'
     AND t.environment = _environment
     AND t.provider_transfer_id = btrim(_provider_transfer_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'unknown_transfer', 'notify', false);
  END IF;
  IF v_row.leg_role IS NULL OR v_row.leg_role NOT IN ('wallet_funding', 'send_wallet', 'send_bank') THEN
    RETURN jsonb_build_object('transfer_id', v_row.id, 'tenant_id', v_row.tenant_id, 'leg_role', v_row.leg_role,
      'previous_status', v_row.status, 'new_status', v_row.status, 'outcome', 'not_owned', 'notify', false);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payment_event_log e
     WHERE e.transfer_id = v_row.id
       AND e.provider_metadata->>'moov_event_id' = v_event_id
  ) THEN
    RETURN jsonb_build_object('transfer_id', v_row.id, 'tenant_id', v_row.tenant_id, 'leg_role', v_row.leg_role,
      'previous_status', v_row.status, 'new_status', v_row.status, 'outcome', 'duplicate_event', 'notify', false);
  END IF;

  v_old := v_row.status;
  v_old_rank := CASE v_old
    WHEN 'submitted' THEN 1
    WHEN 'pending' THEN 2 WHEN 'processing' THEN 2
    WHEN 'completed' THEN 3
    WHEN 'failed' THEN 4 WHEN 'canceled' THEN 4
    WHEN 'returned' THEN 5
    ELSE 0 END;
  v_new_rank := CASE _status
    WHEN 'submitted' THEN 1
    WHEN 'pending' THEN 2 WHEN 'processing' THEN 2
    WHEN 'completed' THEN 3
    WHEN 'failed' THEN 4 WHEN 'canceled' THEN 4
    WHEN 'returned' THEN 5
    ELSE -1 END;

  IF _status IS NOT NULL AND v_new_rank > v_old_rank THEN
    v_new := _status;
    v_outcome := 'applied';
  ELSIF v_correction_code IS NOT NULL THEN
    v_new := v_old;
    v_outcome := 'correction';
  ELSIF _status IS NOT NULL AND _status = v_old THEN
    v_new := v_old;
    v_outcome := 'unchanged';
  ELSE
    v_new := v_old;
    v_outcome := 'stale';
  END IF;

  IF v_outcome = 'applied' AND v_new IN ('failed', 'returned', 'canceled') AND v_old_rank >= 1 THEN
    v_follow_up := CASE v_new
      WHEN 'returned' THEN 'Moov reported this transfer returned' || COALESCE(' (' || v_return_code || ')', '') || '; check the bank details and send again if needed.'
      WHEN 'failed' THEN 'Moov reported this transfer failed' || COALESCE(' (' || v_return_code || ')', '') || '; check the bank details and send again if needed.'
      ELSE 'Moov canceled this transfer; send again if needed.' END;
  ELSIF v_correction_code IS NOT NULL THEN
    v_follow_up := 'The bank sent a notification of change (' || v_correction_code || '); update the bank details before the next payment.';
  END IF;
  IF v_outcome = 'applied' AND v_new IN ('failed', 'returned') THEN
    v_notify := true;
  END IF;

  IF v_outcome IN ('applied', 'correction') OR (v_outcome = 'unchanged' AND v_return_code IS NOT NULL
       AND COALESCE(v_row.provider_metadata->'moov_return'->>'code', '') = '') THEN
    IF v_outcome = 'applied' THEN
      v_meta := v_meta || jsonb_build_object('moov_last_webhook', jsonb_build_object(
        'event_id', v_event_id, 'event_type', v_event_type, 'provider_status', v_provider_status,
        'status', v_new, 'at', now()));
    END IF;
    IF v_return_code IS NOT NULL AND v_new IN ('failed', 'returned') THEN
      v_meta := v_meta || jsonb_build_object('moov_return', jsonb_strip_nulls(jsonb_build_object(
        'code', v_return_code, 'reason', v_return_reason, 'event_id', v_event_id, 'at', now())));
    END IF;
    IF v_correction_code IS NOT NULL THEN
      v_meta := v_meta || jsonb_build_object('moov_correction', jsonb_strip_nulls(jsonb_build_object(
        'code', v_correction_code, 'reason', v_correction_reason, 'event_id', v_event_id, 'at', now())));
    END IF;
    IF v_follow_up IS NOT NULL THEN
      v_meta := v_meta || jsonb_build_object('manual_follow_up', jsonb_build_object('reason', v_follow_up, 'at', now()));
    END IF;
    v_failure := CASE
      WHEN v_new IN ('failed', 'returned') AND v_return_code IS NOT NULL
        THEN left('ACH return ' || v_return_code || COALESCE(': ' || v_return_reason, ''), 500)
      WHEN v_outcome = 'applied' AND v_new IN ('failed', 'returned', 'canceled')
        THEN left('Moov reported ' || COALESCE(v_provider_status, v_new), 500)
      ELSE NULL END;

    UPDATE public.payment_transfers t
       SET status = v_new,
           provider_status = CASE WHEN v_outcome = 'applied' THEN COALESCE(v_provider_status, t.provider_status) ELSE t.provider_status END,
           completed_at = CASE WHEN v_outcome = 'applied' AND v_new = 'completed'
                               THEN COALESCE(t.completed_at, _completed_at, now()) ELSE t.completed_at END,
           failure_reason = CASE WHEN v_failure IS NOT NULL
                                  AND (v_return_code IS NOT NULL OR t.failure_reason IS NULL OR v_outcome = 'applied')
                                 THEN v_failure ELSE t.failure_reason END,
           provider_metadata = COALESCE(t.provider_metadata, '{}'::jsonb) || v_meta,
           updated_at = now()
     WHERE t.id = v_row.id;
  END IF;

  INSERT INTO public.payment_event_log
    (provider, environment, tenant_id, transfer_id, provider_transfer_id, event_type,
     previous_status, new_status, provider_metadata)
  VALUES (
    'moov', v_row.environment, v_row.tenant_id, v_row.id, v_row.provider_transfer_id, v_event_type,
    v_old, v_new,
    jsonb_strip_nulls(jsonb_build_object(
      'moov_event_id', v_event_id,
      'outcome', v_outcome,
      'provider_status', v_provider_status,
      'requested_status', _status,
      'return_code', v_return_code,
      'return_reason', v_return_reason,
      'correction_code', v_correction_code,
      'correction_reason', v_correction_reason,
      'manual_follow_up', v_follow_up,
      'source', 'moov_transfer_webhook')));

  RETURN jsonb_build_object('transfer_id', v_row.id, 'tenant_id', v_row.tenant_id, 'leg_role', v_row.leg_role,
      'previous_status', v_row.status, 'new_status', v_new, 'outcome', v_outcome, 'notify', v_notify);
END
$$;

REVOKE ALL ON FUNCTION public.aws_moov_webhook_apply_transfer_status(text, text, text, text, text, text, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_moov_webhook_apply_transfer_status(text, text, text, text, text, text, text, text, text, text, timestamptz) TO checksops;
COMMENT ON FUNCTION public.aws_moov_webhook_apply_transfer_status(text, text, text, text, text, text, text, text, text, text, timestamptz) IS
  'SQL 109: Moov webhook write-back of a funding or send leg''s status, ACH return code and NOC. Webhook route only (request.provider_webhook_apply = 1); never moves money.';
