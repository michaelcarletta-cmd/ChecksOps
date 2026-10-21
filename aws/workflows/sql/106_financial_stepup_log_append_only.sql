-- SQL 106: public.financial_stepup_log is append-only for every role but its owner.
--
-- SQL 97 (97_financial_stepup_log_server_writer.sql) guards the INSERT of a step-up row
-- (a BEFORE INSERT trigger). It does not stop a role that keeps UPDATE from rewriting an
-- existing row's metadata into an app_financial_totp step-up, or one that keeps DELETE or
-- TRUNCATE from removing the audit trail. The read-only production inspect of SQL 97
-- (2026-10-21, SSM 16bcba87-7ad4-48b1-a63b-a2de20d25eee, main dcd865256) reported
-- other_write_grants ["checksops DELETE", "checksops UPDATE"] on the table, so SQL 97 was not
-- applied (ops/production-sql-90-97-apply.md, review notes).
--
-- No server path updates or deletes these rows: auth-financial-totp.mjs and
-- admin-reset-totp.mjs only INSERT ("the table is insert-only"), moov-fund-authz.mjs and
-- checkalt-authz.mjs only SELECT, and the table is not in the /data/write allowlist.
--
-- Revokes UPDATE, DELETE and TRUNCATE on public.financial_stepup_log from PUBLIC, checksops,
-- authenticated and anon (a role that is absent is skipped; revoking a privilege that is not
-- held is a no-op). Does not change SELECT or INSERT for any role, does not touch the owner or
-- service_role, and does not change RLS, policies, triggers (trg_financial_stepup_log_updated_at
-- stays; it fires only on an UPDATE) or rows.
--
-- Order: before SQL 97 in production (after it, SQL 97's inspect reports other_write_grants
-- []); independent of SQL 97 otherwise, so it also runs where SQL 97 is already applied
-- (staging).
--
-- Idempotent: a second run changes nothing. One DO block, no BEGIN/COMMIT (the guarded tools
-- run it in their own transaction).
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect,
-- staging first.

DO $$
DECLARE
  grantee text;
BEGIN
  IF to_regclass('public.financial_stepup_log') IS NULL THEN
    RAISE NOTICE 'SQL 106: public.financial_stepup_log absent; skipped';
    RETURN;
  END IF;
  EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.financial_stepup_log FROM PUBLIC';
  FOREACH grantee IN ARRAY ARRAY['checksops', 'authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.financial_stepup_log FROM %I', grantee);
    ELSE
      RAISE NOTICE 'SQL 106: role % absent; skipped its revoke', grantee;
    END IF;
  END LOOP;
END
$$;
