-- SQL 168: a new check on a claim the Mortgage Desk already handles goes to the same agent, with no action by the tenant.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why (owner 2026-11-16): "We need to make sure once a mortgage agent handles a check, if another check comes in they
-- handle each one for that check file." Owner decisions the same day:
--   1. auto-assign: the system creates the Mortgage Desk request for the new check and assigns it to the same agent; the
--      tenant does nothing;
--   2. the same file is the same linked claim: check_intake_items.claim_id, the claim billing uses;
--   3. the agent is the one who handled a check on that claim, on a request that is in_progress or completed, while that
--      agent is still an active Mortgage Desk agent; with no such agent nothing happens (the tenant sends as today and the
--      request goes to the shared queue);
--   4. the details are copied from that earlier request (mortgage company and servicer, loan number, the typed claim
--      fields, the homeowner details and SSN last 4); the agent can edit them.
-- Today every check needs its own Send to Mortgage Desk (SendToMortgageDeskButton, the API's mortgage_handling_requests
-- insert: status requested, unassigned, SQL 100's tenant rule) and any agent may accept it from the shared queue.
--
-- What this file does (plpgsql, VOLATILE, SECURITY DEFINER, SET search_path = public, pg_temp, SET row_security = on,
-- owned by the applying login):
-- 1) public.aws_mortgage_desk_route_same_agent(_check_id uuid, _fired_by text) RETURNS uuid (the new request's id, or
--    NULL when nothing was done). Idempotent: it does nothing unless every condition below holds, and once it has run the
--    check has an open request, so a second call does nothing.
--      a. the check exists, has a tenant and a claim_id;
--      b. the check is not locked: deposited_at is NULL and check_stage is not deposited, voided or returned (SQL 167's
--         rule, which is SQL 43's, word for word);
--      c. the check has a loss draft file (a loss_draft_tracking row with check_intake_item_id = the check);
--      d. the check has no request that is requested, in_progress or completed (any endorsement order); a cancelled
--         request does not count;
--      e. the source: a request of the same tenant on another check whose current claim_id is this claim, status
--         in_progress or completed, the 1st mortgagee (COALESCE(endorsement_order, 1) = 1, so a 2nd mortgagee's company
--         is never copied), with an assigned agent who is still active as SQL 158's aws_mortgage_desk_assign_agent
--         defines it: has_role(agent, 'mortgage_agent') and no mortgage_agent_accounts row for the agent whose status is
--         not 'active'. The most recent in_progress request (by accepted_at), else the most recent completed one (by
--         completed_at). None: nothing is done;
--      f. INSERT one request for the check, as the tenant's own send writes it: tenant_id and check_intake_item_id of
--         the check, claim_id = the check's claim_id, status requested, unassigned, endorsement_order 1,
--         total_mortgagees and predecessor_request_id NULL, requested_by NULL (no tenant user sent it), and the details
--         copied from the source: mortgage_company, mortgage_servicer, loan_number, policy_number, claim_number,
--         insurance_company, loss_type, date_of_loss, homeowner_name, homeowner_email, homeowner_phone,
--         property_address, homeowner_ssn_last_four. note and work_notes stay empty;
--      g. then the agent's own accept, the same row change as accept_mortgage_handling_request
--         (aws/functions/api/workflow-rpc.mjs executeAcceptMortgage) and SQL 158's assign: assigned_employee_id = the
--         source's agent, status in_progress, accepted_at = COALESCE(accepted_at, now()), updated_at = now(), WHERE the
--         request is still requested and unassigned;
--      h. one public.check_messages row on the new check, so the tenant sees it on the check thread (owner 2026-11-16:
--         a short automatic message; no email to the agent). The columns SQL 166's aws_mortgage_desk_set_monitoring and
--         SQL 122's aws_mortgage_desk_post_message write: check_id, sender_id (the agent, as the Desk's own messages are
--         sent by the agent), body, is_deleted false, created_at clock_timestamp(). Body: "ChecksOps Mortgage Desk added
--         this check to <name>'s file automatically (same claim)." with <name> the agent's profiles.full_name (as SQL
--         158 shows it), or "the agent already handling this claim" when the profile has no name;
--      i. one public.mortgage_ops_request_audit row, the Desk's request history (SQL 84; SQL 158 writes 'assign'):
--         action 'auto_route_same_agent', actor_id NULL (the system), from requested to in_progress, payload with the
--         agent, the source request and check, the claim, the message and what fired it. No column is added.
-- 2) public.aws_mortgage_desk_route_same_agent_trigger() RETURNS trigger: calls 1) for the check of the row, inside its
--    own subtransaction: any error rolls back only the routing (the request, the accept, the message and the audit row) and is
--    reported as a WARNING carrying the SQLSTATE only, so the tenant's save always goes through and the tenant can send
--    as today.
-- 3) Two triggers that run 2):
--      aws_loss_draft_route_same_agent AFTER INSERT ON public.loss_draft_tracking FOR EACH ROW (the loss draft file is
--        created: the API's insert, and trg_auto_create_loss_draft when the check becomes loss_draft_required);
--      aws_check_claim_route_same_agent AFTER UPDATE ON public.check_intake_items FOR EACH ROW WHEN the claim_id is set
--        from NULL or changed to another claim (SQL 41's auto-link, SQL 43's Review save, SQL 44's link, SQL 167's
--        relink). AFTER UPDATE with WHEN rather than UPDATE OF claim_id: SQL 41's auto-link sets claim_id in a BEFORE
--        trigger, which UPDATE OF claim_id would not see.
-- 4) EXECUTE on both functions: REVOKE ALL FROM PUBLIC, and from anon, authenticated, service_role and checksops where
--    those roles exist; the owner keeps its own. Nobody calls them directly: a trigger runs its function without an
--    EXECUTE check, and the API calls nothing new.
--
-- SET row_security = on: SQL 167's claim_ledger_relink_check runs with row_security = off, and that setting would carry
-- into these triggers and the triggers their writes fire (the reason SQL 99 does not set it). On restores the
-- default for them; the owner of the tables (the applying login) is not subject to their RLS either way.
--
-- Never: an email (the database sends none; the API is not involved); a 2nd-mortgagee request (endorsement_order 2); any change to an existing request; a deposited, voided or
-- returned check; a check with no claim or no loss draft file; another tenant's request or agent; an inactive agent.
-- There is no per-tenant Mortgage Ops access flag in the schema to check: a tenant reaches this only through a request
-- it sent itself on an earlier check of the same claim.
--
-- Billing: the accept in g fires the live accept triggers on mortgage_handling_requests unchanged
-- (tr_accrue_mortgage_ops_billing, tr_reject_inactive_mortgage_agent_accept, trg_mirror_mortgage_dates, the updated_at
-- trigger) and the INSERT in f fires the INSERT ones (trg_share_library_docs_to_mortgage_request), as a tenant's send then
-- an agent's accept do. Under SQL 160's accrue_mortgage_ops_billing the new request records no charge when the tenant
-- already has a mortgage_ops_initial or mortgage_ops_additional_check event that is not voided on this claim
-- (check_billing_events.claim_id); it records mortgage_ops_initial at the tenant's initial rate (1000 by default) only
-- when there is none (an earlier request accepted before mortgage_ops_billing_launch, its charge voided, or recorded under
-- another claim id). SQL 160's earn_mortgage_agent_compensation (at completion) pays nothing for it when, with no
-- billing event on its check, the tenant already has another completed request on the claim
-- (mortgage_handling_requests.claim_id); it pays the initial amount when the request has the mortgage_ops_initial event
-- above, or when it completes before any other request on the claim is completed (the source still in progress). The
-- API's own accrual (mortgage-ops-usage.mjs, after executeAcceptMortgage) does not run: the trigger is the durable path.
--
-- The message fires the live triggers on check_messages unchanged, as SQL 166's and SQL 122's Desk messages do.
--
-- Not changed: no table, column, policy, RLS setting, table grant or row; no other function or trigger (SQL 158's
-- assign, SQL 160's billing, SQL 167's relink keep their bodies). Adds two public triggers: the DB validator's justified
-- set and expected count follow once this file is applied, not before (as SQL 121).
--
-- Refuses to run (55000 sql168_prerequisite_missing) without the relations, columns and has_role(uuid, app_role) it
-- uses, and (55000 sql168_definer_cannot_reach) unless the applying login owns the relations it reads or writes without
-- FORCE ROW LEVEL SECURITY, or is a superuser or BYPASSRLS: a DEFINER filtered by RLS would see no earlier request.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change. Existing checks are not back-filled: the triggers
-- act on new events only.

