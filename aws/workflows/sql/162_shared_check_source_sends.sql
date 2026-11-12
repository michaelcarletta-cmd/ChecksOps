-- SQL 162: a partner learns which checks shared with it the sharing organization has paid from by a
-- send to someone else. AWS only: nothing under supabase/migrations changes.
--
-- Why: a send from the Funds tab (aws/functions/api/providers/production/moov-send.mjs) writes its
-- payment_transfers legs (leg_role send_wallet / send_bank) under the SENDER's tenant_id and does not
-- change the check's check_stage. A check the sender shares with a partner (public.shared_checks) is
-- the same check_intake_items row on both sides, so after such a send it is still check_stage
-- deposited for the partner. When the send pays the partner, the partner reads the leg through
-- public.get_tenant_incoming_transfers (SQL 144) and the check leaves its Deposited tab for Funds
-- Received. When the send pays someone else (a homeowner, a contractor, a mortgage company), the
-- partner can read nothing about it: aws_select_payment_transfers lets a member read only its own
-- tenant_id, and SQL 144 returns only legs addressed to the caller. The check stays under the
-- partner's Deposited although its funds have been paid out. Owner 2026-11-12: "If you pay from a
-- shared check using Send from the Funds tab ... It should not send the partner check back to
-- deposited", and, asked which case is still open, "Sends to someone other than the partner";
-- approval to build: "Yes for 1, 2, and run the inspect".
--
-- What this file does:
-- 1) public.get_shared_check_source_sends(_tenant_id uuid): new, plpgsql, STABLE, SECURITY DEFINER,
--    search_path = public, pg_temp, owned by the applying login. A narrow read instead of a select
--    policy, so the partner never sees the sender's rows:
--      a. caller gate: _tenant_id present and public.aws_can_access_tenant(_tenant_id) (a member of
--         that organization or a cross-tenant reader, the rule the API's RPC gate applies), else
--         42501 shared_check_source_sends_forbidden;
--      b. rows: one per check and sharing organization, for the checks shared with _tenant_id
--         (public.shared_checks: target_tenant_id = _tenant_id, source_tenant_id another
--         organization, revoked_at IS NULL) from which the sharing organization has a
--         public.payment_transfers leg (tenant_id = the sharing organization, check_id = the check,
--         leg_role send_wallet or send_bank, status submitted, pending, processing or completed)
--         whose destination_tenant_id is not _tenant_id (NULL, an outside payee, included).
--         Returned, failed, canceled, draft, ready, submitting and unknown legs do not count: that
--         money did not leave, or came back. Newest first, at most 5000;
--      c. columns: check_id, source_tenant_id and last_sent_at (the newest such leg's created_at).
--         Never an amount, a payee, a destination, a status, a transfer id or any other column: the
--         partner learns that the sharing organization paid out of a check it already reads, and
--         when, nothing about whom or how much.
-- 2) EXECUTE: REVOKE ALL FROM PUBLIC, and from anon, authenticated and service_role where those roles
--    exist; GRANT EXECUTE TO checksops (the API login; aws/functions/api/data.mjs READ_RPCS with the
--    tenant gate is a separate, later change). The owner keeps its own. The ACL is checksops and the
--    owner, as SQL 144 leaves get_tenant_incoming_transfers.
--
-- Not changed: no table, column, policy, RLS setting, table grant, trigger or row; no other function
-- (get_tenant_incoming_transfers and get_tenant_funds_received keep their bodies and ACLs). The
-- sender's own reads are unchanged.
--
-- Refuses to run (55000 sql162_prerequisite_missing) without the relations, columns, helper function
-- and role it uses, and (55000 sql162_definer_cannot_reach) unless the applying login owns the two
-- relations it reads (payment_transfers, shared_checks) without FORCE ROW LEVEL SECURITY, or is a
-- superuser or BYPASSRLS: a DEFINER read filtered by RLS would show the partner nothing.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql162_prereq$
DECLARE
  v_missing text[];
  v_unreachable text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.payment_transfers', pg_catalog.to_regclass('public.payment_transfers')::oid),
      ('public.shared_checks', pg_catalog.to_regclass('public.shared_checks')::oid),
      ('public.aws_can_access_tenant(uuid)', pg_catalog.to_regprocedure('public.aws_can_access_tenant(uuid)')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('payment_transfers', 'tenant_id'), ('payment_transfers', 'destination_tenant_id'),
      ('payment_transfers', 'leg_role'), ('payment_transfers', 'status'),
      ('payment_transfers', 'check_id'), ('payment_transfers', 'created_at'),
      ('shared_checks', 'check_id'), ('shared_checks', 'source_tenant_id'),
      ('shared_checks', 'target_tenant_id'), ('shared_checks', 'revoked_at')) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql162_prerequisite_missing: SQL 162 needs the payment transfer and check sharing schema first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(t.oid::regclass::text, ', ' ORDER BY t.oid::regclass::text) INTO v_unreachable
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_roles me ON me.rolname = current_user
  WHERE t.oid IN (pg_catalog.to_regclass('public.payment_transfers'), pg_catalog.to_regclass('public.shared_checks'))
    AND NOT (me.rolsuper OR me.rolbypassrls
             OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity));
  IF v_unreachable IS NOT NULL THEN
    RAISE EXCEPTION 'sql162_definer_cannot_reach: the login running SQL 162 must own % (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS',
      v_unreachable
      USING ERRCODE = '55000';
  END IF;
END
$sql162_prereq$;

CREATE OR REPLACE FUNCTION public.get_shared_check_source_sends(_tenant_id uuid)
RETURNS TABLE(
  check_id uuid,
  source_tenant_id uuid,
  last_sent_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF _tenant_id IS NULL OR NOT COALESCE(public.aws_can_access_tenant(_tenant_id), false) THEN
    RAISE EXCEPTION 'shared_check_source_sends_forbidden'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    sc.check_id,
    sc.source_tenant_id,
    max(pt.created_at)
  FROM public.shared_checks sc
  JOIN public.payment_transfers pt
    ON pt.check_id = sc.check_id
   AND pt.tenant_id = sc.source_tenant_id
  WHERE sc.target_tenant_id = _tenant_id
    AND sc.source_tenant_id <> _tenant_id
    AND sc.revoked_at IS NULL
    AND pt.leg_role IN ('send_wallet', 'send_bank')
    AND pt.status IN ('submitted', 'pending', 'processing', 'completed')
    AND pt.destination_tenant_id IS DISTINCT FROM _tenant_id
  GROUP BY sc.check_id, sc.source_tenant_id
  ORDER BY max(pt.created_at) DESC, sc.check_id, sc.source_tenant_id
  LIMIT 5000;
END;
$$;

REVOKE ALL ON FUNCTION public.get_shared_check_source_sends(uuid) FROM PUBLIC;

DO $sql162_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.get_shared_check_source_sends(uuid) FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql162_revoke$;

GRANT EXECUTE ON FUNCTION public.get_shared_check_source_sends(uuid) TO checksops;
