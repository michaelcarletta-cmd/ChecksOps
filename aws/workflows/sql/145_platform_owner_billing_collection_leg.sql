-- SQL 145: the platform owner's fee collection records its payment_transfers leg.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: the platform owner (public.is_platform_owner()) collects tenant fees manually from Tenant
-- Management (SQL 98, owner decision 2026-10-17). After Moov accepts a leg, the API
-- (aws/functions/api/tenant-collection-v2.mjs createPostgresCollectionStore putLeg, savepoint
-- collection_insert_leg) inserts the leg's public.payment_transfers row with tenant_id = the billed
-- tenant. Since SQL 90 (applied in production 2026-10-19) no permissive INSERT policy on
-- payment_transfers admits the platform owner for a tenant it is not a member of:
--   aws_write_payment_transfers (aws/rls/sql/24): public.aws_can_write_tenant(tenant_id), which SQL 90
--     reduced to tenant membership (the platform-owner / cross-tenant-reader branch was removed);
--   aws_member_insert_payment_transfers (SQL 72): tenant_id IN (SELECT public.aws_user_tenant_ids()).
-- SQL 136's restrictive aws_money_write_gate_insert_payment_transfers passes (the API sets
-- request.money_write = '1' inside the savepoint), so the permissive policies alone refuse the row.
-- Production evidence (read-only): /aws/lambda/checksops-production-prep-api 2026-11-06T22:53:11Z,
-- billing_pull_statement_failed, statement collection_insert_leg, sqlstate 42501, routine
-- ExecWithCheckOptions, 'new row violates row-level security policy for table "payment_transfers"':
-- Freedom Adjustment's 2026-10 fee, Collect pressed by the platform owner, who is not a member of
-- Freedom. The obligation was marked submitted with the Moov transfer id and the note
-- '· leg_persist_failed · moov_idempotent_replay'; no payment_transfers row was written. Freedom's
-- 2026-09 leg (2026-09-29, before SQL 90) was written by the same insert, under the pre-SQL 90
-- aws_can_write_tenant (aws/rls/sql/20: platform owner allowed).
--
-- Why a function and not a policy: SQL 90's owner policy removes the platform owner's tenant-write
-- branch and keeps platform-owner writes only where a listed duty needs them, and the established
-- pattern for those writes on money tables is a narrow SECURITY DEFINER function (SQL 98's
-- aws_platform_owner_record_billing_audit, SQL 96 / 98 / 102 / 117 / 118's aws_platform_owner_*).
-- A permissive INSERT policy for the platform owner would let its session insert ANY payment_transfers
-- row for any tenant; this function inserts only a fee collection leg of an existing obligation.
--
-- What this file does:
-- 1) public.aws_platform_owner_insert_billing_collection_leg(_tenant_id uuid, _environment text,
--    _status text, _idempotency_key text, _amount_cents bigint, _description text,
--    _source_tenant_account_id text, _wallet_id uuid, _leg_role text, _provider_transfer_id text,
--    _provider_status text, _failure_reason text, _provider_metadata jsonb)
--    RETURNS public.payment_transfers: new, plpgsql, VOLATILE, SECURITY DEFINER,
--    search_path = public, pg_temp, owned by the applying login. The parameters are exactly the
--    values the API's collection_insert_leg statement writes, in its order.
--      a. caller: auth.uid() present and public.is_platform_owner() (the SQL 98 billing actor),
--         else 42501 billing_collection_leg_forbidden;
--      b. a server write path: public.aws_money_write_allowed() (SQL 136's one gate, true once the
--         API's setMoneyWriteFlag ran in this transaction), else 42501
--         billing_collection_leg_not_server_write. RLS does not apply to the owner's insert, so this
--         keeps SQL 136's rule that only a server write path writes a money table;
--      c. the row is a tenant-collection-v2 leg (22023 billing_collection_leg_invalid otherwise):
--         leg_role 'wallet' or 'ach_debit'; provider_metadata an object whose collection_contract is
--         'tenant-collection-v2', leg_type = leg_role and billing_period YYYY-MM; idempotency_key
--         exactly 'billing-<period>-<tenant_id>-wallet' (wallet) or '-bank' (ach_debit)
--         (walletLegIdempotencyKey / bankLegIdempotencyKey); environment production or sandbox;
--         status due, submitted or settled; amount_cents > 0;
--      d. the obligation: provider_metadata.obligation_id is a public.tenant_maintenance_payments row
--         of the same tenant and billing_period (22023 billing_collection_leg_invalid: obligation);
--         amount_cents plus the tenant's other leg for that period (the other idempotency key, unless
--         its status is failed, failure, returned, reversed, canceled or cancelled) is at most the
--         obligation's amount_cents (22023 billing_collection_leg_invalid: amount);
--      e. INSERT the row as the API wrote it (provider 'moov', platform_fee_cents 0,
--         net_amount_cents = amount_cents, speed 'standard', submitted_at now()) with the API's
--         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE of provider_transfer_id,
--         provider_status, status and updated_at, only over an existing row that is the same kind of
--         leg (same leg_role, collection_contract tenant-collection-v2); any other existing row
--         raises 23505 billing_collection_leg_conflict. Returns the row.
-- 2) EXECUTE: REVOKE ALL FROM PUBLIC, and from anon, authenticated and service_role where those roles
--    exist; GRANT EXECUTE TO checksops (the API login). The owner keeps its own. No generic RPC route
--    lists it (aws/functions/api/data.mjs READ_RPCS, workflow-rpc.mjs SAFE_WRITE_RPCS); only
--    tenant-collection-v2.mjs calls it.
--
-- Not changed: no table, column, index, policy, RLS setting, table grant, trigger or row; no other
-- function. A tenant member's own writes (SQL 24 / SQL 72 policies) are unchanged.
--
-- Refuses to run (55000 sql145_prerequisite_missing) without the relations, columns, the unique index
-- the ON CONFLICT names, the helper functions (SQL 136's aws_money_write_allowed() among them: apply
-- SQL 136 first) and the role it uses, and (55000
-- sql145_definer_cannot_write) unless the applying login owns public.payment_transfers and
-- public.tenant_maintenance_payments without FORCE ROW LEVEL SECURITY, or is a superuser or BYPASSRLS:
-- a DEFINER insert filtered by RLS would be refused exactly as today.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql145_prereq$
DECLARE
  v_missing text[];
  v_unreachable text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.payment_transfers', pg_catalog.to_regclass('public.payment_transfers')::oid),
      ('public.payment_transfers_idempotency_uniq', pg_catalog.to_regclass('public.payment_transfers_idempotency_uniq')::oid),
      ('public.tenant_maintenance_payments', pg_catalog.to_regclass('public.tenant_maintenance_payments')::oid),
      ('public.is_platform_owner()', pg_catalog.to_regprocedure('public.is_platform_owner()')::oid),
      ('public.aws_money_write_allowed()', pg_catalog.to_regprocedure('public.aws_money_write_allowed()')::oid),
      ('auth.uid()', pg_catalog.to_regprocedure('auth.uid()')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('payment_transfers', 'id'), ('payment_transfers', 'tenant_id'),
      ('payment_transfers', 'provider'), ('payment_transfers', 'environment'),
      ('payment_transfers', 'status'), ('payment_transfers', 'idempotency_key'),
      ('payment_transfers', 'amount_cents'), ('payment_transfers', 'platform_fee_cents'),
      ('payment_transfers', 'net_amount_cents'), ('payment_transfers', 'speed'),
      ('payment_transfers', 'description'), ('payment_transfers', 'source_tenant_account_id'),
      ('payment_transfers', 'wallet_id'), ('payment_transfers', 'leg_role'),
      ('payment_transfers', 'provider_transfer_id'), ('payment_transfers', 'provider_status'),
      ('payment_transfers', 'failure_reason'), ('payment_transfers', 'provider_metadata'),
      ('payment_transfers', 'submitted_at'), ('payment_transfers', 'updated_at'),
      ('tenant_maintenance_payments', 'id'), ('tenant_maintenance_payments', 'tenant_id'),
      ('tenant_maintenance_payments', 'amount_cents'), ('tenant_maintenance_payments', 'billing_period')) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql145_prerequisite_missing: SQL 145 needs the payment transfer and fee obligation schema first; missing %',
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
    RAISE EXCEPTION 'sql145_definer_cannot_write: the login running SQL 145 must own % (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS',
      v_unreachable
      USING ERRCODE = '55000';
  END IF;