DO $sql168_prereq$
DECLARE
  v_missing text[];
  v_unreachable text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.check_intake_items', pg_catalog.to_regclass('public.check_intake_items')::oid),
      ('public.loss_draft_tracking', pg_catalog.to_regclass('public.loss_draft_tracking')::oid),
      ('public.mortgage_handling_requests', pg_catalog.to_regclass('public.mortgage_handling_requests')::oid),
      ('public.mortgage_ops_request_audit', pg_catalog.to_regclass('public.mortgage_ops_request_audit')::oid),
      ('public.mortgage_agent_accounts', pg_catalog.to_regclass('public.mortgage_agent_accounts')::oid),
      ('public.check_messages', pg_catalog.to_regclass('public.check_messages')::oid),
      ('public.profiles', pg_catalog.to_regclass('public.profiles')::oid),
      ('public.has_role(uuid, public.app_role)', pg_catalog.to_regprocedure('public.has_role(uuid, public.app_role)')::oid)
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('check_intake_items', 'id'), ('check_intake_items', 'tenant_id'), ('check_intake_items', 'claim_id'),
      ('check_intake_items', 'check_stage'), ('check_intake_items', 'deposited_at'),
      ('loss_draft_tracking', 'check_intake_item_id'),
      ('mortgage_handling_requests', 'id'), ('mortgage_handling_requests', 'tenant_id'),
      ('mortgage_handling_requests', 'check_intake_item_id'), ('mortgage_handling_requests', 'claim_id'),
      ('mortgage_handling_requests', 'status'), ('mortgage_handling_requests', 'assigned_employee_id'),
      ('mortgage_handling_requests', 'accepted_at'), ('mortgage_handling_requests', 'completed_at'),
      ('mortgage_handling_requests', 'created_at'), ('mortgage_handling_requests', 'updated_at'),
      ('mortgage_handling_requests', 'endorsement_order'),
      ('mortgage_handling_requests', 'mortgage_company'), ('mortgage_handling_requests', 'mortgage_servicer'),
      ('mortgage_handling_requests', 'loan_number'), ('mortgage_handling_requests', 'policy_number'),
      ('mortgage_handling_requests', 'claim_number'), ('mortgage_handling_requests', 'insurance_company'),
      ('mortgage_handling_requests', 'loss_type'), ('mortgage_handling_requests', 'date_of_loss'),
      ('mortgage_handling_requests', 'homeowner_name'), ('mortgage_handling_requests', 'homeowner_email'),
      ('mortgage_handling_requests', 'homeowner_phone'), ('mortgage_handling_requests', 'property_address'),
      ('mortgage_handling_requests', 'homeowner_ssn_last_four'),
      ('mortgage_ops_request_audit', 'mortgage_request_id'), ('mortgage_ops_request_audit', 'actor_id'),
      ('mortgage_ops_request_audit', 'action'), ('mortgage_ops_request_audit', 'reason'),
      ('mortgage_ops_request_audit', 'from_status'), ('mortgage_ops_request_audit', 'to_status'),
      ('mortgage_ops_request_audit', 'payload'),
      ('mortgage_agent_accounts', 'application_user_id'), ('mortgage_agent_accounts', 'status'),
      ('check_messages', 'id'), ('check_messages', 'check_id'), ('check_messages', 'sender_id'),
      ('check_messages', 'body'), ('check_messages', 'is_deleted'), ('check_messages', 'created_at'),
      ('profiles', 'id'), ('profiles', 'full_name')) AS want(tbl, col)
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
    RAISE EXCEPTION 'sql168_prerequisite_missing: SQL 168 needs the Mortgage Desk request, audit, agent and check message schema, the loss draft and check columns, profiles and has_role first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(t.oid::regclass::text, ', ' ORDER BY t.oid::regclass::text) INTO v_unreachable
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_roles me ON me.rolname = current_user
  WHERE t.oid IN (pg_catalog.to_regclass('public.check_intake_items'), pg_catalog.to_regclass('public.loss_draft_tracking'),
                  pg_catalog.to_regclass('public.mortgage_handling_requests'), pg_catalog.to_regclass('public.mortgage_ops_request_audit'),
                  pg_catalog.to_regclass('public.mortgage_agent_accounts'), pg_catalog.to_regclass('public.check_messages'),
                  pg_catalog.to_regclass('public.profiles'))
    AND NOT (me.rolsuper OR me.rolbypassrls
             OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity));
  IF v_unreachable IS NOT NULL THEN
    RAISE EXCEPTION 'sql168_definer_cannot_reach: the login running SQL 168 must own % (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS',
      v_unreachable
      USING ERRCODE = '55000';
  END IF;
