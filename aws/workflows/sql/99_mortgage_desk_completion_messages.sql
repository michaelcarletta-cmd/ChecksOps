-- AWS: Mortgage Desk completion messages are posted by the database (SQL 99).
-- Forward migration on top of SQL 90 (users only, no tenant role tiers).
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: under SQL 90 check_messages writes go only through
-- aws_write_check_messages (aws_can_write_check: members of the check's own
-- tenant). A Mortgage Agent is not a member of the requesting tenant, so the
-- Desk's client-side "completed work" note and its MORTGAGE_DESK_RETURN marker
-- (src/lib/mortgageDeskReturn.ts) were refused on another tenant's check.
-- Owner decision: no agent RLS policy on check_messages or check_intake_items;
-- the database posts both messages when the assigned agent completes the
-- request.
--
-- 1) public.aws_mortgage_desk_appended_note(old_notes, new_notes) (new,
--    IMMUTABLE, SECURITY INVOKER): the note this update appended to
--    mortgage_handling_requests.work_notes. The API
--    (workflow-rpc.mjs executeUpdateMortgageStatus) appends
--      COALESCE(work_notes || E'\n\n', '') || 'YYYY-MM-DD HH24:MI' || ' — ' || trim(note)
--    in the same UPDATE that sets status. The new segment is NEW minus the
--    OLD || E'\n\n' prefix (all of NEW when OLD is NULL); its timestamp prefix
--    is removed. NULL when nothing was appended, when NEW does not extend OLD
--    that way, or when the segment does not start with that timestamp, so a
--    rewritten work_notes never leaks earlier notes into the message.
-- 2) public.aws_mortgage_desk_completion_messages() (new trigger function,
--    SECURITY DEFINER, search_path = public, owned by the applying login like
--    the other aws/workflows/sql DEFINER functions). It does not set
--    row_security: as the owner of check_messages it is not subject to that
--    table's RLS anyway, and row_security = off would carry into the triggers
--    its inserts fire (trg_mirror_check_message_to_homeowner_ledger, then
--    assign_case_on_ledger_events), making their reads of tables their own
--    owners do not own fail with 42501 instead of running under RLS. On a
--    change of status to 'completed' (OLD.status IS DISTINCT FROM 'completed'),
--    with check_intake_item_id and assigned_employee_id set and the updating
--    user (auth.uid()) being the assigned agent, it inserts into
--    public.check_messages, sender_id = NEW.assigned_employee_id,
--    is_deleted = false:
--      a. the completed-work note, byte for byte
--         buildMortgageDeskCompletedMessage(mortgage_company || mortgage_servicer, note):
--         '✅ ChecksOps Mortgage Desk completed work with <company>.' and
--         ' Notes: <note>' only when a note was appended. <company> is the
--         first non-empty of mortgage_company, mortgage_servicer, else
--         'the mortgage company' (MortgageOpsQueue handleStatus). Cut to the
--         table's 5000-character body limit so a long note never fails the
--         completion.
--      b. the return marker, exactly buildReturnMessage(request id):
--         'MORTGAGE_DESK_RETURN:<id> Mortgage Desk completed work on this
--         check. Review the returned documents and continue processing.'
--         Only when the check has no non-deleted message starting with
--         'MORTGAGE_DESK_RETURN:<id>' (the SPA's ensureMortgageDeskReturnMessage
--         rule), so a re-completion or replay never duplicates it.
-- 3) Trigger tr_mortgage_desk_completion_messages, AFTER UPDATE FOR EACH ROW
--    on public.mortgage_handling_requests, WHEN OLD.status IS DISTINCT FROM
--    'completed' AND NEW.status = 'completed' AND check_intake_item_id and
--    assigned_employee_id are not null. The function also requires
--    auth.uid() = assigned_employee_id (the API's update_mortgage_handling_
--    request_status runs as the assigned agent), so another writer setting
--    status (a tenant member's generic request update) never posts as the
--    agent.
--
-- Not changed: no policy, no grant (nothing new for checksops or
-- authenticated; EXECUTE on both functions is revoked from PUBLIC), no
-- table, column or row. Agents still cannot insert into check_messages
-- directly. The tenant's MORTGAGE_DESK_RETURN_ACK message keeps going through
-- aws_write_check_messages (members). trg_mirror_check_message_to_homeowner_ledger
-- (AFTER INSERT, SECURITY DEFINER) mirrors these rows like any other message.
--
-- Refuses to run (55000 sql99_prerequisite_missing) without SQL 90
-- (aws_is_tenant_member) and the tables and columns it uses, and (55000
-- sql99_definer_cannot_write_check_messages) unless the applying login owns
-- public.check_messages without FORCE ROW LEVEL SECURITY (or is a superuser or
-- BYPASSRLS): otherwise aws_write_check_messages would refuse the inserts and
-- every completion would fail.
--
-- Transactions: like main's other aws/workflows/sql files this has no
-- BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql99_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.aws_is_tenant_member(uuid) (SQL 90)', to_regprocedure('public.aws_is_tenant_member(uuid)')::oid),
      ('auth.uid()', to_regprocedure('auth.uid()')::oid),
      ('public.check_messages', to_regclass('public.check_messages')::oid),
      ('public.mortgage_handling_requests', to_regclass('public.mortgage_handling_requests')::oid)
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (
      VALUES
        ('check_messages', 'check_id'), ('check_messages', 'sender_id'),
        ('check_messages', 'body'), ('check_messages', 'is_deleted'),
        ('check_messages', 'created_at'),
        ('mortgage_handling_requests', 'id'), ('mortgage_handling_requests', 'status'),
        ('mortgage_handling_requests', 'check_intake_item_id'),
        ('mortgage_handling_requests', 'assigned_employee_id'),
        ('mortgage_handling_requests', 'mortgage_company'),
        ('mortgage_handling_requests', 'mortgage_servicer'),
        ('mortgage_handling_requests', 'work_notes')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql99_prerequisite_missing: SQL 99 needs SQL 90 and the Mortgage Desk tables applied first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid = 'public.check_messages'::regclass
      AND (me.rolsuper OR me.rolbypassrls
           OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql99_definer_cannot_write_check_messages: the applying login must own public.check_messages (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;
END
$sql99_prereq$;

CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_appended_note(_old_notes text, _new_notes text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_segment text;
BEGIN
  IF _new_notes IS NULL OR _new_notes IS NOT DISTINCT FROM _old_notes THEN
    RETURN NULL;
  END IF;
  IF _old_notes IS NULL THEN
    v_segment := _new_notes;
  ELSIF left(_new_notes, length(_old_notes) + 2) = _old_notes || E'\n\n' THEN
    v_segment := substr(_new_notes, length(_old_notes) + 3);
  ELSE
    RETURN NULL;
  END IF;
  IF v_segment !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} — ' THEN
    RETURN NULL;
  END IF;
  RETURN NULLIF(btrim(regexp_replace(v_segment, '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} — ', '')), '');
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_appended_note(text, text) FROM PUBLIC;
COMMENT ON FUNCTION public.aws_mortgage_desk_appended_note(text, text) IS
  'SQL 99: the note one update appended to mortgage_handling_requests.work_notes (workflow-rpc executeUpdateMortgageStatus format), without its timestamp prefix; NULL when none.';

CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_completion_messages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company text;
  v_note text;
  v_marker_prefix text;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed'
     OR OLD.status IS NOT DISTINCT FROM 'completed'
     OR NEW.check_intake_item_id IS NULL
     OR NEW.assigned_employee_id IS NULL
     OR auth.uid() IS DISTINCT FROM NEW.assigned_employee_id
  THEN
    RETURN NULL;
  END IF;

  v_company := COALESCE(NULLIF(NEW.mortgage_company, ''), NULLIF(NEW.mortgage_servicer, ''), 'the mortgage company');
  v_note := public.aws_mortgage_desk_appended_note(OLD.work_notes, NEW.work_notes);

  INSERT INTO public.check_messages (check_id, sender_id, body, is_deleted, created_at)
  VALUES (
    NEW.check_intake_item_id,
    NEW.assigned_employee_id,
    left('✅ ChecksOps Mortgage Desk completed work with ' || v_company || '.'
         || CASE WHEN v_note IS NULL THEN '' ELSE ' Notes: ' || v_note END, 5000),
    false,
    clock_timestamp()
  );

  v_marker_prefix := 'MORTGAGE_DESK_RETURN:' || NEW.id::text;
  INSERT INTO public.check_messages (check_id, sender_id, body, is_deleted, created_at)
  SELECT
    NEW.check_intake_item_id,
    NEW.assigned_employee_id,
    v_marker_prefix || ' Mortgage Desk completed work on this check. Review the returned documents and continue processing.',
    false,
    clock_timestamp()
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.check_messages m
    WHERE m.check_id = NEW.check_intake_item_id
      AND m.is_deleted IS NOT TRUE
      AND left(m.body, length(v_marker_prefix)) = v_marker_prefix
  );

  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_completion_messages() FROM PUBLIC;
COMMENT ON FUNCTION public.aws_mortgage_desk_completion_messages() IS
  'SQL 99: when the assigned agent completes a Mortgage Desk request, posts the completed-work note and (once per request) the MORTGAGE_DESK_RETURN marker on the check thread as that agent. No agent check_messages policy exists.';

DROP TRIGGER IF EXISTS tr_mortgage_desk_completion_messages ON public.mortgage_handling_requests;
CREATE TRIGGER tr_mortgage_desk_completion_messages
  AFTER UPDATE ON public.mortgage_handling_requests
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM 'completed'
        AND NEW.status = 'completed'
        AND NEW.check_intake_item_id IS NOT NULL
        AND NEW.assigned_employee_id IS NOT NULL)
  EXECUTE FUNCTION public.aws_mortgage_desk_completion_messages();
