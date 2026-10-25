-- SQL 115: the payment-account stakeholder sync keeps one partner-payout account per tenant.
--
-- Why: public.sync_provider_stakeholder_account(uuid) (supabase migration
-- 20260728110453, restored onto the AWS databases) runs after every INSERT or UPDATE of
-- public.payment_provider_accounts and public.payment_provider_methods
-- (trg_sync_provider_stakeholder_acct, trg_sync_provider_stakeholder_bank). It takes the
-- tenant's most recently updated receiving account and keeps one stakeholder_accounts row
-- (origin 'provider_connected', is_partner_payout, is_active) for that account's provider and
-- environment, inserting one when none exists. It assumed one payment account per tenant.
-- A tenant may hold one Moov account per environment (payment_provider_accounts is unique on
-- tenant_id, provider, environment): on staging a company with a production-labelled account
-- that sets up its sandbox test account gets a second row. The first receiving update of the
-- sandbox row then finds no stakeholder for 'sandbox' and inserts a second active partner
-- payout, which stakeholder_accounts_one_partner_payout (one active partner payout per tenant)
-- refuses with 23505. The trigger error rolls back the whole statement, so
-- moov-sync (Settings > Compliance & Docs > Refresh) can never record the sandbox account's
-- status (seen on staging 2026-10-25 for tenant 2eff5f1a, route /functions/v1/moov-sync:
-- duplicate key value violates unique constraint "stakeholder_accounts_one_partner_payout").
--
-- 1) public.sync_provider_stakeholder_account(uuid) replaced with the same signature,
--    language, result, volatility, SECURITY DEFINER and search_path. Only two things change:
--      a. When no stakeholder row exists for the account's provider and environment and the
--         tenant already has an active partner payout (another environment's), nothing is
--         inserted and that row's id is returned unchanged.
--      b. An existing row for the account's provider and environment is re-activated only
--         when no other active partner payout exists for the tenant; otherwise it keeps its
--         is_active (its other columns are refreshed as before).
--    A tenant with one payment account (every production tenant) behaves exactly as before.
-- 2) EXECUTE: revoked from PUBLIC and from anon, authenticated and service_role where those
--    roles exist; no grant. The function is called only by the SECURITY DEFINER trigger
--    function public.trg_sync_provider_stakeholder_account() and the SECURITY DEFINER
--    public.add_partner_stakeholder_to_check(uuid, uuid), both as the owner; a direct caller
--    could otherwise write a partner payout for any tenant id.
--
-- Not changed: the trigger function, the triggers, the unique index, any policy, table, column
-- or row. Rows are written only when a later payment account change fires the trigger.
-- Refuses to run (55000 sql115_prerequisite_missing) without the function, the tables and
-- columns it uses.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql115_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.sync_provider_stakeholder_account(uuid)', to_regprocedure('public.sync_provider_stakeholder_account(uuid)')::oid),
      ('public.payment_provider_accounts', to_regclass('public.payment_provider_accounts')::oid),
      ('public.payment_provider_methods', to_regclass('public.payment_provider_methods')::oid),
      ('public.stakeholder_accounts', to_regclass('public.stakeholder_accounts')::oid),
      ('public.tenants', to_regclass('public.tenants')::oid),
      ('public.tenant_users', to_regclass('public.tenant_users')::oid)
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (
      VALUES
        ('payment_provider_accounts', 'tenant_id'), ('payment_provider_accounts', 'provider'),
        ('payment_provider_accounts', 'environment'), ('payment_provider_accounts', 'provider_account_id'),
        ('payment_provider_accounts', 'display_name'), ('payment_provider_accounts', 'can_receive_payments'),
        ('payment_provider_accounts', 'disabled'), ('payment_provider_accounts', 'updated_at'),
        ('payment_provider_methods', 'tenant_id'), ('payment_provider_methods', 'provider'),
        ('payment_provider_methods', 'environment'), ('payment_provider_methods', 'external_recipient_id'),
        ('payment_provider_methods', 'can_receive'), ('payment_provider_methods', 'is_default'),
        ('payment_provider_methods', 'connected_at'), ('payment_provider_methods', 'provider_bank_account_id'),
        ('payment_provider_methods', 'bank_name'), ('payment_provider_methods', 'last_four'),
        ('stakeholder_accounts', 'id'), ('stakeholder_accounts', 'tenant_id'),
        ('stakeholder_accounts', 'created_by'), ('stakeholder_accounts', 'nickname'),
        ('stakeholder_accounts', 'account_type'), ('stakeholder_accounts', 'custname'),
        ('stakeholder_accounts', 'origin'), ('stakeholder_accounts', 'is_partner_payout'),
        ('stakeholder_accounts', 'is_active'), ('stakeholder_accounts', 'verification_status'),
        ('stakeholder_accounts', 'verification_source'), ('stakeholder_accounts', 'verified_at'),
        ('stakeholder_accounts', 'provider'), ('stakeholder_accounts', 'provider_environment'),
        ('stakeholder_accounts', 'provider_account_id'), ('stakeholder_accounts', 'provider_bank_account_id'),
        ('stakeholder_accounts', 'provider_bank_name'), ('stakeholder_accounts', 'provider_last_four'),
        ('stakeholder_accounts', 'updated_at'),
        ('tenants', 'id'), ('tenants', 'name'),
        ('tenant_users', 'tenant_id'), ('tenant_users', 'user_id'), ('tenant_users', 'created_at')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql115_prerequisite_missing: SQL 115 needs %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$sql115_prereq$;

CREATE OR REPLACE FUNCTION public.sync_provider_stakeholder_account(_tenant_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  acct         public.payment_provider_accounts%ROWTYPE;
  bank         public.payment_provider_methods%ROWTYPE;
  owner_id     uuid;
  tenant_name  text;
  existing_id  uuid;
  payout_id    uuid;
BEGIN
  IF _tenant_id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO acct
  FROM public.payment_provider_accounts
  WHERE tenant_id = _tenant_id
    AND can_receive_payments = true
    AND COALESCE(disabled, false) = false
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1;

  IF acct.id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO bank
  FROM public.payment_provider_methods
  WHERE tenant_id = _tenant_id
    AND provider = acct.provider
    AND environment = acct.environment
    AND external_recipient_id IS NULL
    AND COALESCE(can_receive, true) = true
  ORDER BY is_default DESC NULLS LAST, connected_at DESC NULLS LAST
  LIMIT 1;

  SELECT name INTO tenant_name FROM public.tenants WHERE id = _tenant_id;

  SELECT user_id INTO owner_id
  FROM public.tenant_users
  WHERE tenant_id = _tenant_id
  ORDER BY created_at ASC
  LIMIT 1;

  IF owner_id IS NULL THEN RETURN NULL; END IF;

  SELECT id INTO existing_id
  FROM public.stakeholder_accounts
  WHERE tenant_id = _tenant_id
    AND origin = 'provider_connected'
    AND provider = acct.provider
    AND provider_environment = acct.environment
  LIMIT 1;

  -- The tenant's active partner payout other than this account's own row (SQL 115): one per
  -- tenant (stakeholder_accounts_one_partner_payout), whichever environment holds it.
  SELECT id INTO payout_id
  FROM public.stakeholder_accounts
  WHERE tenant_id = _tenant_id
    AND is_partner_payout = true
    AND is_active = true
    AND id IS DISTINCT FROM existing_id
  LIMIT 1;

  IF existing_id IS NULL THEN
    IF payout_id IS NOT NULL THEN
      RETURN payout_id;
    END IF;
    INSERT INTO public.stakeholder_accounts (
      tenant_id, created_by, nickname, account_type, custname,
      origin, is_partner_payout, is_active,
      verification_status, verification_source, verified_at,
      provider, provider_environment, provider_account_id,
      provider_bank_account_id, provider_bank_name, provider_last_four
    ) VALUES (
      _tenant_id, owner_id,
      COALESCE(tenant_name, 'Partner') || ' (payment account)',
      'contractor', COALESCE(acct.display_name, tenant_name, 'Partner'),
      'provider_connected', true, true,
      'verified', 'moov', now(),
      acct.provider, acct.environment, acct.provider_account_id,
      bank.provider_bank_account_id, bank.bank_name, bank.last_four
    )
    RETURNING id INTO existing_id;
  ELSE
    UPDATE public.stakeholder_accounts
    SET provider_account_id      = acct.provider_account_id,
        provider_bank_account_id = bank.provider_bank_account_id,
        provider_bank_name       = bank.bank_name,
        provider_last_four       = bank.last_four,
        custname                 = COALESCE(acct.display_name, tenant_name, custname),
        is_active                = CASE WHEN payout_id IS NULL THEN true ELSE is_active END,
        verification_status      = 'verified',
        updated_at               = now()
    WHERE id = existing_id;
  END IF;

  RETURN existing_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_provider_stakeholder_account(uuid) FROM PUBLIC;

DO $sql115_acl$
DECLARE
  grantee text;
BEGIN
  FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = grantee) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.sync_provider_stakeholder_account(uuid) FROM %I', grantee);
    END IF;
  END LOOP;
END
$sql115_acl$;
