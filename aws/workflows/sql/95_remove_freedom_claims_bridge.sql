-- SQL 95: remove the retired Freedom Claims (partner CRM) bridge objects.
--
-- The separate Freedom Claims CRM app sent checks into ChecksOps and received
-- status back. That bridge is retired: the AWS ingest-shared-check route and
-- the Supabase bridge functions (ingest-shared-check, push-status-to-freedom,
-- receive-check-status, partner-checks-by-claim, lookup-partner-code-public,
-- backfill-mirrored-endorsements, sync-check-status, sync-check-payees,
-- delete-shared-check) are deleted from the repository.
--
-- This file drops the database objects that only the bridge used:
--   - trigger trg_notify_freedom_status_change on check_intake_items and its
--     function notify_freedom_status_change() (HTTP status push to Freedom);
--   - list_checks_by_freedom_claim(text, uuid) (public lookup for Freedom's iframe);
--   - aws_ingest_shared_check(jsonb) (SQL 70, the SECURITY DEFINER ingest);
--   - vault_create_bridge_secret(text) / vault_update_bridge_secret(text)
--     (CROSS_APP_BRIDGE_SECRET vault helpers).
--
-- Kept on purpose (data model and the Freedom Adjustment tenant):
--   - check_intake_items.freedom_claim_id / freedom_claim_number columns;
--   - check_cases.external_system = 'freedom_crm' rows and lookups;
--   - partner_status / external_origin on mirrored rows, which may still exist
--     (workflow-transitions.mjs still refuses status changes on them).
--
-- Do not edit SQL 70: it is recorded applied. Every statement is guarded with
-- IF EXISTS, so the file is idempotent and safe where an object was never
-- created. No data changes. Not applied by this change; apply only through the
-- reviewed deployment-guard SQL tooling, which wraps the statements in one
-- transaction.

DROP TRIGGER IF EXISTS trg_notify_freedom_status_change ON public.check_intake_items;
DROP FUNCTION IF EXISTS public.notify_freedom_status_change();

DROP FUNCTION IF EXISTS public.list_checks_by_freedom_claim(text, uuid);

DROP FUNCTION IF EXISTS public.aws_ingest_shared_check(jsonb);

DROP FUNCTION IF EXISTS public.vault_create_bridge_secret(text);
DROP FUNCTION IF EXISTS public.vault_update_bridge_secret(text);
