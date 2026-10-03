-- Staging-only. Already applied 2026-09-10 for the tenant-email sink-mode gate.
-- PR #207 / NOT_APPLIED_20260910_tenant_email_ses_domain.sql does not grant
-- table DML on tenant_email_settings. checksops had SELECT only, so authenticated
-- tenant-admin upserts failed with 42501 (mapped as rls_denied) even when
-- aws_write_tenant_email_settings allowed the row.
--
-- Do not give the API role DELETE or TRUNCATE. Do not apply in production. Do not grant
-- DML on tenant_email_action_rate_limits (consume function only).

BEGIN;

GRANT SELECT, INSERT, UPDATE ON TABLE public.tenant_email_settings TO checksops;

COMMIT;
