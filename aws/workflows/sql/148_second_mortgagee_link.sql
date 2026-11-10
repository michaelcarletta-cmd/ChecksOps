-- SQL 148: Send to Mortgage Desk, a 2nd mortgagee: link the two requests and let both be open.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: owner 2026-11-10, "build the second-mortgagee fix". A check made out to two mortgage
-- companies is endorsed by the 1st, then by the 2nd. Send to Mortgage Desk
-- (src/components/loss-draft/SendToMortgageDeskButton.tsx) offers "Add 2nd mortgagee" while the 1st
-- request is open. It inserts the 2nd request (endorsement_order 2, total_mortgagees 2,
-- predecessor_request_id = the 1st; written by the API since #1739) and then UPDATEs the 1st to
-- endorsement_order 1 / total_mortgagees 2. Two things stop that on AWS:
--   a. the UPDATE is refused: SQL 100 records no tenant UPDATE policy on
--      public.mortgage_handling_requests and no UPDATE grant on endorsement_order /
--      total_mortgagees (checksops and authenticated hold UPDATE on other columns only), and the API
--      refuses those columns on update (aws/functions/api/write-check-workflow.mjs
--      MORTGAGE_REQUEST_INSERT_ONLY). The screen ignores the error, so the 1st request is never
--      marked "1 of 2" and the Desk does not see the pair (MortgageOpsRequestDetail reads
--      endorsement_order / total_mortgagees);
--   b. the 2nd INSERT itself fails while the 1st is open: the unique index
--      public.mortgage_handling_requests_one_open_per_check (Supabase migration 20260715110727, carried
--      by the database copy; no later migration drops it) allows one requested / in_progress request
--      per check, so the 2nd request is refused with 23505 and the screen shows "Request already
--      open".
--
-- What this file does:
-- 1) public.mortgage_handling_requests_one_open_per_check is redefined, same name, keyed on the check
--    AND the endorsement order: (check_intake_item_id, COALESCE(endorsement_order, 1)) WHERE status
--    IN ('requested', 'in_progress'). A check still has at most one open request for its 1st
--    mortgagee (an unordered request counts as the 1st, as before) and now at most one for its 2nd.
--    Gates (55000, nothing changed): an index of that name must be absent, the Supabase definition
--    or this file's own; no other valid unique index may key public.mortgage_handling_requests on
--    check_intake_item_id alone (it would keep refusing the 2nd request). When the index is absent,
--    duplicate open requests under the new key are refused first (23505
--    sql148_duplicate_open_requests: <count>), so the CREATE cannot fail half way.
-- 2) public.aws_link_second_mortgagee(_first_request_id uuid, _second_request_id uuid) RETURNS jsonb:
--    new, plpgsql, VOLATILE, SECURITY DEFINER, search_path = public, pg_temp, owned by the applying
--    login. As the verified caller (auth.uid(), set by the API from the Cognito sign-in), in the
--    caller's transaction:
--      a. auth.uid() present, else 42501 mortgagee_link_forbidden;
--      b. both ids present and different, else 22023 mortgagee_link_invalid: request ids;
--      c. both requests locked FOR UPDATE (in id order); each must exist and the caller must be a
--         member of its tenant (public.aws_can_write_tenant, SQL 90: membership only; the platform
--         owner, mortgage agents and other tenants are refused), else P0002
--         mortgagee_link_request_not_found (the same answer for another tenant's request);
--      d. same tenant and same check, else 22023 mortgagee_link_invalid: different check;
--      e. neither request cancelled; the 1st has no predecessor, endorsement_order NULL or 1 and
--         total_mortgagees NULL or 2; the 2nd has endorsement_order NULL or 2, total_mortgagees NULL
--         or 2 and predecessor_request_id NULL or the 1st; else 22023 mortgagee_link_invalid: <what>;
--      f. no other request of the check that is not cancelled already holds the 2nd place (its
--         predecessor is the 1st, or it is order 2 of 2), else 23505 mortgagee_link_conflict;
--      g. sets the 1st to endorsement_order 1 / total_mortgagees 2 and the 2nd to 2 / 2 /
--         predecessor the 1st, each only where it differs (updated_at by the table's own trigger).
--         Idempotent: a repeat changes nothing. Returns {first_request_id, second_request_id,
--         check_intake_item_id, first_changed, second_changed}.
-- 3) EXECUTE: REVOKE ALL FROM PUBLIC, and from anon, authenticated and service_role where those roles
--    exist; GRANT EXECUTE TO checksops (the API login). Only the API's link_second_mortgagee RPC
--    (aws/functions/api/workflow-rpc.mjs SAFE_WRITE_RPCS) calls it.
--
-- Not changed: no table, column, policy, RLS setting, table or column grant, trigger or existing
-- row; no other function or index. Tenants still cannot UPDATE endorsement_order /
-- total_mortgagees / predecessor_request_id directly; the API keeps refusing them on update.
--
-- Refuses to run (55000 sql148_prerequisite_missing) without the table, its columns, the helper
-- functions and the role it uses, and (55000 sql148_definer_cannot_write) unless the applying login
-- owns public.mortgage_handling_requests without FORCE ROW LEVEL SECURITY, or is a superuser or
-- BYPASSRLS: the DEFINER updates rows no tenant policy lets it update, and only the owner may
-- redefine the index.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change: staging first, then production,
-- through the guarded SQL path (AGENTS.md).

DO $sql148_prereq$
DECLARE
  v_missing text[];
  v_unreachable text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.mortgage_handling_requests', pg_catalog.to_regclass('public.mortgage_handling_requests')::oid),
      ('public.aws_can_write_tenant(uuid)', pg_catalog.to_regprocedure('public.aws_can_write_tenant(uuid)')::oid),
      ('auth.uid()', pg_catalog.to_regprocedure('auth.uid()')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.mortgage_handling_requests.' || want.col ORDER BY want.col) INTO v_missing
    FROM unnest(ARRAY[
      'id', 'tenant_id', 'check_intake_item_id', 'status', 'endorsement_order', 'total_mortgagees',
      'predecessor_request_id'
    ]) AS want(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.mortgage_handling_requests')
         AND a.attname = want.col AND a.attnum > 0 AND NOT a.attisdropped);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql148_prerequisite_missing: SQL 148 needs public.mortgage_handling_requests with the two-mortgagee columns and SQL 90 first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT t.oid::regclass::text INTO v_unreachable
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_roles me ON me.rolname = current_user
  WHERE t.oid = pg_catalog.to_regclass('public.mortgage_handling_requests')
    AND NOT (me.rolsuper OR me.rolbypassrls
             OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity));
  IF v_unreachable IS NOT NULL THEN
    RAISE EXCEPTION 'sql148_definer_cannot_write: the login running SQL 148 must own % (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS',
      v_unreachable
      USING ERRCODE = '55000';
  END IF;
END
$sql148_prereq$;

-- 1) One open request per check AND endorsement order ---------------------------------------------

