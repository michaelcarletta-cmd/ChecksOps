-- SQL 146: the Moov status catch-up locks its rows and writes a fee collection leg's Moov status.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: the Moov status catch-up (aws/functions/api/providers/moov-status-catch-up.mjs) runs as one
-- reviewed platform-owner actor (request.app_user_id, public.is_platform_owner()), because the
-- payment tables are under row security and a webhook has no user. Its plan reads the candidate
-- rows through the SELECT policies, which admit the platform owner (aws_select_payment_transfers,
-- aws_select_tenant_maintenance_payments: public.aws_is_cross_tenant_reader()). Its apply then,
-- per Moov transfer, in one transaction:
--   a. locks the rows the plan read: SELECT ... FROM public.payment_transfers ... FOR UPDATE and
--      SELECT ... FROM public.tenant_maintenance_payments ... FOR UPDATE. PostgreSQL applies the
--      UPDATE policies' USING clause to SELECT FOR UPDATE / FOR SHARE and drops the rows it refuses.
--      payment_transfers' permissive UPDATE policies are membership-only since SQL 90 (applied in
--      production 2026-10-19): aws_write_payment_transfers (aws/rls/sql/24) is
--      public.aws_can_write_tenant(tenant_id), which SQL 90 reduced to tenant membership, and SQL 72's
--      aws_member_update_payment_transfers asks for the server's financial execution GUCs and
--      membership. The platform owner is not a member of the tenants, so the lock returns no row;
--      tenant_maintenance_payments' rows are dropped by SQL 136's restrictive UPDATE gate
--      (public.aws_money_write_allowed(), no server write flag set yet). Production 2026-11-07, run
--      42395949680 (production-moov-status-catch-up.yml, phase apply): the re-plan matched the reviewed
--      manifest 236f3dd28e0e108219f75e566acbac4bb60a80ddfb8e673b1df0c6422c8b2331, then the first
--      transfer refused with catch_up_state_changed_since_plan, found {legs: {}, obligations: {}},
--      rolled back; nothing was written. Reproduced on PostgreSQL 16 with these policies
--      (aws/tests/sql146-moov-status-catch-up-writes-pg.test.mjs);
--   b. writes a tenant fee collection leg's status (applyBillingProviderEvent in
--      tenant-collection-v2-settlement.mjs: UPDATE public.payment_transfers SET status = ...). For the
--      platform owner the same UPDATE policies leave that UPDATE with no row and no error, so the leg
--      would stay submitted and the obligation could not settle from it. The catch-up now writes the
--      leg through function 2 below before it runs the settlement code (whose own UPDATE then finds no
--      row, as before, and changes nothing);
--   c. appends the settlement's payment_event_log row. The INSERT policies there are a member's
--      (SQL 72), the onboarding writer's (SQL 91) and the Moov webhook apply context's
--      (SQL 91 aws_webhook_insert_payment_event_log, request.provider_webhook_apply = '1'); the
--      catch-up now runs the settlement in that context, as the webhook writer does (no change here).
-- The SQL 109 writer the catch-up calls for funding and send legs is already SECURITY DEFINER and
-- is not changed.
--
-- Why functions and not policies: an UPDATE policy for the platform owner would let its session
-- update ANY payment_transfers row of any tenant. SQL 90 keeps platform-owner writes only where a
-- listed duty needs them, through narrow SECURITY DEFINER functions (SQL 98, 102, 117, 118, 145).
--
-- What this file does:
-- 1) public.aws_moov_catch_up_lock_rows(_environment text, _provider_transfer_id text,
--    _obligation_ids uuid[]) RETURNS jsonb: new, plpgsql, VOLATILE, SECURITY DEFINER,
--    search_path = public, pg_temp, owned by the applying login.
--      a. caller: the Moov webhook apply context (public.aws_moov_webhook_apply_active(), SQL 91: only
--         server code sets request.provider_webhook_apply) else 42501 moov_catch_up_webhook_apply_required;
--         and auth.uid() present and public.is_platform_owner() else 42501 moov_catch_up_forbidden;
--      b. inputs: environment production or sandbox, a transfer id, at most 50 obligation ids
--         (22023 moov_catch_up_invalid otherwise);
--      c. locks, in id order, FOR UPDATE: the public.payment_transfers rows with provider 'moov', that
--         environment and that provider_transfer_id, and the public.tenant_maintenance_payments rows
--         with those ids. Returns {"legs": {id: status}, "obligations": {id: status}} (the catch-up's
--         pre-state check). Reads no other column and writes nothing.
-- 2) public.aws_moov_apply_collection_leg_status(_environment text, _provider_transfer_id text,
--    _amount_cents bigint, _status text, _provider_status text, _reason text, _completed_at timestamptz)
--    RETURNS jsonb: new, plpgsql, VOLATILE, SECURITY DEFINER, search_path = public, pg_temp.
--      a. caller: the Moov webhook apply context else 42501 moov_collection_leg_webhook_apply_required;
--         with a signed-in user, only the platform owner (a member, or anyone else, 42501
--         moov_collection_leg_forbidden); with no user (the webhook route) the context alone;
--      b. inputs: environment production or sandbox, a transfer id, _amount_cents > 0 (Moov's confirmed
--         amount), _status settled, failed or returned (mapProviderStatusToBilling's three) (22023
--         moov_collection_leg_invalid otherwise);
--      c. the one public.payment_transfers row with provider 'moov', that environment and that
--         provider_transfer_id (unique by payment_transfers_provider_id_uniq), locked FOR UPDATE:
--         none: outcome unknown_transfer; a SQL 109 leg (wallet_funding, send_wallet, send_bank) or a
--         row whose provider_metadata is not a tenant-collection-v2 leg (collection_contract
--         'tenant-collection-v2' or checksops_kind 'monthly_subscription', isCollectionV2Leg):
--         not_owned; amount_cents other than _amount_cents: amount_mismatch. None of these writes;
--      d. never backwards (SQL 109's rule): ranks submitted 1, pending / processing 2, settled /
--         completed 3, failed / canceled / cancelled 4, returned / reversed 5, anything else 0; the
--         status moves only to a higher rank (applied), an equal status is unchanged, anything else
--         stale;
--      e. on applied, exactly applyBillingProviderEvent's leg UPDATE: status, provider_status (the
--         lower-cased Moov status), completed_at (settled only, kept when set), failure_reason (failed /
--         returned: _reason, kept when NULL), updated_at. No other column, no other row, no event row
--         (the settlement code appends it), no money movement.
--    Returns {transfer_id, tenant_id, leg_role, previous_status, new_status, outcome}.
-- 3) EXECUTE on both: REVOKE ALL FROM PUBLIC, and from anon, authenticated and service_role where those
--    roles exist; GRANT EXECUTE TO checksops (the API login). The owner keeps its own. No generic RPC
--    route lists them (aws/functions/api/data.mjs READ_RPCS, workflow-rpc.mjs SAFE_WRITE_RPCS); only
--    moov-status-catch-up.mjs calls them.
--
-- Not changed: no table, column, index, policy, RLS setting, table grant, trigger or row; no other
-- function (SQL 109's writer included). A tenant member's own writes are unchanged.
--
-- Refuses to run (55000 sql146_prerequisite_missing) without the relations, columns, helper functions
-- and the role it uses, and (55000 sql146_definer_cannot_write) unless the applying login owns
-- public.payment_transfers and public.tenant_maintenance_payments without FORCE ROW LEVEL SECURITY, or
-- is a superuser or BYPASSRLS: a DEFINER lock or update filtered by RLS would find no row, as today.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql146_prereq$
DECLARE
  v_missing text[];
  v_unreachable text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.payment_transfers', pg_catalog.to_regclass('public.payment_transfers')::oid),
      ('public.tenant_maintenance_payments', pg_catalog.to_regclass('public.tenant_maintenance_payments')::oid),
      ('public.is_platform_owner()', pg_catalog.to_regprocedure('public.is_platform_owner()')::oid),
      ('public.aws_moov_webhook_apply_active()', pg_catalog.to_regprocedure('public.aws_moov_webhook_apply_active()')::oid),
      ('auth.uid()', pg_catalog.to_regprocedure('auth.uid()')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('payment_transfers', 'id'), ('payment_transfers', 'tenant_id'),
      ('payment_transfers', 'provider'), ('payment_transfers', 'environment'),
      ('payment_transfers', 'provider_transfer_id'), ('payment_transfers', 'provider_status'),
      ('payment_transfers', 'status'), ('payment_transfers', 'leg_role'),
      ('payment_transfers', 'amount_cents'), ('payment_transfers', 'failure_reason'),
      ('payment_transfers', 'provider_metadata'), ('payment_transfers', 'completed_at'),
      ('payment_transfers', 'updated_at'),
      ('tenant_maintenance_payments', 'id'), ('tenant_maintenance_payments', 'status')) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql146_prerequisite_missing: SQL 146 needs the payment transfer and fee obligation schema and SQL 91 first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(t.oid::regclass::text, ', ' ORDER BY t.oid::regclass::text) INTO v_unreachable
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_roles me ON me.rolname = current_user
  WHERE t.oid IN (pg_catalog.to_regclass('public.payment_transfers'), pg_catalog.to_regclass('public.tenant_maintenance_payments'))
    AND NOT (me.rolsuper OR me.rolbypassrls
             OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity));
  IF v_unreachable IS NOT NULL THEN
    RAISE EXCEPTION 'sql146_definer_cannot_write: the login running SQL 146 must own % (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS',
      v_unreachable
      USING ERRCODE = '55000';
  END IF;
