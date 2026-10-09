-- 39_tmp_write_policy_reconcile.sql
-- SOURCE / TEST ONLY until a later authorized guarded SQL apply.
--
-- Reconciles live staging public.tenant_maintenance_payments write policy
-- with the accepted AWS tenant-write contract:
--   aws_can_write_tenant(tenant_id)
--
-- Built against the 2026-10-05 catalog inspection, not assumed history.
-- Live drifted predicate (do not keep):
--   is_platform_owner() OR aws_monthly_billing_job()
--   OR current_setting('request.provider_webhook_apply', true) = '1'
--
-- Machine-write authority is the separate live policy
-- aws_write_tenant_maintenance_payments_job TO checksops.
-- This script refuses to apply if that job policy is missing or drifted,
-- so replacing the authenticated policy cannot drop billing-job / webhook
-- write authority.
--
-- Does not modify aws_can_write_tenant.
-- Does not modify tenant membership.
-- Does not DISABLE / ENABLE ROW LEVEL SECURITY.
-- Does not ALTER FORCE RLS.
-- Does not GRANT / REVOKE.
-- Does not drop SELECT policies or the job write policy.
-- Does not touch production.
-- Not a Supabase migration. No Supabase runtime/service dependency.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $guard$
DECLARE
  rls_on boolean;
  write_using text;
  write_check text;
  write_permissive boolean;
  write_cmd char;
  job_using text;
  job_check text;
  job_permissive boolean;
  job_cmd char;
  inspected_write constant text :=
    '(is_platform_owner() OR aws_monthly_billing_job() OR (current_setting(''request.provider_webhook_apply''::text, true) = ''1''::text))';
  intended_a constant text := 'aws_can_write_tenant(tenant_id)';
  intended_b constant text := '(aws_can_write_tenant(tenant_id))';
  intended_c constant text := 'public.aws_can_write_tenant(tenant_id)';
  intended_d constant text := '(public.aws_can_write_tenant(tenant_id))';
  inspected_job constant text :=
    '(aws_monthly_billing_job() OR (current_setting(''request.provider_webhook_apply''::text, true) = ''1''::text))';
BEGIN
  SELECT c.relrowsecurity
    INTO rls_on
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_maintenance_payments'
     AND c.relkind = 'r';

  IF rls_on IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'TMP_RLS_DISABLED'
      USING HINT = 'SQL 39 refuses to enable RLS. Restore enablement out of band, then retry.';
  END IF;

  SELECT pg_get_expr(pol.polqual, pol.polrelid),
         pg_get_expr(pol.polwithcheck, pol.polrelid),
         pol.polpermissive,
         pol.polcmd
    INTO write_using, write_check, write_permissive, write_cmd
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_maintenance_payments'
     AND pol.polname = 'aws_write_tenant_maintenance_payments';

  IF write_using IS NULL THEN
    RAISE EXCEPTION 'TMP_WRITE_POLICY_MISSING';
  END IF;

  IF write_permissive IS DISTINCT FROM true OR write_cmd IS DISTINCT FROM '*' THEN
    RAISE EXCEPTION 'TMP_WRITE_POLICY_COLLISION: permissive=% cmd=%', write_permissive, write_cmd;
  END IF;

  IF write_using NOT IN (inspected_write, intended_a, intended_b, intended_c, intended_d)
     OR write_check NOT IN (inspected_write, intended_a, intended_b, intended_c, intended_d) THEN
    RAISE EXCEPTION 'TMP_WRITE_POLICY_COLLISION: using=% check=%', write_using, write_check;
  END IF;

  SELECT pg_get_expr(pol.polqual, pol.polrelid),
         pg_get_expr(pol.polwithcheck, pol.polrelid),
         pol.polpermissive,
         pol.polcmd
    INTO job_using, job_check, job_permissive, job_cmd
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_maintenance_payments'
     AND pol.polname = 'aws_write_tenant_maintenance_payments_job';

  IF job_using IS NULL THEN
    RAISE EXCEPTION 'TMP_JOB_POLICY_MISSING'
      USING HINT = 'Machine-write (monthly billing / webhook apply) lives on this policy. Do not replace the authenticated policy if the job policy is gone.';
  END IF;

  IF job_permissive IS DISTINCT FROM true
     OR job_cmd IS DISTINCT FROM '*'
     OR job_using IS DISTINCT FROM inspected_job
     OR job_check IS DISTINCT FROM inspected_job THEN
    RAISE EXCEPTION 'TMP_JOB_POLICY_COLLISION: using=% check=%', job_using, job_check;
  END IF;
END
$guard$;

DROP POLICY IF EXISTS aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments;
CREATE POLICY aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DO $verify$
DECLARE
  names text[];
  write_using text;
  job_using text;
  rls_on boolean;
BEGIN
  SELECT array_agg(pol.polname ORDER BY pol.polname)
    INTO names
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_maintenance_payments';

  IF names IS DISTINCT FROM ARRAY[
    'aws_select_tenant_maintenance_payments',
    'aws_select_tenant_maintenance_payments_job',
    'aws_write_tenant_maintenance_payments',
    'aws_write_tenant_maintenance_payments_job'
  ]::text[] THEN
    RAISE EXCEPTION 'TMP_POLICY_SET_DRIFT: %', names;
  END IF;

  SELECT pg_get_expr(pol.polqual, pol.polrelid)
    INTO write_using
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_maintenance_payments'
     AND pol.polname = 'aws_write_tenant_maintenance_payments';

  IF write_using NOT IN (
    'aws_can_write_tenant(tenant_id)',
    '(aws_can_write_tenant(tenant_id))',
    'public.aws_can_write_tenant(tenant_id)',
    '(public.aws_can_write_tenant(tenant_id))'
  ) THEN
    RAISE EXCEPTION 'TMP_WRITE_POLICY_NOT_RECONCILED: %', write_using;
  END IF;

  SELECT pg_get_expr(pol.polqual, pol.polrelid)
    INTO job_using
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_maintenance_payments'
     AND pol.polname = 'aws_write_tenant_maintenance_payments_job';

  IF job_using IS DISTINCT FROM
    '(aws_monthly_billing_job() OR (current_setting(''request.provider_webhook_apply''::text, true) = ''1''::text))'
  THEN
    RAISE EXCEPTION 'TMP_JOB_POLICY_MUTATED: %', job_using;
  END IF;

  SELECT c.relrowsecurity
    INTO rls_on
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_maintenance_payments';

  IF rls_on IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'TMP_RLS_DISABLED_AFTER_REPAIR';
  END IF;
END
$verify$;

COMMIT;
