-- SQL 144: an organization reads the payments other organizations sent into its wallet.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: a send from the Funds tab (aws/functions/api/providers/production/moov-send.mjs) writes its
-- payment_transfers legs (leg_role send_wallet / send_bank) under the SENDER's tenant_id, with
-- destination_tenant_id = the partner organization it pays. The AWS select policy
-- aws_select_payment_transfers (aws/rls/sql/12_final_select_policies.sql) lets a member read only
-- rows whose tenant_id is their own; the Supabase-era policy "Members read own tenant transfers"
-- (supabase migration 20260727224957) also let the payee organization read inbound rows, and that
-- clause was not carried over. Nothing is written under the recipient's tenant_id (no transfer,
-- split, ledger or claim payment row), so money a partner receives shows nowhere for it: not in
-- Recent Wallet Activity, Funds Received or Payments & Financials. Read-only production facts
-- 2026-11-06 (owner-approved read): Freedom Adjustment's send of 2026-11-06T19:06:01Z to Condition
-- One (check a15dfd40) is two legs, both tenant_id Freedom, destination_tenant_id Condition One,
-- status submitted; nothing exists under Condition One's tenant_id. Owner 2026-11-06: "yes build
-- it, include partner payments as income not tax."
--
-- What this file does:
-- 1) public.get_tenant_incoming_transfers(_tenant_id uuid): new, plpgsql, STABLE, SECURITY DEFINER,
--    search_path = public, pg_temp, owned by the applying login. A narrow read instead of a select
--    policy, so the recipient never sees the sender's row (provider_metadata carries the sender's
--    step-up id, facilitator, source payment methods and request hash):
--      a. caller gate: _tenant_id present and public.aws_can_access_tenant(_tenant_id) (a member of
--         that organization or a cross-tenant reader, the rule the API's RPC gate applies), else
--         42501 incoming_transfers_forbidden;
--      b. rows: public.payment_transfers where destination_tenant_id = _tenant_id, tenant_id <>
--         _tenant_id, leg_role send_wallet or send_bank and status submitted, pending, processing,
--         completed or returned (returned is listed so a bounced payment shows as returned; drafts,
--         ready, submitting, unknown, failed and canceled legs never reached the recipient);
--         newest first, at most 1000;
--      c. columns: the transfer's id, amount_cents, status, speed, environment, leg_role, created_at,
--         submitted_at, completed_at and check_id, the sender's tenant id and name (public.tenants);
--         never provider_metadata, description, payment method, wallet, idempotency or provider ids;
--      d. check context (number, carrier, property address, funds type, check amount, claim id,
--         detected claim number, payee line, claim number, policyholder name) only when the check is
--         shared with _tenant_id by the sender (public.shared_checks: check_id, source_tenant_id =
--         the sender, target_tenant_id = _tenant_id, revoked_at IS NULL) or the caller is the
--         platform owner (public.is_platform_owner()); otherwise those columns are NULL. check_id
--         itself is returned: the recipient needs it to group the payment, and it reveals nothing
--         the check's sender has not addressed to the recipient.
-- 2) EXECUTE: REVOKE ALL FROM PUBLIC, and from anon, authenticated and service_role where those roles
--    exist; GRANT EXECUTE TO checksops (the API login, aws/functions/api/data.mjs READ_RPCS with the
--    tenant gate). The owner keeps its own. The ACL is checksops and the owner, as SQL 126 leaves the
--    Supabase-era definer reads.
--
-- Not changed: no table, column, policy, RLS setting, table grant, trigger or row; no other function
-- (get_tenant_funds_received keeps its body and ACL). The sender's own reads are unchanged.
--
-- Refuses to run (55000 sql144_prerequisite_missing) without the relations, columns, helper functions
-- and role it uses, and (55000 sql144_definer_cannot_reach) unless the applying login owns the five
-- relations it reads (payment_transfers, tenants, shared_checks, check_intake_items, claims) without
-- FORCE ROW LEVEL SECURITY, or is a superuser or BYPASSRLS: a DEFINER read filtered by RLS would show
-- the recipient nothing.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql144_prereq$
DECLARE
  v_missing text[];
  v_unreachable text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.payment_transfers', pg_catalog.to_regclass('public.payment_transfers')::oid),
      ('public.tenants', pg_catalog.to_regclass('public.tenants')::oid),
      ('public.shared_checks', pg_catalog.to_regclass('public.shared_checks')::oid),
      ('public.check_intake_items', pg_catalog.to_regclass('public.check_intake_items')::oid),
      ('public.claims', pg_catalog.to_regclass('public.claims')::oid),
      ('public.aws_can_access_tenant(uuid)', pg_catalog.to_regprocedure('public.aws_can_access_tenant(uuid)')::oid),
      ('public.is_platform_owner()', pg_catalog.to_regprocedure('public.is_platform_owner()')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('payment_transfers', 'id'), ('payment_transfers', 'tenant_id'),
      ('payment_transfers', 'destination_tenant_id'), ('payment_transfers', 'leg_role'),
      ('payment_transfers', 'status'), ('payment_transfers', 'amount_cents'),
      ('payment_transfers', 'speed'), ('payment_transfers', 'environment'),
      ('payment_transfers', 'check_id'), ('payment_transfers', 'created_at'),
      ('payment_transfers', 'submitted_at'), ('payment_transfers', 'completed_at'),
      ('tenants', 'id'), ('tenants', 'name'),
      ('shared_checks', 'check_id'), ('shared_checks', 'source_tenant_id'),
      ('shared_checks', 'target_tenant_id'), ('shared_checks', 'revoked_at'),
      ('check_intake_items', 'id'), ('check_intake_items', 'check_number'),
      ('check_intake_items', 'carrier_name'), ('check_intake_items', 'property_address'),
      ('check_intake_items', 'funds_type'), ('check_intake_items', 'amount'),
      ('check_intake_items', 'claim_id'), ('check_intake_items', 'detected_claim_number'),
      ('check_intake_items', 'payee_line'),
      ('claims', 'id'), ('claims', 'claim_number'), ('claims', 'policyholder_name')) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql144_prerequisite_missing: SQL 144 needs the payment transfer, tenant, check sharing and check schema first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(t.oid::regclass::text, ', ' ORDER BY t.oid::regclass::text) INTO v_unreachable
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_roles me ON me.rolname = current_user
  WHERE t.oid IN (pg_catalog.to_regclass('public.payment_transfers'), pg_catalog.to_regclass('public.tenants'),
                  pg_catalog.to_regclass('public.shared_checks'), pg_catalog.to_regclass('public.check_intake_items'),
                  pg_catalog.to_regclass('public.claims'))
    AND NOT (me.rolsuper OR me.rolbypassrls
             OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity));
  IF v_unreachable IS NOT NULL THEN
    RAISE EXCEPTION 'sql144_definer_cannot_reach: the login running SQL 144 must own % (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS',
      v_unreachable
      USING ERRCODE = '55000';
  END IF;
