-- SQL 123: a check deposited through Check Alt moves to Deposited; a deposit that is later
-- rejected or returned moves the check to Returned.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why (owner, 2026-10-28): "When a check is deposited through Checcalt, it should
-- automatically move to deposited and not stay in ready for deposit", and "proceed with
-- database trigger that marks it deposited when check alt submits. If it is later rejected
-- it shows up in returned and not in deposited."
--
--   - Check Alt never moves the check itself. The submit, auto-approve and poll paths
--     (checkalt-idempotency.mjs persistProviderOutcome, persistAutoApproveOutcome,
--     persistPollOutcome) write public.checkalt_deposits only; no code sets
--     check_intake_items.status / check_stage 'deposited' for a Check Alt deposit (SQL 120's
--     and SQL 121's headers say the same). The SPA shows the check under Deposited only
--     while its deposit is pending_approval; once the deposit is submitted or cleared it
--     falls back into Ready for deposit.
--
-- 1) public.aws_checkalt_mark_check_deposited(check uuid, deposited_at timestamptz) (new,
--    SECURITY DEFINER, search_path public, pg_temp, row_security off; EXECUTE for the
--    owner only): moves one check to Deposited the way the manual deposit path does
--    (workflow-rpc.mjs mark_manual_deposit): status 'deposited', check_stage 'deposited',
--    deposited_at = COALESCE(deposited_at, the deposit time), updated_at now(). Only
--    forward: a check whose check_stage is NULL, review, loss_draft, endorsing or
--    ready_for_deposit, or that is 'returned' with an open return recorded by Check Alt
--    (return_source 'checkalt', return_resolved_at NULL: a resubmitted deposit), whose
--    return is then resolved (return_resolved_at now(), return_resolution
--    'checkalt_redeposited'). A check already deposited, funds_released,
--    disbursed_externally or returned by a bank or by hand is left as it is. Returns
--    whether it moved the check.
-- 2) public.aws_apply_checkalt_check_status() (new trigger function, SECURITY DEFINER,
--    search_path public, pg_temp, row_security off; EXECUTE for the owner only) and trigger
--    aws_checkalt_deposit_apply_check_status, AFTER INSERT OR UPDATE OF status ON
--    public.checkalt_deposits:
--      a. When a deposit becomes submitted or cleared (approved or accepted) from any
--         other status and names its check: 1) with the deposit's submitted_at (else now()).
--      b. When a deposit becomes rejected, error, duplicate or returned after it was
--         submitted or cleared, and no other deposit of the check is submitted or cleared:
--         the check moves to Returned exactly as the AWS record_check_return RPC
--         (workflow-rpc.mjs executeRecordCheckReturn) records a return: check_stage and
--         status 'returned', pre_return_stage = its stage before, returned_at = the
--         deposit's returned_at (else now()), return_code 'checkalt_<status>',
--         return_reason = the deposit's return_reason (else 'Check Alt deposit <status>'),
--         return_source 'checkalt', return_notes / return_recorded_by / return_resolved_at /
--         return_resolution NULL, and one check_audit_log row 'check_returned'. The SPA's
--         Returned tab lists checks with returned_at set and return_resolved_at NULL
--         (CheckCommandCenter.tsx returned count; ReturnedChecksPanel.tsx). error and
--         duplicate are the statuses SQL 120 and SQL 121 treat as "did not go through"
--         alongside rejected; returned is a bank return after the deposit cleared. A check
--         already 'returned' is not returned again.
--    The trigger's name sorts before aws_checkalt_deposit_billing_event (SQL 120) and
--    aws_checkalt_deposit_cash_job_payment (SQL 121), so PostgreSQL fires it first
--    (AFTER triggers of one event fire in name order). On approval the check is then
--    already 'deposited': SQL 98's record_check_billing_event and
--    sync_cash_job_check_payment record the check's one usage event and its one cash-job
--    payment, and SQL 120 and SQL 121 find them and add nothing. On a rejection the check
--    is already 'returned' (no longer 'deposited'), so SQL 120 still voids the uninvoiced
--    usage event and SQL 121 still removes the automatic cash-job payment.
--    Every trigger on check_intake_items that these updates fire was read for a refusal:
--    none raises for these columns (trg_guard_check_claim_link returns early when claim_id
--    is unchanged; the legacy status transition guard was dropped on 2026-05-05 and its
--    function only audits; the partner status and notification triggers only warn).
-- 3) Once, for checks already stuck: every check with a submitted or cleared Check Alt
--    deposit that 1) would move and that already carries a check_processing usage event
--    (SQL 120 recorded it at approval) is moved to Deposited with its deposit's
--    submitted_at. A check without that event is left alone, so this file never creates
--    a new charge (SQL 98's trigger finds the existing event). The read-only inspect counts
--    both groups (counts).
--
-- Not changed: SQL 98's, SQL 120's and SQL 121's functions and triggers; no column,
-- policy, grant, RLS setting or other table; checkalt_deposits rows are only read.
--
-- The file refuses (42704 sql123_check_stage_label_missing) unless public.check_stage has the
-- labels 'deposited' and 'returned'.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: CREATE OR REPLACE, DROP TRIGGER IF EXISTS / CREATE TRIGGER and REVOKE leave
-- the same state on every run; the backfill moves nothing a second time.
--
-- NOT APPLIED. Staging and production through the guarded SQL path (AGENTS.md). Adds one
-- public trigger: the DB validator's justified set and expected count follow once this
-- file is applied, not before.

-- 0) The stage labels this file writes must exist (a missing one would make a later deposit
-- update fail inside the trigger): 42704 sql123_check_stage_label_missing otherwise.
DO $sql123_labels$
DECLARE
  v_label text;
