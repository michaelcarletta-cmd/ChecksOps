-- SQL 159: the table SELECT checksops needs to read homeowner intro requests on AWS.
--
-- Why: a contractor's Leads list (Settings, ContractorLeadsCard in
-- src/components/networking/ContractorLeadsCard.tsx) cannot load in production. The production API
-- log (/aws/lambda/checksops-production-prep-api, 2026-11-10 20:01:40Z and 20:01:41Z) shows
-- /prep/data/query answered 403 with the PostgreSQL error "permission denied for table
-- homeowner_intro_requests" (event data_query_failed, errorClass rls_denied) for the card's read:
--   SELECT id, homeowner_name, homeowner_email, homeowner_phone, property_zip, loss_type, message,
--          status, created_at, contacted_at, accepted_at, dtp_claim_number
--     FROM public.homeowner_intro_requests ORDER BY created_at DESC LIMIT 200
-- The data path (aws/functions/api/data.mjs) runs that read as checksops (the API login; it sets the
-- caller's identity GUCs and does not change role), and PostgreSQL checks table privileges before
-- row-level security, so the read is refused (42501) before aws_select_homeowner_intro_requests
-- (aws/rls/sql/12_final_select_policies.sql) is evaluated.
--
-- The restored AWS databases were meant to give checksops SELECT on every table
-- (aws/db-copy/sql/02_grant_readonly_application_role.sql), and no migration in this repository
-- revokes it from this table, but production's checksops holds no SELECT on it. Staging's grant on
-- the table comes from its staging-only migrations (65, 68, 69), which never ran in production.
--
-- A new migration, not an edit to any earlier file (AGENTS.md: migrations are append-only).
--
-- Grants checksops (the role the API runs as) table SELECT on public.homeowner_intro_requests, the
-- baseline every restored table was given. The secret column access_token stays out of the generic
-- data path's reads and filters (aws/functions/api/secret-columns.mjs, data.mjs).
--
-- Not changed: no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER (the table's writes are
-- a separate, reviewed decision: aws/rls/sql/24_complete_write_policies.sql lists the table as
-- server_side_api); nothing to authenticated, PUBLIC, anon or service_role; no column grant; no
-- sequence. No policy, RLS setting, function, trigger, column or row changes:
-- aws_select_homeowner_intro_requests (FOR SELECT TO authenticated: a cross-tenant reader, the
-- lead's contractor, or the homeowner by email) remains the authorization boundary for the rows
-- checksops reads on a caller's behalf.
--
-- Preconditions fail closed: the table and the role checksops must exist (sql159_* exceptions,
-- nothing changes otherwise).
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: GRANT of a held privilege is a no-op. Not applied by this change: staging first,
-- then production, through the guarded SQL path (AGENTS.md).

DO $sql159_preconditions$
BEGIN
  IF pg_catalog.to_regclass('public.homeowner_intro_requests') IS NULL THEN
    RAISE EXCEPTION 'sql159_table_missing: public.homeowner_intro_requests does not exist'
      USING ERRCODE = '42P01';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops') THEN
    RAISE EXCEPTION 'sql159_role_missing: role checksops does not exist'
      USING ERRCODE = '42704';
  END IF;
END
$sql159_preconditions$;

GRANT SELECT ON TABLE public.homeowner_intro_requests TO checksops;