END
$sql144_prereq$;

CREATE OR REPLACE FUNCTION public.get_tenant_incoming_transfers(_tenant_id uuid)
RETURNS TABLE(
  id uuid,
  amount_cents bigint,
  status text,
  speed text,
  environment text,
  leg_role text,
  created_at timestamp with time zone,
  submitted_at timestamp with time zone,
  completed_at timestamp with time zone,
  check_id uuid,
  sender_tenant_id uuid,
  sender_name text,
  check_number text,
  carrier_name text,
  property_address text,
  funds_type text,
  check_amount numeric,
  claim_id uuid,
  detected_claim_number text,
  payee_line text,
  claim_number text,
  policyholder_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner boolean;
BEGIN
  IF _tenant_id IS NULL OR NOT COALESCE(public.aws_can_access_tenant(_tenant_id), false) THEN
    RAISE EXCEPTION 'incoming_transfers_forbidden'
      USING ERRCODE = '42501';
  END IF;
  v_owner := COALESCE(public.is_platform_owner(), false);

  RETURN QUERY
  SELECT
    pt.id,
    pt.amount_cents::bigint,
    pt.status::text,
    pt.speed::text,
    pt.environment::text,
    pt.leg_role::text,
    pt.created_at,
    pt.submitted_at,
    pt.completed_at,
    pt.check_id,
    pt.tenant_id,
    sender.name::text,
    CASE WHEN visible.ok THEN cii.check_number::text END,
    CASE WHEN visible.ok THEN cii.carrier_name::text END,
    CASE WHEN visible.ok THEN cii.property_address::text END,
    CASE WHEN visible.ok THEN cii.funds_type::text END,
    CASE WHEN visible.ok THEN cii.amount::numeric END,
    CASE WHEN visible.ok THEN cii.claim_id END,
    CASE WHEN visible.ok THEN cii.detected_claim_number::text END,
    CASE WHEN visible.ok THEN cii.payee_line::text END,
    CASE WHEN visible.ok THEN cl.claim_number::text END,
    CASE WHEN visible.ok THEN cl.policyholder_name::text END
  FROM public.payment_transfers pt
  LEFT JOIN public.tenants sender ON sender.id = pt.tenant_id
  LEFT JOIN public.check_intake_items cii ON cii.id = pt.check_id
  LEFT JOIN public.claims cl ON cl.id = cii.claim_id
  CROSS JOIN LATERAL (
    SELECT pt.check_id IS NOT NULL AND (
      v_owner
      OR EXISTS (
        SELECT 1
          FROM public.shared_checks sc
         WHERE sc.check_id = pt.check_id
           AND sc.source_tenant_id = pt.tenant_id
           AND sc.target_tenant_id = _tenant_id
           AND sc.revoked_at IS NULL
      )
    ) AS ok
  ) AS visible
  WHERE pt.destination_tenant_id = _tenant_id
    AND pt.tenant_id <> _tenant_id
    AND pt.leg_role IN ('send_wallet', 'send_bank')
    AND pt.status IN ('submitted', 'pending', 'processing', 'completed', 'returned')
  ORDER BY pt.created_at DESC, pt.id
  LIMIT 1000;
END;
$$;

REVOKE ALL ON FUNCTION public.get_tenant_incoming_transfers(uuid) FROM PUBLIC;

DO $sql144_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.get_tenant_incoming_transfers(uuid) FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql144_revoke$;

GRANT EXECUTE ON FUNCTION public.get_tenant_incoming_transfers(uuid) TO checksops;
