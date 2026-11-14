-- SQL 167: correct a linked check's claim number so the check joins the claim that number names.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: a check is linked to a claim (check_intake_items.claim_id) only while the link is empty: SQL 41's
-- OCR persist and auto-link triggers, SQL 43's Review save and SQL 44's claim_ledger_link_or_create
-- ("Already-linked checks return the existing claim and never relink or create", update only
-- WHERE claim_id IS NULL), and SQL 89 removed the API's column UPDATE on check_intake_items.claim_id.
-- So once a check is linked under a wrong claim number, correcting the number renames that claim and
-- the check never reaches the existing claim the corrected number names. Owner 2026-11-14: "Need to be
-- able to change/correct claim number once edited for ledger to link to existing claim." Decisions:
-- correctable only before deposit (SQL 43's lock rule); when the check moves, its loss draft file and
-- its signature requests move with it; a corrected number that matches no claim keeps today's
-- behaviour (rename), which is not this function.
--
-- What this file does:
-- 1) public.claim_ledger_relink_check(p_check_id uuid, p_tenant_id uuid, p_claim_number text,
--    p_action text, p_actor_id uuid) RETURNS jsonb: new, plpgsql, VOLATILE, SECURITY DEFINER,
--    SET search_path TO public, SET row_security = off, owned by the applying login (as SQL 44's
--    claim_ledger_link_or_create). p_action is 'inspect' or 'relink'.
--      a. arguments: p_check_id, p_tenant_id and a claim number with a non-empty
--         ocr_claim_number_key (SQL 41) are required (invalid_args); p_action must be inspect or
--         relink (invalid_action); relink also needs p_actor_id (actor_required);
--      b. locks the check (SELECT ... FOR UPDATE); check_not_found; tenant_mismatch when the check is
--         not p_tenant_id's; locked when deposited_at is set or check_stage is deposited, voided or
--         returned (SQL 43's rule, word for word); not_linked when the check has no claim yet (that is
--         SQL 44's link_or_create, unchanged);
--      c. finds the claim the number names with SQL 44's same-tenant match, copied exactly: the
--         normalised key ocr_claim_number_key(claims.claim_number); a claim of p_tenant_id
--         (claims.org_id), or a legacy claim with no org_id that one of p_tenant_id's checks links and
--         no other tenant's check links. Several such claims, or a legacy claim linked from p_tenant_id
--         and from another tenant, is ambiguous; a claim only another tenant owns or links is
--         cross_tenant; no claim is no_match (the caller renames as today). It never creates, renames
--         or deletes a claim;
--      d. the target is the check's current claim: unchanged (nothing written);
--      e. inspect returns the target claim (id, number, policyholder name), the current claim (id,
--         number), how many of p_tenant_id's other checks stay on the current claim, whether the
--         current claim has claim_settlements rows, and how many of this check's loss_draft_tracking
--         and signature_requests rows would move. It writes nothing;
--      f. relink moves this check only:
--           UPDATE check_intake_items SET claim_id = target WHERE id = p_check_id AND tenant_id =
--           p_tenant_id AND claim_id = the current claim AND not deposited (SQL 43's rule again);
--         then this check's loss_draft_tracking rows and signature_requests rows
--         (check_intake_item_id = p_check_id) still on the current claim move to the target, and one
--         check_audit_log row records it (check_id, tenant_id, actor_id, event_type claim_relinked,
--         event_description, event_data with the previous and new claim). It never touches another
--         check, another check's loss draft or signature rows, claim_settlements, payouts, or either
--         claims row. Returns old_claim_remaining_check_count (p_tenant_id's checks still on the
--         previous claim) and the rows moved.
--    Return shape as SQL 44: jsonb with ok, persisted and code; never another tenant's claim id, number
--    or name.
-- 2) EXECUTE: REVOKE ALL FROM PUBLIC, and from anon, authenticated and service_role where those roles
--    exist; GRANT EXECUTE TO checksops (the API login; the RPC route and the Review screen are separate,
--    later changes). The owner keeps its own.
--
-- Triggers that fire on the writes (not changed here): on check_intake_items, the case trigger
-- assign_case_on_check_intake (BEFORE INSERT OR UPDATE OF claim_id, freedom_claim_id, tenant_id;
-- tg_check_intake_assign_case, SQL 87) and SQL 41's auto-link triggers act only when case_id or
-- claim_id is NULL, so the check keeps its case_id and its new claim_id; on loss_draft_tracking and
-- signature_requests the case triggers (tg_loss_draft_assign_case, SQL 87; tg_claim_id_assign_case,
-- SQL 88) likewise act only on a NULL case_id. No file under aws/ defines trg_sync_check_claim_ledger
-- (supabase/migrations/20260918170100_sync_check_claim_ledger.sql, marked UNAPPLIED, and absent from
-- aws/db-copy/analysis/triggers_classified.json); were it live, a relink would also move this check's
-- claim_checks and claim_payments rows through it.
--
-- Not changed: no table, column, policy, RLS setting, table grant, trigger or row; no other function
-- (SQL 41, SQL 43 and SQL 44 keep their bodies and ACLs).
--
-- Refuses to run (55000 sql167_prerequisite_missing) without the relations, columns, helper function
-- and role it uses, and (55000 sql167_definer_cannot_reach) unless the applying login owns the
-- relations it reads and writes without FORCE ROW LEVEL SECURITY, or is a superuser or BYPASSRLS: a
-- DEFINER function filtered by RLS would find no check and move nothing.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql167_prereq$
DECLARE
  v_missing text[];
  v_unreachable text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.check_intake_items', pg_catalog.to_regclass('public.check_intake_items')::oid),
      ('public.claims', pg_catalog.to_regclass('public.claims')::oid),
      ('public.loss_draft_tracking', pg_catalog.to_regclass('public.loss_draft_tracking')::oid),
      ('public.signature_requests', pg_catalog.to_regclass('public.signature_requests')::oid),
      ('public.check_audit_log', pg_catalog.to_regclass('public.check_audit_log')::oid),
      ('public.claim_settlements', pg_catalog.to_regclass('public.claim_settlements')::oid),
      ('public.ocr_claim_number_key(text)', pg_catalog.to_regprocedure('public.ocr_claim_number_key(text)')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('check_intake_items', 'id'), ('check_intake_items', 'tenant_id'), ('check_intake_items', 'claim_id'),
      ('check_intake_items', 'check_stage'), ('check_intake_items', 'deposited_at'),
      ('check_intake_items', 'updated_at'),
      ('claims', 'id'), ('claims', 'claim_number'), ('claims', 'org_id'), ('claims', 'policyholder_name'),
      ('loss_draft_tracking', 'check_intake_item_id'), ('loss_draft_tracking', 'claim_id'),
      ('signature_requests', 'check_intake_item_id'), ('signature_requests', 'claim_id'),
      ('check_audit_log', 'check_id'), ('check_audit_log', 'tenant_id'), ('check_audit_log', 'actor_id'),
      ('check_audit_log', 'event_type'), ('check_audit_log', 'event_description'),
      ('check_audit_log', 'event_data'),
      ('claim_settlements', 'claim_id')) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.' || want.tbl) AND a.attname = want.col
         AND a.attnum > 0 AND NOT a.attisdropped);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql167_prerequisite_missing: SQL 167 needs the check, claim, loss draft, signature request, audit and settlement schema and SQL 41''s ocr_claim_number_key first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(t.oid::regclass::text, ', ' ORDER BY t.oid::regclass::text) INTO v_unreachable
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_roles me ON me.rolname = current_user
  WHERE t.oid IN (pg_catalog.to_regclass('public.check_intake_items'), pg_catalog.to_regclass('public.claims'),
                  pg_catalog.to_regclass('public.loss_draft_tracking'), pg_catalog.to_regclass('public.signature_requests'),
                  pg_catalog.to_regclass('public.check_audit_log'), pg_catalog.to_regclass('public.claim_settlements'))
    AND NOT (me.rolsuper OR me.rolbypassrls
             OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity));
  IF v_unreachable IS NOT NULL THEN
    RAISE EXCEPTION 'sql167_definer_cannot_reach: the login running SQL 167 must own % (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS',
      v_unreachable
      USING ERRCODE = '55000';
  END IF;
