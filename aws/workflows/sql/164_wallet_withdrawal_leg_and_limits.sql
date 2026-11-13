-- SQL 164: transfer to bank (wallet -> the tenant's own settlement bank): the webhook writer owns the new
-- wallet_withdrawal leg, and the tenant's own withdrawal limits.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: owner 2026-11-13, "Build the transfer to bank" (design docs/WALLET_TO_BANK_TRANSFER_DESIGN.md, PR #1849, with
-- the owner's decisions of 2026-11-13: no fee; limits up to the tenant; any member; same-day ACH; any amount up to the
-- balance; no admin approval; the wallet.fund two-factor; no email; operating wallet only). The new API handler
-- moov-wallet-withdraw records each transfer as a public.payment_transfers row with leg_role 'wallet_withdrawal'.
-- SQL 109's webhook writer answers not_owned for every leg_role other than wallet_funding, send_wallet and send_bank,
-- so a withdrawal's Moov status (completed, failed, returned, NOC) would never reach ChecksOps. The status catch-up job
-- (moov-status-catch-up.mjs) routes the legs SQL 109 owns to the same writer, so this one change covers both.
-- SQL 146's collection writer needs no change: it already answers not_owned for every leg that is not a
-- tenant-collection-v2 or monthly-subscription leg, a withdrawal included.
--
-- What this file does:
-- 1) CREATE OR REPLACE public.aws_moov_webhook_apply_transfer_status(text, text, text, text, text, text, text, text,
--    text, text, timestamptz), the function SQL 109 created, with one change: the owned legs are wallet_funding,
--    send_wallet, send_bank and wallet_withdrawal. Everything else is SQL 109's, unchanged: the webhook-apply gate
--    (42501 moov_webhook_apply_required), the input checks (22023), the one row locked FOR UPDATE by provider,
--    environment and provider_transfer_id, idempotency per Moov event, never moving backwards, the return / NOC
--    handling, the payment_event_log row, the result object, SECURITY DEFINER, search_path public, RETURNS jsonb,
--    owned by the applying login. EXECUTE: REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO checksops, as in SQL 109. The
--    function's comment names SQL 164.
-- 2) Two nullable columns on public.tenant_wallet_funding_settings, the tenant's own transfer-to-bank limits (no
--    platform cap; NULL = no limit): wallet_withdraw_max_per_transfer_cents bigint and
--    wallet_withdraw_max_per_day_cents bigint, each with a CHECK that it is NULL or positive. Column INSERT and
--    UPDATE on exactly these two columns to checksops (the API login), as SQL 140 granted the other settings
--    columns; nothing to authenticated, PUBLIC, anon or service_role. The table's RLS policies
--    (aws_write_tenant_wallet_funding_settings, SQL 136's money-write gates) keep each tenant to its own row.
--
-- Not changed: no other function, no policy, RLS setting, table grant, index, trigger or existing row; no money moves.
--
-- Refuses to run (55000 sql164_prerequisite_missing) without SQL 91's aws_moov_webhook_apply_active(), the three
-- tables and the columns it uses and the role checksops, and (55000 sql164_definer_cannot_write) unless the applying
-- login owns public.payment_transfers and public.payment_event_log without FORCE ROW LEVEL SECURITY (or is a superuser
-- or BYPASSRLS), and owns public.tenant_wallet_funding_settings (ALTER TABLE).
--
-- Transactions: no BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once (ADD COLUMN IF NOT EXISTS; each CHECK added only when absent). Not applied
-- by this change: staging first, then production, through the guarded SQL path (AGENTS.md).

DO $sql164_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.aws_moov_webhook_apply_active() (SQL 91)', to_regprocedure('public.aws_moov_webhook_apply_active()')::oid),
      ('public.payment_transfers', to_regclass('public.payment_transfers')::oid),
      ('public.payment_event_log', to_regclass('public.payment_event_log')::oid),
      ('public.tenant_wallet_funding_settings', to_regclass('public.tenant_wallet_funding_settings')::oid),
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
        ('payment_event_log', 'provider_metadata'),
        ('tenant_wallet_funding_settings', 'tenant_id')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql164_prerequisite_missing: SQL 164 needs SQL 91, SQL 109 and the payment tables applied first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid IN ('public.payment_transfers'::regclass, 'public.payment_event_log'::regclass,
                    'public.tenant_wallet_funding_settings'::regclass)
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql164_definer_cannot_write: the applying login must own public.payment_transfers, public.payment_event_log and public.tenant_wallet_funding_settings (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;
END
$sql164_prereq$;

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
  IF v_row.leg_role IS NULL OR v_row.leg_role NOT IN ('wallet_funding', 'send_wallet', 'send_bank', 'wallet_withdrawal') THEN
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
  'SQL 164 (replaces SQL 109): Moov webhook write-back of a funding, send or wallet-withdrawal leg''s status, ACH return code and NOC. Webhook route only (request.provider_webhook_apply = 1); never moves money.';

ALTER TABLE public.tenant_wallet_funding_settings
  ADD COLUMN IF NOT EXISTS wallet_withdraw_max_per_transfer_cents bigint,
  ADD COLUMN IF NOT EXISTS wallet_withdraw_max_per_day_cents bigint;

DO $sql164_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.tenant_wallet_funding_settings'::regclass
       AND conname = 'tenant_wallet_funding_settings_withdraw_per_transfer_check'
  ) THEN
    ALTER TABLE public.tenant_wallet_funding_settings
      ADD CONSTRAINT tenant_wallet_funding_settings_withdraw_per_transfer_check
      CHECK (wallet_withdraw_max_per_transfer_cents IS NULL OR wallet_withdraw_max_per_transfer_cents > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.tenant_wallet_funding_settings'::regclass
       AND conname = 'tenant_wallet_funding_settings_withdraw_per_day_check'
  ) THEN
    ALTER TABLE public.tenant_wallet_funding_settings
      ADD CONSTRAINT tenant_wallet_funding_settings_withdraw_per_day_check
      CHECK (wallet_withdraw_max_per_day_cents IS NULL OR wallet_withdraw_max_per_day_cents > 0);
  END IF;
END
$sql164_checks$;

GRANT INSERT (wallet_withdraw_max_per_transfer_cents, wallet_withdraw_max_per_day_cents)
  ON TABLE public.tenant_wallet_funding_settings TO checksops;
GRANT UPDATE (wallet_withdraw_max_per_transfer_cents, wallet_withdraw_max_per_day_cents)
  ON TABLE public.tenant_wallet_funding_settings TO checksops;
