-- SQL 125: the four Supabase-era deposit views read deposit data as the caller, not as their owner.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why (security audit 2026-10-29, finding 1; owner, 2026-10-29: "start finding 1's migration PR",
-- then "Proceed with option 1"):
--
--   - public.deposit_queue_scored and public.deposit_owner_performance
--     (supabase/migrations/20260308181449_*.sql), public.deposit_reminder_queue
--     (20260308173916_*.sql) and public.deposit_aging_dashboard (20260308173238_*.sql) were created
--     without security_invoker. The restore left them owned by checksops_admin, which also owns
--     deposit_items, deposit_exceptions and deposit_attachments, so a query through a view reads
--     those tables as their owner and their RLS (aws_select_deposit_items: the check's tenant, not
--     a partner; the other two through aws_can_access_deposit_item) is not applied.
--   - All four are on the API's read allowlist (aws/functions/api/allowed-tables.json) and
--     checksops holds SELECT on them (aws/db-copy/sql/02_grant_readonly_application_role.sql). Any
--     signed-in user of any tenant could POST /data/query {"table": "deposit_queue_scored"} and
--     read every tenant's open deposit items (amount, check number, carrier, claim, owner, status,
--     exception counts); the other three return the same rows or per-owner totals.
--
-- 1) ALTER VIEW ... SET (security_invoker = true) on each of the four views. A query through a
--    view then reads deposit_items, deposit_exceptions and deposit_attachments as the caller, under
--    their RLS: a member reads the deposit items of their own tenants' checks, the platform owner
--    what aws_can_access_check_non_partner gives it, a partner tenant nothing. Requires that the
--    login running this file owns each view (42501 sql125_not_view_owner otherwise); a NOTICE and
--    no change for a view that is absent.
--
-- Not changed: no view definition, column or comment; no grant (checksops keeps SELECT on the
-- views); no table, policy, RLS setting, function or row. The Supabase-era SECURITY DEFINER
-- functions that read deposit_owner_performance and deposit_queue_scored (the deposit KPI and
-- digest functions) run as their owner, so through them the views stay global; that is the
-- separate finding on those functions.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: SET (security_invoker = true) leaves the same state on every run.
--
-- NOT APPLIED. Needs a staging read-live, a read-only production inspect (do the four views
-- exist, who owns them, their definitions and options), then staging and production through the
-- guarded SQL path (AGENTS.md).

DO $sql125_views$
DECLARE
  v_view text;
  v_rel oid;
BEGIN
  FOREACH v_view IN ARRAY ARRAY['deposit_queue_scored', 'deposit_owner_performance', 'deposit_reminder_queue', 'deposit_aging_dashboard'] LOOP
    v_rel := pg_catalog.to_regclass(format('public.%I', v_view));
    IF v_rel IS NULL THEN
      RAISE NOTICE 'SQL 125: public.% absent; skipped', v_view;
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
       WHERE c.oid = v_rel
         AND c.relkind = 'v'
         AND c.relowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
    ) THEN
      RAISE EXCEPTION 'sql125_not_view_owner: public.% is not a view owned by the login running SQL 125', v_view
        USING ERRCODE = '42501';
    END IF;
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', v_view);
  END LOOP;
END
$sql125_views$;