END
$sql167_prereq$;

CREATE OR REPLACE FUNCTION public.claim_ledger_relink_check(
  p_check_id uuid,
  p_tenant_id uuid,
  p_claim_number text,
  p_action text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
SET row_security = off
AS $$
DECLARE
  v_action text := lower(btrim(COALESCE(p_action, '')));
  v_incoming text := nullif(btrim(p_claim_number), '');
  v_key text;
  v_check_tenant uuid;
  v_old uuid;
  v_stage text;
  v_deposited timestamptz;
  v_old_number text;
  v_same_id uuid;
  v_same_number text;
  v_same_name text;
  v_same_count int;
  v_other_count int;
  v_ambiguous_own int;
  v_after uuid;
  v_other_checks int := 0;
  v_has_settlements boolean := false;
  v_loss_drafts int := 0;
  v_signatures int := 0;
BEGIN
  IF p_check_id IS NULL OR p_tenant_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'invalid_args');
  END IF;

  IF v_action NOT IN ('inspect', 'relink') THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'invalid_action');
  END IF;

  IF v_incoming IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'invalid_args');
  END IF;

  v_key := public.ocr_claim_number_key(v_incoming);
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'invalid_args');
  END IF;

  IF v_action = 'relink' AND p_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'actor_required');
  END IF;

  SELECT tenant_id, claim_id, check_stage::text, deposited_at
    INTO v_check_tenant, v_old, v_stage, v_deposited
  FROM public.check_intake_items
  WHERE id = p_check_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'check_not_found');
  END IF;

  IF v_check_tenant IS DISTINCT FROM p_tenant_id THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'tenant_mismatch');
  END IF;

  IF v_deposited IS NOT NULL OR COALESCE(v_stage, '') IN ('deposited', 'voided', 'returned') THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'locked');
  END IF;

  IF v_old IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'not_linked');
  END IF;

  SELECT count(*)
    INTO v_same_count
  FROM public.claims c
  WHERE public.ocr_claim_number_key(c.claim_number) = v_key
    AND (
      c.org_id IS NOT DISTINCT FROM p_tenant_id
      OR (
        c.org_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.check_intake_items ev
          WHERE ev.claim_id = c.id
            AND ev.tenant_id IS NOT DISTINCT FROM p_tenant_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.check_intake_items ev
          WHERE ev.claim_id = c.id
            AND ev.tenant_id IS NOT NULL
            AND ev.tenant_id IS DISTINCT FROM p_tenant_id
        )
      )
    );

  SELECT count(*)
    INTO v_ambiguous_own
  FROM public.claims c
  WHERE public.ocr_claim_number_key(c.claim_number) = v_key
    AND c.org_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.check_intake_items ev
      WHERE ev.claim_id = c.id
        AND ev.tenant_id IS NOT DISTINCT FROM p_tenant_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.check_intake_items ev
      WHERE ev.claim_id = c.id
        AND ev.tenant_id IS NOT NULL
        AND ev.tenant_id IS DISTINCT FROM p_tenant_id
    );

  SELECT count(*)
    INTO v_other_count
  FROM public.claims c
  WHERE public.ocr_claim_number_key(c.claim_number) = v_key
    AND (
      (c.org_id IS NOT NULL AND c.org_id IS DISTINCT FROM p_tenant_id)
      OR (
        c.org_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.check_intake_items ev
          WHERE ev.claim_id = c.id
            AND ev.tenant_id IS NOT NULL
            AND ev.tenant_id IS DISTINCT FROM p_tenant_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.check_intake_items ev
          WHERE ev.claim_id = c.id
            AND ev.tenant_id IS NOT DISTINCT FROM p_tenant_id
        )
      )
    );

  IF COALESCE(v_same_count, 0) > 1 OR COALESCE(v_ambiguous_own, 0) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'ambiguous');
  END IF;

  IF COALESCE(v_same_count, 0) = 1 THEN
    SELECT c.id, c.claim_number, c.policyholder_name
      INTO v_same_id, v_same_number, v_same_name
    FROM public.claims c
    WHERE public.ocr_claim_number_key(c.claim_number) = v_key
      AND (
        c.org_id IS NOT DISTINCT FROM p_tenant_id
        OR (
          c.org_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM public.check_intake_items ev
            WHERE ev.claim_id = c.id
              AND ev.tenant_id IS NOT DISTINCT FROM p_tenant_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.check_intake_items ev
            WHERE ev.claim_id = c.id
              AND ev.tenant_id IS NOT NULL
              AND ev.tenant_id IS DISTINCT FROM p_tenant_id
          )
        )
      );
  END IF;

  IF v_same_id IS NULL THEN
    IF COALESCE(v_other_count, 0) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'persisted', false, 'code', 'cross_tenant');
    END IF;
    RETURN jsonb_build_object(
      'ok', (v_action = 'inspect'),
      'persisted', false,
      'code', 'no_match',
      'claim_id', NULL,
      'claim_number', v_incoming,
      'check_claim_id', v_old
    );
  END IF;

  IF v_same_id = v_old THEN
    RETURN jsonb_build_object(
      'ok', true,
      'persisted', false,
      'code', 'unchanged',
      'claim_id', v_same_id,
      'claim_number', v_same_number,
      'policyholder_name', v_same_name,
      'check_claim_id', v_old
    );
  END IF;

  SELECT c.claim_number INTO v_old_number FROM public.claims c WHERE c.id = v_old;

  SELECT count(*)
    INTO v_other_checks
  FROM public.check_intake_items i
  WHERE i.claim_id = v_old
    AND i.id <> p_check_id
    AND i.tenant_id IS NOT DISTINCT FROM p_tenant_id;

  SELECT EXISTS (SELECT 1 FROM public.claim_settlements s WHERE s.claim_id = v_old)
    INTO v_has_settlements;

  IF v_action = 'inspect' THEN
    SELECT count(*) INTO v_loss_drafts
    FROM public.loss_draft_tracking l
    WHERE l.check_intake_item_id = p_check_id
      AND l.claim_id = v_old;

    SELECT count(*) INTO v_signatures
    FROM public.signature_requests r
    WHERE r.check_intake_item_id = p_check_id
      AND r.claim_id = v_old;

    RETURN jsonb_build_object(
      'ok', true,
      'persisted', false,
      'code', 'relink_available',
      'can_relink', true,
      'claim_id', v_same_id,
      'claim_number', v_same_number,
      'policyholder_name', v_same_name,
      'check_claim_id', v_old,
      'old_claim_id', v_old,
      'old_claim_number', v_old_number,
      'old_claim_other_check_count', COALESCE(v_other_checks, 0),
      'old_claim_has_settlements', COALESCE(v_has_settlements, false),
      'loss_draft_rows_to_move', COALESCE(v_loss_drafts, 0),
      'signature_request_rows_to_move', COALESCE(v_signatures, 0)
    );
  END IF;

  -- relink
  UPDATE public.check_intake_items
     SET claim_id = v_same_id,
         updated_at = now()
   WHERE id = p_check_id
     AND tenant_id IS NOT DISTINCT FROM p_tenant_id
     AND claim_id = v_old
     AND deposited_at IS NULL
     AND COALESCE(check_stage::text, '') NOT IN ('deposited', 'voided', 'returned')
  RETURNING claim_id INTO v_after;

  IF NOT FOUND OR v_after IS DISTINCT FROM v_same_id THEN
    RAISE EXCEPTION 'claim_ledger_relink_failed'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.loss_draft_tracking
     SET claim_id = v_same_id
   WHERE check_intake_item_id = p_check_id
     AND claim_id = v_old;
  GET DIAGNOSTICS v_loss_drafts = ROW_COUNT;

  UPDATE public.signature_requests
     SET claim_id = v_same_id
   WHERE check_intake_item_id = p_check_id
     AND claim_id = v_old;
  GET DIAGNOSTICS v_signatures = ROW_COUNT;

  INSERT INTO public.check_audit_log (check_id, tenant_id, actor_id, event_type, event_description, event_data)
  VALUES (
    p_check_id, p_tenant_id, p_actor_id, 'claim_relinked',
    'Claim number corrected: check moved from claim ' || COALESCE(v_old_number, v_old::text)
      || ' to claim ' || COALESCE(v_same_number, v_same_id::text),
    jsonb_build_object(
      'previous_claim_id', v_old,
      'previous_claim_number', v_old_number,
      'new_claim_id', v_same_id,
      'new_claim_number', v_same_number,
      'claim_number_entered', v_incoming,
      'loss_draft_rows_moved', v_loss_drafts,
      'signature_request_rows_moved', v_signatures,
      'source', 'claim_ledger_relink_check'));

  RETURN jsonb_build_object(
    'ok', true,
    'persisted', true,
    'code', 'relinked',
    'claim_id', v_same_id,
    'claim_number', v_same_number,
    'policyholder_name', v_same_name,
    'check_claim_id', v_after,
    'old_claim_id', v_old,
    'old_claim_number', v_old_number,
    'old_claim_remaining_check_count', COALESCE(v_other_checks, 0),
    'old_claim_has_settlements', COALESCE(v_has_settlements, false),
    'loss_draft_rows_moved', v_loss_drafts,
    'signature_request_rows_moved', v_signatures
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ledger_relink_check(uuid, uuid, text, text, uuid) FROM PUBLIC;

DO $sql167_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.claim_ledger_relink_check(uuid, uuid, text, text, uuid) FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql167_revoke$;

GRANT EXECUTE ON FUNCTION public.claim_ledger_relink_check(uuid, uuid, text, text, uuid) TO checksops;
