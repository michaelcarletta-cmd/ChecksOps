-- SQL 166: the Mortgage Desk agent switches the request's loss draft between Monitored and Not Monitored, and the
-- tenant sees it on the check. AWS only: nothing under supabase/migrations changes.
--
-- Why (owner 2026-11-14): "Mortgage agent needs to be able to change the claim from monitor to not monitored, so the
-- tenants see that type of update." Owner answers the same day: only while the request is in progress; switching to
-- Not Monitored when escrow or draws are already recorded is allowed with a warning (the function never refuses it,
-- it returns a flag the Desk page warns with); the tenant sees a message on the check thread; a check with no loss
-- draft file is refused.
--   - public.loss_draft_tracking.monitoring_type ('monitored' | 'not_monitored', default 'monitored'; one row per
--     check through the unique idx_loss_draft_check_id) is the field. Tenants set it with loss_draft_action
--     set_monitoring_type (aws/functions/api/workflow-rpc.mjs), which also writes a loss_draft_audit_log row.
--   - A mortgage agent cannot: the write policy aws_write_loss_draft_tracking is aws_can_write_check (tenant members
--     only; aws/rls/sql/24_complete_write_policies.sql), and check_messages and loss_draft_audit_log are member-scoped
--     too. Same approach as SQL 122: no policy, no table grant; a SECURITY DEFINER function that checks the caller.
--
-- What this file does (plpgsql, VOLATILE, SECURITY DEFINER, search_path = public, pg_temp, owned by the applying login;
-- like SQL 122 it does not set row_security):
-- 1) public.aws_mortgage_desk_set_monitoring(_request_id uuid, _monitoring_type text) RETURNS jsonb:
--      a. the gate is SQL 122's public.aws_mortgage_desk_working_request(_request_id, ARRAY['in_progress']): the caller
--         (auth.uid()) is the request's assigned agent holding mortgage_agent, or the platform owner; the request is
--         in_progress and has a check; it is locked FOR UPDATE. Otherwise 42501 not_authorized / not_assigned_to_you /
--         request_not_in_status or 22023 request_has_no_check;
--      b. _monitoring_type is 'monitored' or 'not_monitored' (trimmed, lower-cased), else 22023 invalid_monitoring_type;
--      c. the check is the request's check_intake_item_id, never a caller-chosen one; its loss_draft_tracking row is
--         locked FOR UPDATE; none: 22023 request_has_no_loss_draft; escrow_status 'endorsing' or
--         'final_release_complete' (the closed statuses, CLOSED_LOSS_DRAFT_STATUSES in workflow-rpc.mjs): 42501
--         loss_draft_closed;
--      d. escrow_or_draws_recorded is true when the file already records escrow or draws: total_escrowed,
--         draw_amount_requested, draw_amount_released or holdback_amount above 0, draw_stage above 0, or escrow_status
--         escrowed, first_draw_requested or partial_release (what mark_escrowed, request_draw, record_release and
--         record_holdback write). It never refuses the switch; the Desk page warns with it;
--      e. the same type: nothing is written; returns {ok: true, changed: false, monitoring_type, request_id,
--         loss_draft_id, escrow_or_draws_recorded};
--      f. otherwise sets monitoring_type and updated_at = now(); inserts one loss_draft_audit_log row (action
--         'set_monitoring_type', actor_id the caller, amount null, notes the message below, old_values and new_values
--         {escrow_status, monitoring_type, total_escrowed, draw_amount_released, holdback_amount} with the amounts as
--         text, the shape loss_draft_action writes); inserts one check_messages row on the check from the caller (the
--         columns SQL 122's aws_mortgage_desk_post_message writes): "ChecksOps Mortgage Desk changed this loss draft
--         to Not Monitored." or "... to Monitored."; returns {ok: true, changed: true, monitoring_type,
--         previous_monitoring_type, request_id, loss_draft_id, message_id, escrow_or_draws_recorded}.
-- 2) EXECUTE: REVOKE ALL FROM PUBLIC, and from anon, authenticated and service_role where those roles exist; GRANT
--    EXECUTE TO checksops (the API login). The owner keeps its own.
--
-- Not changed: no table, column, policy, RLS setting, table grant, trigger or row; no other function (SQL 122's gate
-- keeps its body and ACL). The tenant's own set_monitoring_type and every escrow and draw action are unchanged.
--
-- Refuses to run (55000 sql166_prerequisite_missing) without the relations, columns, SQL 122's gate, auth.uid() and
-- role checksops, and (55000 sql166_definer_cannot_reach) unless the applying login owns the relations it reads or
-- writes without FORCE ROW LEVEL SECURITY, or is a superuser or BYPASSRLS: a DEFINER filtered by RLS would find no
-- loss draft and write nothing.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql166_prereq$
DECLARE
  v_missing text[];
  v_unreachable text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.mortgage_handling_requests', pg_catalog.to_regclass('public.mortgage_handling_requests')::oid),
      ('public.loss_draft_tracking', pg_catalog.to_regclass('public.loss_draft_tracking')::oid),
      ('public.loss_draft_audit_log', pg_catalog.to_regclass('public.loss_draft_audit_log')::oid),
      ('public.check_messages', pg_catalog.to_regclass('public.check_messages')::oid),
      ('public.aws_mortgage_desk_working_request(uuid, text[])', pg_catalog.to_regprocedure('public.aws_mortgage_desk_working_request(uuid, text[])')::oid),
      ('auth.uid()', pg_catalog.to_regprocedure('auth.uid()')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('mortgage_handling_requests', 'id'), ('mortgage_handling_requests', 'check_intake_item_id'),
      ('loss_draft_tracking', 'id'), ('loss_draft_tracking', 'check_intake_item_id'),
      ('loss_draft_tracking', 'monitoring_type'), ('loss_draft_tracking', 'escrow_status'),
      ('loss_draft_tracking', 'total_escrowed'), ('loss_draft_tracking', 'draw_amount_requested'),
      ('loss_draft_tracking', 'draw_amount_released'), ('loss_draft_tracking', 'holdback_amount'),
      ('loss_draft_tracking', 'draw_stage'), ('loss_draft_tracking', 'updated_at'),
      ('loss_draft_audit_log', 'loss_draft_id'), ('loss_draft_audit_log', 'action'),
      ('loss_draft_audit_log', 'actor_id'), ('loss_draft_audit_log', 'amount'),
      ('loss_draft_audit_log', 'notes'), ('loss_draft_audit_log', 'old_values'),
      ('loss_draft_audit_log', 'new_values'),
      ('check_messages', 'id'), ('check_messages', 'check_id'), ('check_messages', 'sender_id'),
      ('check_messages', 'body'), ('check_messages', 'is_deleted'), ('check_messages', 'created_at')) AS want(tbl, col)
    -- pg_attribute, not information_schema.columns: the latter lists only the columns the applying login holds a
    -- privilege on.
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.' || want.tbl)
         AND a.attname = want.col
         AND a.attnum > 0
         AND NOT a.attisdropped);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql166_prerequisite_missing: SQL 166 needs the Mortgage Desk (SQL 122) and loss draft schema first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(t.oid::regclass::text, ', ' ORDER BY t.oid::regclass::text) INTO v_unreachable
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_roles me ON me.rolname = current_user
  WHERE t.oid IN (pg_catalog.to_regclass('public.mortgage_handling_requests'), pg_catalog.to_regclass('public.loss_draft_tracking'),
                  pg_catalog.to_regclass('public.loss_draft_audit_log'), pg_catalog.to_regclass('public.check_messages'))
    AND NOT (me.rolsuper OR me.rolbypassrls
             OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity));
  IF v_unreachable IS NOT NULL THEN
    RAISE EXCEPTION 'sql166_definer_cannot_reach: the login running SQL 166 must own % (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS',
      v_unreachable
      USING ERRCODE = '55000';
  END IF;
