-- SQL 140: the column INSERT and UPDATE privileges the WalletOps automatic funding save needs on AWS.
--
-- Why: staging "Automatic funding" (the WalletOps auto-funding panel) cannot save the target wallet
-- balance. The staging API log (/aws/lambda/checksops-staging-api, 2026-11-02 12:31:40Z) shows
-- POST /staging/functions/v1/save-tenant-wallet-funding-settings answered 403 with the PostgreSQL
-- error "permission denied for table tenant_wallet_funding_settings". That route is
-- saveTenantWalletFundingSettings (aws/functions/api/tenant-settings-handlers.mjs, #1524), which
-- runs, as checksops (the API login), after setting the server-only money-write flag
-- (aws/functions/api/money-write-flag.mjs), one
--   INSERT INTO public.tenant_wallet_funding_settings (tenant_id, <the columns the request names>
--     [, authorization_accepted_at, authorization_accepted_by])
--   VALUES (...) ON CONFLICT (tenant_id) DO UPDATE SET <the same columns>
--     [, authorization_accepted_at = now(), authorization_accepted_by = ...], updated_at = now()
--   RETURNING *
-- where the request may name auto_funding_enabled, funding_bank_account_id,
-- funding_payment_method_id, funding_strategy, target_wallet_balance_cents,
-- maximum_single_pull_cents, maximum_daily_pull_cents, require_payment_approval and
-- authorization_version; id, created_at and updated_at take their defaults on INSERT.
-- The restored AWS databases gave checksops SELECT only on every table
-- (aws/db-copy/sql/02_grant_readonly_application_role.sql), each table's writes were granted
-- by a later numbered migration (SQL 50, 105, 112, 121, 134, 135), and no migration in this
-- repository grants INSERT or UPDATE on tenant_wallet_funding_settings (the Supabase grants of
-- supabase/migrations/20260828201816_*.sql never reached the AWS copy). PostgreSQL checks table
-- and column privileges before row-level security, so the save is refused (42501) before
-- aws_write_tenant_wallet_funding_settings or SQL 136's RESTRICTIVE gate policies are evaluated.
--
-- A new migration, not an edit to any earlier file (AGENTS.md: migrations are append-only).
--
-- Grants checksops (the role the API runs as; a member of authenticated, so the policies below
-- apply to it) column INSERT on exactly the twelve columns the route can insert and column UPDATE
-- on exactly the twelve it can update (the eleven request columns plus updated_at).
--
-- Not changed: no table-wide INSERT or UPDATE; no DELETE, TRUNCATE, REFERENCES or TRIGGER; no
-- SELECT (ON CONFLICT and RETURNING * read with the table SELECT checksops already holds); no
-- grant on id or created_at (defaults); nothing to authenticated, PUBLIC, anon or service_role;
-- no sequence. No policy, RLS setting, function, trigger, column or row changes:
-- aws_write_tenant_wallet_funding_settings (aws/rls/sql/24_complete_write_policies.sql: FOR ALL
-- TO authenticated, USING / WITH CHECK aws_can_write_tenant(tenant_id)),
-- aws_select_tenant_wallet_funding_settings and SQL 136's three RESTRICTIVE gate policies on
-- the table (true while the route's money-write flag is set) remain the authorization boundary.
--
-- Preconditions fail closed: the table, each of the thirteen columns and the role checksops must
-- exist (sql140_* exceptions, nothing changes otherwise).
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: GRANT of a held privilege is a no-op. Not applied by this change: staging first,
-- then production, through the guarded SQL path (AGENTS.md).

DO $sql140_preconditions$
DECLARE
  v_column text;
BEGIN
  IF pg_catalog.to_regclass('public.tenant_wallet_funding_settings') IS NULL THEN
    RAISE EXCEPTION 'sql140_table_missing: public.tenant_wallet_funding_settings does not exist'
      USING ERRCODE = '42P01';
  END IF;
  FOREACH v_column IN ARRAY ARRAY[
    'tenant_id', 'auto_funding_enabled', 'funding_bank_account_id', 'funding_payment_method_id',
    'funding_strategy', 'target_wallet_balance_cents', 'maximum_single_pull_cents',
    'maximum_daily_pull_cents', 'require_payment_approval', 'authorization_accepted_at',
    'authorization_accepted_by', 'authorization_version', 'updated_at'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.tenant_wallet_funding_settings'::regclass
         AND a.attname = v_column
         AND a.attnum > 0
         AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION 'sql140_column_missing: public.tenant_wallet_funding_settings.% does not exist', v_column
        USING ERRCODE = '42703';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops') THEN
    RAISE EXCEPTION 'sql140_role_missing: role checksops does not exist'
      USING ERRCODE = '42704';
  END IF;
END
$sql140_preconditions$;

GRANT INSERT (
  tenant_id,
  auto_funding_enabled,
  funding_bank_account_id,
  funding_payment_method_id,
  funding_strategy,
  target_wallet_balance_cents,
  maximum_single_pull_cents,
  maximum_daily_pull_cents,
  require_payment_approval,
  authorization_accepted_at,
  authorization_accepted_by,
  authorization_version
) ON TABLE public.tenant_wallet_funding_settings TO checksops;

GRANT UPDATE (
  auto_funding_enabled,
  funding_bank_account_id,
  funding_payment_method_id,
  funding_strategy,
  target_wallet_balance_cents,
  maximum_single_pull_cents,
  maximum_daily_pull_cents,
  require_payment_approval,
  authorization_accepted_at,
  authorization_accepted_by,
  authorization_version,
  updated_at
) ON TABLE public.tenant_wallet_funding_settings TO checksops;
