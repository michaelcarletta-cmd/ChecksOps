-- SQL 92: column-scoped UPDATE grant so Signature Request create can link a
-- check-scoped document (check_files.signature_request_id) after inserting the
-- request. Ported from Cursor SQL 75 (8f4ee2842,
-- aws/workflows/sql/75_signature_request_check_files_link_grant.sql); renumbered
-- because 75 was never ported to main and 90/91 are taken on other branches.
--
-- esign.mjs linkCheckFileToRequest already runs this UPDATE inside a savepoint
-- and treats a missing grant as "not linked", so the request still succeeds
-- without this migration; with it, the link is recorded.
--
-- Grants UPDATE only on check_files.signature_request_id.
-- Does not GRANT table-wide UPDATE on check_files, nor UPDATE on any other column.
-- Does not GRANT to PUBLIC or anon. Does not ENABLE/FORCE RLS or touch policies.
-- aws_write_check_files / aws_can_write_check(check_intake_item_id) remains the
-- authorization boundary.
--
-- Idempotent: GRANT is a no-op when already held; the guard skips cleanly when the
-- table, column or a grantee role is absent.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a
-- read-only inspect, staging first.

DO $$
BEGIN
  IF to_regclass('public.check_files') IS NULL THEN
    RAISE NOTICE 'SQL 92: public.check_files absent; skipped';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'check_files'
       AND column_name = 'signature_request_id'
  ) THEN
    RAISE NOTICE 'SQL 92: check_files.signature_request_id absent; skipped';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops') THEN
    EXECUTE 'GRANT UPDATE (signature_request_id) ON TABLE public.check_files TO checksops';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT UPDATE (signature_request_id) ON TABLE public.check_files TO authenticated';
  END IF;
END
$$;