DO $sql148_index$
DECLARE
  c_supabase constant text := 'CREATE UNIQUE INDEX mortgage_handling_requests_one_open_per_check ON public.mortgage_handling_requests USING btree (check_intake_item_id) WHERE (status = ANY (ARRAY[''requested''::text, ''in_progress''::text]))';
  c_sql148 constant text := 'CREATE UNIQUE INDEX mortgage_handling_requests_one_open_per_check ON public.mortgage_handling_requests USING btree (check_intake_item_id, COALESCE(endorsement_order, 1)) WHERE (status = ANY (ARRAY[''requested''::text, ''in_progress''::text]))';
  v_def text;
  v_other text;
  v_dupes integer;
BEGIN
  SELECT pg_catalog.pg_get_indexdef(i.indexrelid) INTO v_def
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'mortgage_handling_requests_one_open_per_check';
  IF v_def IS NOT NULL AND v_def <> c_supabase AND v_def <> c_sql148 THEN
    RAISE EXCEPTION 'sql148_unexpected_index: public.mortgage_handling_requests_one_open_per_check is neither the Supabase definition nor SQL 148''s'
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_other
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = pg_catalog.to_regclass('public.mortgage_handling_requests')
     AND i.indisunique AND i.indisvalid
     AND i.indnkeyatts = 1
     AND i.indexprs IS NULL
     AND i.indkey[0] = (SELECT a.attnum FROM pg_catalog.pg_attribute a
                         WHERE a.attrelid = i.indrelid AND a.attname = 'check_intake_item_id' AND NOT a.attisdropped)
     AND c.relname <> 'mortgage_handling_requests_one_open_per_check';
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'sql148_other_per_check_unique: % would still refuse a 2nd mortgagee', v_other
      USING ERRCODE = '55000';
  END IF;

  IF v_def = c_sql148 THEN
    RAISE NOTICE 'SQL 148: mortgage_handling_requests_one_open_per_check already keyed on the endorsement order';
    RETURN;
  END IF;

  IF v_def IS NULL THEN
    SELECT count(*)::int INTO v_dupes
      FROM (SELECT 1 FROM public.mortgage_handling_requests r
             WHERE r.status IN ('requested', 'in_progress')
             GROUP BY r.check_intake_item_id, COALESCE(r.endorsement_order, 1)
            HAVING count(*) > 1) d;
    IF v_dupes > 0 THEN
      RAISE EXCEPTION 'sql148_duplicate_open_requests: %', v_dupes
        USING ERRCODE = '23505';
    END IF;
  ELSE
    DROP INDEX public.mortgage_handling_requests_one_open_per_check;
  END IF;

  CREATE UNIQUE INDEX mortgage_handling_requests_one_open_per_check
    ON public.mortgage_handling_requests (check_intake_item_id, (COALESCE(endorsement_order, 1)))
    WHERE status IN ('requested', 'in_progress');

  SELECT pg_catalog.pg_get_indexdef(i.indexrelid) INTO v_def
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'mortgage_handling_requests_one_open_per_check' AND i.indisvalid;
  IF v_def IS DISTINCT FROM c_sql148 THEN
    RAISE EXCEPTION 'sql148_index_not_created: public.mortgage_handling_requests_one_open_per_check is not SQL 148''s definition'
      USING ERRCODE = '55000';
  END IF;