BEGIN
  FOREACH v_label IN ARRAY ARRAY['deposited', 'returned'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_enum e
       WHERE e.enumtypid = 'public.check_stage'::regtype AND e.enumlabel = v_label) THEN
      RAISE EXCEPTION 'sql123_check_stage_label_missing: public.check_stage has no label %', v_label
        USING ERRCODE = '42704';
    END IF;
  END LOOP;
END
$sql123_labels$;

-- 1) Move one check to Deposited ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_checkalt_mark_check_deposited(p_check_id uuid, p_deposited_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  v_moved uuid;
BEGIN
  UPDATE public.check_intake_items c
     SET status = 'deposited',
         check_stage = 'deposited'::public.check_stage,
         deposited_at = COALESCE(c.deposited_at, p_deposited_at, now()),
         return_resolved_at = CASE WHEN c.check_stage = 'returned'::public.check_stage THEN now() ELSE c.return_resolved_at END,
         return_resolution = CASE WHEN c.check_stage = 'returned'::public.check_stage THEN 'checkalt_redeposited' ELSE c.return_resolution END,
         updated_at = now()
   WHERE c.id = p_check_id
     AND (c.check_stage IS NULL
          OR c.check_stage::text IN ('review', 'loss_draft', 'endorsing', 'ready_for_deposit')
          OR (c.check_stage = 'returned'::public.check_stage
              AND c.return_source = 'checkalt'
              AND c.return_resolved_at IS NULL))
  RETURNING c.id INTO v_moved;
  RETURN v_moved IS NOT NULL;
END
$$;
REVOKE ALL ON FUNCTION public.aws_checkalt_mark_check_deposited(uuid, timestamptz) FROM PUBLIC;
COMMENT ON FUNCTION public.aws_checkalt_mark_check_deposited(uuid, timestamptz) IS
  'SQL 123: moves a check forward to Deposited when its Check Alt deposit is approved or accepted (only from review, loss draft, endorsing, ready for deposit, or an open Check Alt return).';

-- 2) The trigger on checkalt_deposits ----------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_apply_checkalt_check_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  v_new text := lower(COALESCE(NEW.status, ''));
  v_old text := CASE WHEN TG_OP = 'UPDATE' THEN lower(COALESCE(OLD.status, '')) ELSE '' END;
  v_check record;
  v_reason text;