END
$sql166_prereq$;

-- 1) The Desk switches the request's loss draft between Monitored and Not Monitored.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_set_monitoring(_request_id uuid, _monitoring_type text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_ld public.loss_draft_tracking%ROWTYPE;
  v_type text := lower(btrim(COALESCE(_monitoring_type, '')));
  v_previous text;
  v_recorded boolean;
  v_old jsonb;
  v_new jsonb;
  v_body text;
  v_message_id uuid;
BEGIN
  v_req := public.aws_mortgage_desk_working_request(_request_id, ARRAY['in_progress']);
  IF v_type NOT IN ('monitored', 'not_monitored') THEN
    RAISE EXCEPTION 'invalid_monitoring_type' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ld
    FROM public.loss_draft_tracking ld
   WHERE ld.check_intake_item_id = v_req.check_intake_item_id
   ORDER BY ld.id
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_has_no_loss_draft' USING ERRCODE = '22023';
  END IF;
  IF v_ld.escrow_status IN ('endorsing', 'final_release_complete') THEN
    RAISE EXCEPTION 'loss_draft_closed' USING ERRCODE = '42501';
  END IF;

  v_previous := COALESCE(v_ld.monitoring_type, 'monitored');
  v_recorded := COALESCE(v_ld.total_escrowed, 0) > 0
             OR COALESCE(v_ld.draw_amount_requested, 0) > 0
             OR COALESCE(v_ld.draw_amount_released, 0) > 0
             OR COALESCE(v_ld.holdback_amount, 0) > 0
             OR COALESCE(v_ld.draw_stage, 0) > 0
             OR COALESCE(v_ld.escrow_status, '') IN ('escrowed', 'first_draw_requested', 'partial_release');

  IF v_previous = v_type THEN
    RETURN jsonb_build_object(
      'ok', true,
      'changed', false,
      'monitoring_type', v_type,
      'request_id', v_req.id,
      'loss_draft_id', v_ld.id,
      'escrow_or_draws_recorded', v_recorded
    );
  END IF;

  v_old := jsonb_build_object(
    'escrow_status', v_ld.escrow_status,
    'monitoring_type', v_ld.monitoring_type,
    'total_escrowed', v_ld.total_escrowed::text,
    'draw_amount_released', v_ld.draw_amount_released::text,
    'holdback_amount', v_ld.holdback_amount::text
  );
  UPDATE public.loss_draft_tracking ld
     SET monitoring_type = v_type,
         updated_at = now()
   WHERE ld.id = v_ld.id
  RETURNING jsonb_build_object(
    'escrow_status', ld.escrow_status,
    'monitoring_type', ld.monitoring_type,
    'total_escrowed', ld.total_escrowed::text,
    'draw_amount_released', ld.draw_amount_released::text,
    'holdback_amount', ld.holdback_amount::text
  ) INTO v_new;

  v_body := CASE v_type
    WHEN 'not_monitored' THEN 'ChecksOps Mortgage Desk changed this loss draft to Not Monitored.'
    ELSE 'ChecksOps Mortgage Desk changed this loss draft to Monitored.'
  END;

  INSERT INTO public.loss_draft_audit_log (loss_draft_id, action, actor_id, amount, notes, old_values, new_values)
  VALUES (v_ld.id, 'set_monitoring_type', auth.uid(), NULL, v_body, v_old, v_new);

  INSERT INTO public.check_messages (check_id, sender_id, body, is_deleted, created_at)
  VALUES (v_req.check_intake_item_id, auth.uid(), v_body, false, clock_timestamp())
  RETURNING id INTO v_message_id;

  RETURN jsonb_build_object(
    'ok', true,
    'changed', true,
    'monitoring_type', v_type,
    'previous_monitoring_type', v_previous,
    'request_id', v_req.id,
    'loss_draft_id', v_ld.id,
    'message_id', v_message_id,
    'escrow_or_draws_recorded', v_recorded
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_mortgage_desk_set_monitoring(uuid, text) FROM PUBLIC;

DO $sql166_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_mortgage_desk_set_monitoring(uuid, text) FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql166_revoke$;

GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_set_monitoring(uuid, text) TO checksops;