END
$sql148_index$;

-- 2) Link the 1st and the 2nd request ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.aws_link_second_mortgagee(
  _first_request_id uuid,
  _second_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_first record;
  v_second record;
  v_found integer := 0;
  v_row record;
  v_first_changed boolean := false;
  v_second_changed boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'mortgagee_link_forbidden'
      USING ERRCODE = '42501';
  END IF;
  IF _first_request_id IS NULL OR _second_request_id IS NULL OR _first_request_id = _second_request_id THEN
    RAISE EXCEPTION 'mortgagee_link_invalid: request ids'
      USING ERRCODE = '22023';
  END IF;

  -- Both rows, locked in id order: links for the same check run one after the other.
  FOR v_row IN
    SELECT r.id, r.tenant_id, r.check_intake_item_id, r.status, r.endorsement_order, r.total_mortgagees,
           r.predecessor_request_id
      FROM public.mortgage_handling_requests r
     WHERE r.id IN (_first_request_id, _second_request_id)
     ORDER BY r.id
       FOR UPDATE
  LOOP
    IF NOT COALESCE(public.aws_can_write_tenant(v_row.tenant_id), false) THEN
      RAISE EXCEPTION 'mortgagee_link_request_not_found'
        USING ERRCODE = 'P0002';
    END IF;
    IF v_row.id = _first_request_id THEN v_first := v_row; ELSE v_second := v_row; END IF;
    v_found := v_found + 1;
  END LOOP;
  IF v_found <> 2 THEN
    RAISE EXCEPTION 'mortgagee_link_request_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_first.tenant_id IS DISTINCT FROM v_second.tenant_id
     OR v_first.check_intake_item_id IS DISTINCT FROM v_second.check_intake_item_id THEN
    RAISE EXCEPTION 'mortgagee_link_invalid: different check'
      USING ERRCODE = '22023';
  END IF;
  IF v_first.status = 'cancelled' OR v_second.status = 'cancelled' THEN
    RAISE EXCEPTION 'mortgagee_link_invalid: cancelled request'
      USING ERRCODE = '22023';
  END IF;
  IF v_first.predecessor_request_id IS NOT NULL
     OR COALESCE(v_first.endorsement_order, 1) <> 1
     OR COALESCE(v_first.total_mortgagees, 2) <> 2 THEN
    RAISE EXCEPTION 'mortgagee_link_invalid: first request order'
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_second.endorsement_order, 2) <> 2
     OR COALESCE(v_second.total_mortgagees, 2) <> 2
     OR COALESCE(v_second.predecessor_request_id, _first_request_id) <> _first_request_id THEN
    RAISE EXCEPTION 'mortgagee_link_invalid: second request order'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.mortgage_handling_requests o
     WHERE o.check_intake_item_id = v_first.check_intake_item_id
       AND o.id NOT IN (_first_request_id, _second_request_id)
       AND o.status <> 'cancelled'
       AND (o.predecessor_request_id = _first_request_id
            OR (o.endorsement_order = 2 AND o.total_mortgagees = 2))
  ) THEN
    RAISE EXCEPTION 'mortgagee_link_conflict'
      USING ERRCODE = '23505';
  END IF;

  IF v_first.endorsement_order IS DISTINCT FROM 1 OR v_first.total_mortgagees IS DISTINCT FROM 2 THEN
    UPDATE public.mortgage_handling_requests
       SET endorsement_order = 1, total_mortgagees = 2
     WHERE id = _first_request_id;
    v_first_changed := true;
  END IF;
  IF v_second.endorsement_order IS DISTINCT FROM 2
     OR v_second.total_mortgagees IS DISTINCT FROM 2
     OR v_second.predecessor_request_id IS DISTINCT FROM _first_request_id THEN
    UPDATE public.mortgage_handling_requests
       SET endorsement_order = 2, total_mortgagees = 2, predecessor_request_id = _first_request_id
     WHERE id = _second_request_id;
    v_second_changed := true;
  END IF;

  RETURN jsonb_build_object(
    'first_request_id', _first_request_id,
    'second_request_id', _second_request_id,
    'check_intake_item_id', v_first.check_intake_item_id,
    'first_changed', v_first_changed,
    'second_changed', v_second_changed);
END;
$$;

-- 3) EXECUTE ------------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.aws_link_second_mortgagee(uuid, uuid) FROM PUBLIC;

DO $sql148_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_link_second_mortgagee(uuid, uuid) FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql148_revoke$;

GRANT EXECUTE ON FUNCTION public.aws_link_second_mortgagee(uuid, uuid) TO checksops;