END
$sql146_prereq$;

CREATE OR REPLACE FUNCTION public.aws_moov_catch_up_lock_rows(
  _environment text,
  _provider_transfer_id text,
  _obligation_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids uuid[] := COALESCE(_obligation_ids, ARRAY[]::uuid[]);
  v_legs jsonb;
  v_obligations jsonb;
BEGIN
  IF NOT COALESCE(public.aws_moov_webhook_apply_active(), false) THEN
    RAISE EXCEPTION 'moov_catch_up_webhook_apply_required'
      USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'moov_catch_up_forbidden'
      USING ERRCODE = '42501';
  END IF;
  IF _environment IS NULL OR _environment NOT IN ('production', 'sandbox')
     OR btrim(COALESCE(_provider_transfer_id, '')) = ''
     OR COALESCE(cardinality(v_ids), 0) > 50 THEN
    RAISE EXCEPTION 'moov_catch_up_invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
     FROM public.payment_transfers t
    WHERE t.provider = 'moov'
      AND t.environment = _environment
      AND t.provider_transfer_id = btrim(_provider_transfer_id)
    ORDER BY t.id
      FOR UPDATE;
  SELECT jsonb_object_agg(t.id::text, t.status) INTO v_legs
    FROM public.payment_transfers t
   WHERE t.provider = 'moov'
     AND t.environment = _environment
     AND t.provider_transfer_id = btrim(_provider_transfer_id);

  PERFORM 1
     FROM public.tenant_maintenance_payments o
    WHERE o.id = ANY (v_ids)
    ORDER BY o.id
      FOR UPDATE;
  SELECT jsonb_object_agg(o.id::text, o.status) INTO v_obligations
    FROM public.tenant_maintenance_payments o
   WHERE o.id = ANY (v_ids);

  RETURN jsonb_build_object('legs', COALESCE(v_legs, '{}'::jsonb), 'obligations', COALESCE(v_obligations, '{}'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.aws_moov_apply_collection_leg_status(
  _environment text,
  _provider_transfer_id text,
  _amount_cents bigint,
  _status text,
  _provider_status text,
  _reason text,
  _completed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.payment_transfers%ROWTYPE;
  v_old_rank integer;
  v_new_rank integer;
  v_outcome text;
  v_provider_status text := NULLIF(left(lower(btrim(COALESCE(_provider_status, ''))), 40), '');
BEGIN
  IF NOT COALESCE(public.aws_moov_webhook_apply_active(), false) THEN
    RAISE EXCEPTION 'moov_collection_leg_webhook_apply_required'
      USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'moov_collection_leg_forbidden'
      USING ERRCODE = '42501';
  END IF;
  IF _environment IS NULL OR _environment NOT IN ('production', 'sandbox')
     OR btrim(COALESCE(_provider_transfer_id, '')) = ''
     OR _amount_cents IS NULL OR _amount_cents <= 0
     OR _status IS NULL OR _status NOT IN ('settled', 'failed', 'returned') THEN
    RAISE EXCEPTION 'moov_collection_leg_invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT t.* INTO v_row
    FROM public.payment_transfers t
   WHERE t.provider = 'moov'
     AND t.environment = _environment
     AND t.provider_transfer_id = btrim(_provider_transfer_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'unknown_transfer');
  END IF;
  IF COALESCE(v_row.leg_role, '') IN ('wallet_funding', 'send_wallet', 'send_bank')
     OR NOT (COALESCE(v_row.provider_metadata ->> 'collection_contract', '') = 'tenant-collection-v2'
             OR COALESCE(v_row.provider_metadata ->> 'checksops_kind', '') = 'monthly_subscription') THEN
    RETURN jsonb_build_object('transfer_id', v_row.id, 'tenant_id', v_row.tenant_id, 'leg_role', v_row.leg_role,
      'previous_status', v_row.status, 'new_status', v_row.status, 'outcome', 'not_owned');
  END IF;
  IF v_row.amount_cents IS DISTINCT FROM _amount_cents THEN
    RETURN jsonb_build_object('transfer_id', v_row.id, 'tenant_id', v_row.tenant_id, 'leg_role', v_row.leg_role,
      'previous_status', v_row.status, 'new_status', v_row.status, 'outcome', 'amount_mismatch');
  END IF;

  v_old_rank := CASE lower(COALESCE(v_row.status, ''))
    WHEN 'submitted' THEN 1
    WHEN 'pending' THEN 2 WHEN 'processing' THEN 2
    WHEN 'settled' THEN 3 WHEN 'completed' THEN 3
    WHEN 'failed' THEN 4 WHEN 'canceled' THEN 4 WHEN 'cancelled' THEN 4
    WHEN 'returned' THEN 5 WHEN 'reversed' THEN 5
    ELSE 0 END;
  v_new_rank := CASE _status WHEN 'settled' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END;
  IF v_new_rank > v_old_rank THEN
    v_outcome := 'applied';
  ELSIF v_row.status = _status THEN
    v_outcome := 'unchanged';
  ELSE
    v_outcome := 'stale';
  END IF;

  IF v_outcome = 'applied' THEN
    UPDATE public.payment_transfers t
       SET status = _status,
           provider_status = v_provider_status,
           completed_at = CASE WHEN _status = 'settled' THEN COALESCE(t.completed_at, _completed_at, now()) ELSE t.completed_at END,
           failure_reason = CASE WHEN _status IN ('failed', 'returned')
                                 THEN COALESCE(NULLIF(left(btrim(COALESCE(_reason, '')), 500), ''), t.failure_reason)
                                 ELSE t.failure_reason END,
           updated_at = now()
     WHERE t.id = v_row.id;
  END IF;

  RETURN jsonb_build_object('transfer_id', v_row.id, 'tenant_id', v_row.tenant_id, 'leg_role', v_row.leg_role,
    'previous_status', v_row.status, 'new_status', CASE WHEN v_outcome = 'applied' THEN _status ELSE v_row.status END,
    'outcome', v_outcome);
END;
$$;

REVOKE ALL ON FUNCTION public.aws_moov_catch_up_lock_rows(text, text, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_moov_apply_collection_leg_status(text, text, bigint, text, text, text, timestamptz) FROM PUBLIC;

DO $sql146_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_moov_catch_up_lock_rows(text, text, uuid[]) FROM %I', v_role);
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_moov_apply_collection_leg_status(text, text, bigint, text, text, text, timestamptz) FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql146_revoke$;

GRANT EXECUTE ON FUNCTION public.aws_moov_catch_up_lock_rows(text, text, uuid[]) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_moov_apply_collection_leg_status(text, text, bigint, text, text, text, timestamptz) TO checksops;