END
$sql168_prereq$;

-- 1) The routing: one request for the check, accepted for the agent who handled the claim's earlier check.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_route_same_agent(_check_id uuid, _fired_by text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant uuid;
  v_claim uuid;
  v_stage text;
  v_deposited timestamptz;
  v_src public.mortgage_handling_requests%ROWTYPE;
  v_new uuid;
  v_after uuid;
  v_agent_name text;
  v_message_id uuid;
BEGIN
  IF _check_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.tenant_id, c.claim_id, c.check_stage::text, c.deposited_at
    INTO v_tenant, v_claim, v_stage, v_deposited
    FROM public.check_intake_items c
   WHERE c.id = _check_id;
  IF NOT FOUND OR v_tenant IS NULL OR v_claim IS NULL THEN
    RETURN NULL;
  END IF;

  -- SQL 167's lock rule (SQL 43's): never a deposited, voided or returned check.
  IF v_deposited IS NOT NULL OR COALESCE(v_stage, '') IN ('deposited', 'voided', 'returned') THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.loss_draft_tracking ld WHERE ld.check_intake_item_id = _check_id
  ) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.mortgage_handling_requests r
     WHERE r.check_intake_item_id = _check_id
       AND r.status IN ('requested', 'in_progress', 'completed')
  ) THEN
    RETURN NULL;
  END IF;

  SELECT r.* INTO v_src
    FROM public.mortgage_handling_requests r
    JOIN public.check_intake_items pc ON pc.id = r.check_intake_item_id
   WHERE r.tenant_id = v_tenant
     AND pc.tenant_id = v_tenant
     AND pc.claim_id = v_claim
     AND r.check_intake_item_id <> _check_id
     AND r.status IN ('in_progress', 'completed')
     AND COALESCE(r.endorsement_order, 1) = 1
     AND r.assigned_employee_id IS NOT NULL
     AND public.has_role(r.assigned_employee_id, 'mortgage_agent'::public.app_role)
     AND NOT EXISTS (
       SELECT 1 FROM public.mortgage_agent_accounts m
        WHERE m.application_user_id = r.assigned_employee_id AND m.status <> 'active')
   ORDER BY CASE r.status WHEN 'in_progress' THEN 0 ELSE 1 END,
            CASE WHEN r.status = 'in_progress' THEN COALESCE(r.accepted_at, r.created_at)
                 ELSE COALESCE(r.completed_at, r.accepted_at, r.created_at) END DESC NULLS LAST,
            r.created_at DESC,
            r.id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.mortgage_handling_requests (
    tenant_id, check_intake_item_id, claim_id, status, endorsement_order,
    mortgage_company, mortgage_servicer, loan_number,
    policy_number, claim_number, insurance_company, loss_type, date_of_loss,
    homeowner_name, homeowner_email, homeowner_phone, property_address, homeowner_ssn_last_four
  ) VALUES (
    v_tenant, _check_id, v_claim, 'requested', 1,
    v_src.mortgage_company, v_src.mortgage_servicer, v_src.loan_number,
    v_src.policy_number, v_src.claim_number, v_src.insurance_company, v_src.loss_type, v_src.date_of_loss,
    v_src.homeowner_name, v_src.homeowner_email, v_src.homeowner_phone, v_src.property_address, v_src.homeowner_ssn_last_four
  )
  RETURNING id INTO v_new;

  -- The agent's own accept (workflow-rpc.mjs executeAcceptMortgage; SQL 158's assign).
  UPDATE public.mortgage_handling_requests r
     SET assigned_employee_id = v_src.assigned_employee_id,
         status = 'in_progress',
         accepted_at = COALESCE(r.accepted_at, now()),
         updated_at = now()
   WHERE r.id = v_new
     AND r.assigned_employee_id IS NULL
     AND r.status = 'requested'
  RETURNING r.id INTO v_after;
  IF v_after IS NULL THEN
    RAISE EXCEPTION 'sql168_route_not_accepted' USING ERRCODE = 'P0001';
  END IF;

  -- The tenant sees it on the check thread (the columns SQL 166 writes; sent by the agent, as the Desk's messages are).
  SELECT NULLIF(btrim(COALESCE(p.full_name, '')), '') INTO v_agent_name
    FROM public.profiles p
   WHERE p.id = v_src.assigned_employee_id;
  INSERT INTO public.check_messages (check_id, sender_id, body, is_deleted, created_at)
  VALUES (
    _check_id, v_src.assigned_employee_id,
    'ChecksOps Mortgage Desk added this check to '
      || COALESCE(v_agent_name || '''s', 'the agent already handling this claim''s')
      || ' file automatically (same claim).',
    false, clock_timestamp())
  RETURNING id INTO v_message_id;

  INSERT INTO public.mortgage_ops_request_audit (mortgage_request_id, actor_id, action, reason, from_status, to_status, payload)
  VALUES (
    v_new, NULL, 'auto_route_same_agent',
    'Routed to the agent who handled an earlier check on this claim', 'requested', 'in_progress',
    jsonb_build_object(
      'agent_id', v_src.assigned_employee_id,
      'source_request_id', v_src.id,
      'source_check_id', v_src.check_intake_item_id,
      'source_request_status', v_src.status,
      'claim_id', v_claim,
      'message_id', v_message_id,
      'fired_by', _fired_by,
      'source', 'sql168'));

  RETURN v_new;
END;
$$;

-- 2) The trigger function: the routing for the row's check, in its own subtransaction.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_route_same_agent_trigger()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = on
AS $$
DECLARE
  v_check uuid;
BEGIN
  IF TG_TABLE_NAME = 'loss_draft_tracking' THEN
    v_check := NEW.check_intake_item_id;
  ELSIF TG_TABLE_NAME = 'check_intake_items' THEN
    IF TG_OP = 'UPDATE' AND OLD.claim_id IS NOT DISTINCT FROM NEW.claim_id THEN
      RETURN NULL;
    END IF;
    v_check := NEW.id;
  ELSE
    RETURN NULL;
  END IF;

  BEGIN
    PERFORM public.aws_mortgage_desk_route_same_agent(v_check, TG_TABLE_NAME);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sql168_route_skipped: %', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.aws_mortgage_desk_route_same_agent(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_route_same_agent_trigger() FROM PUBLIC;

DO $sql168_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'checksops'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_mortgage_desk_route_same_agent(uuid, text) FROM %I', v_role);
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_mortgage_desk_route_same_agent_trigger() FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql168_revoke$;

-- 3) The fire points.
DROP TRIGGER IF EXISTS aws_loss_draft_route_same_agent ON public.loss_draft_tracking;
CREATE TRIGGER aws_loss_draft_route_same_agent
  AFTER INSERT ON public.loss_draft_tracking
  FOR EACH ROW EXECUTE FUNCTION public.aws_mortgage_desk_route_same_agent_trigger();

DROP TRIGGER IF EXISTS aws_check_claim_route_same_agent ON public.check_intake_items;
CREATE TRIGGER aws_check_claim_route_same_agent
  AFTER UPDATE ON public.check_intake_items
  FOR EACH ROW
  WHEN (NEW.claim_id IS NOT NULL AND OLD.claim_id IS DISTINCT FROM NEW.claim_id)
  EXECUTE FUNCTION public.aws_mortgage_desk_route_same_agent_trigger();