END
$sql145_prereq$;

CREATE OR REPLACE FUNCTION public.aws_platform_owner_insert_billing_collection_leg(
  _tenant_id uuid,
  _environment text,
  _status text,
  _idempotency_key text,
  _amount_cents bigint,
  _description text,
  _source_tenant_account_id text,
  _wallet_id uuid,
  _leg_role text,
  _provider_transfer_id text,
  _provider_status text,
  _failure_reason text,
  _provider_metadata jsonb
)
RETURNS public.payment_transfers
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period text;
  v_suffix text;
  v_other_key text;
  v_obligation text;
  v_due bigint;
  v_other bigint;
  v_row public.payment_transfers%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'billing_collection_leg_forbidden'
      USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(public.aws_money_write_allowed(), false) THEN
    RAISE EXCEPTION 'billing_collection_leg_not_server_write'
      USING ERRCODE = '42501';
  END IF;

  IF _tenant_id IS NULL OR _leg_role IS NULL OR _leg_role NOT IN ('wallet', 'ach_debit') THEN
    RAISE EXCEPTION 'billing_collection_leg_invalid: leg_role'
      USING ERRCODE = '22023';
  END IF;
  v_suffix := CASE _leg_role WHEN 'wallet' THEN 'wallet' ELSE 'bank' END;
  v_period := CASE WHEN jsonb_typeof(_provider_metadata) = 'object' THEN _provider_metadata ->> 'billing_period' END;
  IF v_period IS NULL OR v_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     OR (_provider_metadata ->> 'collection_contract') IS DISTINCT FROM 'tenant-collection-v2'
     OR (_provider_metadata ->> 'leg_type') IS DISTINCT FROM _leg_role
     OR _idempotency_key IS DISTINCT FROM ('billing-' || v_period || '-' || _tenant_id::text || '-' || v_suffix) THEN
    RAISE EXCEPTION 'billing_collection_leg_invalid: key'
      USING ERRCODE = '22023';
  END IF;
  IF _environment IS NULL OR _environment NOT IN ('production', 'sandbox')
     OR _status IS NULL OR _status NOT IN ('due', 'submitted', 'settled')
     OR _amount_cents IS NULL OR _amount_cents <= 0 THEN
    RAISE EXCEPTION 'billing_collection_leg_invalid: row'
      USING ERRCODE = '22023';
  END IF;

  v_obligation := _provider_metadata ->> 'obligation_id';
  IF v_obligation IS NULL OR v_obligation !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'billing_collection_leg_invalid: obligation'
      USING ERRCODE = '22023';
  END IF;
  SELECT tmp.amount_cents INTO v_due
    FROM public.tenant_maintenance_payments tmp
   WHERE tmp.id = v_obligation::uuid
     AND tmp.tenant_id = _tenant_id
     AND tmp.billing_period = v_period;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_collection_leg_invalid: obligation'
      USING ERRCODE = '22023';
  END IF;

  v_other_key := 'billing-' || v_period || '-' || _tenant_id::text || '-'
    || CASE v_suffix WHEN 'wallet' THEN 'bank' ELSE 'wallet' END;
  SELECT COALESCE(sum(pt.amount_cents), 0) INTO v_other
    FROM public.payment_transfers pt
   WHERE pt.tenant_id = _tenant_id
     AND pt.idempotency_key = v_other_key
     AND lower(COALESCE(pt.status, '')) NOT IN ('failed', 'failure', 'returned', 'reversed', 'canceled', 'cancelled');
  IF v_due IS NULL OR _amount_cents + v_other > v_due THEN
    RAISE EXCEPTION 'billing_collection_leg_invalid: amount'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payment_transfers AS pt
    (tenant_id, provider, environment, status, idempotency_key, amount_cents,
     platform_fee_cents, net_amount_cents, speed, description,
     source_tenant_account_id, wallet_id, leg_role, provider_transfer_id,
     provider_status, failure_reason, provider_metadata, submitted_at)
  VALUES (_tenant_id, 'moov', _environment, _status, _idempotency_key, _amount_cents,
          0, _amount_cents, 'standard', _description,
          _source_tenant_account_id, _wallet_id, _leg_role, _provider_transfer_id,
          _provider_status, _failure_reason, _provider_metadata, now())
  ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
    provider_transfer_id = COALESCE(EXCLUDED.provider_transfer_id, pt.provider_transfer_id),
    provider_status = COALESCE(EXCLUDED.provider_status, pt.provider_status),
    status = EXCLUDED.status,
    updated_at = now()
  WHERE pt.leg_role = EXCLUDED.leg_role
    AND (pt.provider_metadata ->> 'collection_contract') = 'tenant-collection-v2'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_collection_leg_conflict'
      USING ERRCODE = '23505';
  END IF;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.aws_platform_owner_insert_billing_collection_leg(uuid, text, text, text, bigint, text, text, uuid, text, text, text, text, jsonb) FROM PUBLIC;

DO $sql145_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_platform_owner_insert_billing_collection_leg(uuid, text, text, text, bigint, text, text, uuid, text, text, text, text, jsonb) FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql145_revoke$;

GRANT EXECUTE ON FUNCTION public.aws_platform_owner_insert_billing_collection_leg(uuid, text, text, text, bigint, text, text, uuid, text, text, text, text, jsonb) TO checksops;