BEGIN
  IF NEW.check_intake_item_id IS NULL OR v_new = v_old THEN
    RETURN NULL;
  END IF;

  IF v_new IN ('submitted', 'cleared') AND v_old NOT IN ('submitted', 'cleared') THEN
    PERFORM public.aws_checkalt_mark_check_deposited(NEW.check_intake_item_id, COALESCE(NEW.submitted_at, now()));
    RETURN NULL;
  END IF;

  IF v_new IN ('rejected', 'error', 'duplicate', 'returned') AND v_old IN ('submitted', 'cleared')
     AND NOT EXISTS (
       SELECT 1 FROM public.checkalt_deposits d
        WHERE d.check_intake_item_id = NEW.check_intake_item_id
          AND d.id <> NEW.id
          AND lower(COALESCE(d.status, '')) IN ('submitted', 'cleared')) THEN
    SELECT c.id, c.tenant_id, c.check_stage
      INTO v_check
      FROM public.check_intake_items c
     WHERE c.id = NEW.check_intake_item_id
     FOR UPDATE;
    IF v_check.id IS NULL OR v_check.check_stage = 'returned'::public.check_stage THEN
      RETURN NULL;
    END IF;
    v_reason := COALESCE(NULLIF(btrim(NEW.return_reason), ''), 'Check Alt deposit ' || v_new);
    UPDATE public.check_intake_items c
       SET check_stage = 'returned'::public.check_stage,
           status = 'returned',
           pre_return_stage = v_check.check_stage,
           returned_at = COALESCE(NEW.returned_at, now()),
           return_code = 'checkalt_' || v_new,
           return_reason = v_reason,
           return_notes = NULL,
           return_recorded_by = NULL,
           return_source = 'checkalt',
           return_resolved_at = NULL,
           return_resolution = NULL,
           updated_at = now()
     WHERE c.id = v_check.id;
    INSERT INTO public.check_audit_log (check_id, tenant_id, actor_id, event_type, event_description, event_data)
    VALUES (
      v_check.id, v_check.tenant_id, NULL, 'check_returned',
      'Check returned: ' || v_reason,
      jsonb_build_object(
        'return_code', 'checkalt_' || v_new,
        'return_reason', v_reason,
        'previous_stage', v_check.check_stage,
        'source', 'checkalt',
        'checkalt_deposit_id', NEW.id,
        'provider_execution', false));
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.aws_apply_checkalt_check_status() FROM PUBLIC;
DO $sql123_revoke$
DECLARE
  v_grantee text;
BEGIN
  FOREACH v_grantee IN ARRAY ARRAY['checksops', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_grantee) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.aws_checkalt_mark_check_deposited(uuid, timestamptz) FROM %I', v_grantee);
      EXECUTE format('REVOKE ALL ON FUNCTION public.aws_apply_checkalt_check_status() FROM %I', v_grantee);
    END IF;
  END LOOP;
END
$sql123_revoke$;
COMMENT ON FUNCTION public.aws_apply_checkalt_check_status() IS
  'SQL 123: a Check Alt deposit approved or accepted moves its check to Deposited; rejected, error, duplicate or returned after approval (and no other approved deposit) moves it to Returned. Fires before SQL 120''s and SQL 121''s triggers.';

DROP TRIGGER IF EXISTS aws_checkalt_deposit_apply_check_status ON public.checkalt_deposits;
CREATE TRIGGER aws_checkalt_deposit_apply_check_status
  AFTER INSERT OR UPDATE OF status ON public.checkalt_deposits
  FOR EACH ROW EXECUTE FUNCTION public.aws_apply_checkalt_check_status();

-- 3) Checks already stuck in Ready for deposit -------------------------------------
DO $sql123_backfill$
DECLARE
  r record;
  v_moved integer := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (d.check_intake_item_id) d.check_intake_item_id AS check_id, d.submitted_at
      FROM public.checkalt_deposits d
      JOIN public.check_intake_items c ON c.id = d.check_intake_item_id
     WHERE lower(COALESCE(d.status, '')) IN ('submitted', 'cleared')
       AND (c.check_stage IS NULL OR c.check_stage::text IN ('review', 'loss_draft', 'endorsing', 'ready_for_deposit'))
       AND EXISTS (
         SELECT 1 FROM public.check_billing_events e
          WHERE e.check_intake_item_id = d.check_intake_item_id
            AND e.event_type = 'check_processing'
            AND e.status <> 'voided')
     ORDER BY d.check_intake_item_id, d.submitted_at NULLS LAST
  LOOP
    IF public.aws_checkalt_mark_check_deposited(r.check_id, COALESCE(r.submitted_at, now())) THEN
      v_moved := v_moved + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'SQL 123: % check(s) with an approved Check Alt deposit moved to Deposited', v_moved;
END
$sql123_backfill$;
