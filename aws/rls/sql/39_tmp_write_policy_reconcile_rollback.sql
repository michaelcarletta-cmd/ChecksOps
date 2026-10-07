-- 39_tmp_write_policy_reconcile_rollback.sql
-- Restores the inspected 2026-10-05 drifted authenticated write policy.
-- Does not restore a database snapshot. Does not mutate TMP rows.
-- Does not drop the live job / SELECT policies.
-- Does not disable RLS.
-- Not applied unless a later authorized rollback is requested.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $guard$
DECLARE
  write_using text;
  job_using text;
  intended_ok boolean;
BEGIN
  SELECT pg_get_expr(pol.polqual, pol.polrelid)
    INTO write_using
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_maintenance_payments'
     AND pol.polname = 'aws_write_tenant_maintenance_payments';

  intended_ok := write_using IN (
    'aws_can_write_tenant(tenant_id)',
    '(aws_can_write_tenant(tenant_id))',
    'public.aws_can_write_tenant(tenant_id)',
    '(public.aws_can_write_tenant(tenant_id))'
  );

  IF NOT intended_ok THEN
    RAISE EXCEPTION 'TMP_ROLLBACK_REFUSED: live write policy is not the SQL 39 target (%)', write_using;
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
    RAISE EXCEPTION 'TMP_ROLLBACK_JOB_COLLISION: %', job_using;
  END IF;
END
$guard$;

DROP POLICY IF EXISTS aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments;
CREATE POLICY aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments
  FOR ALL TO authenticated
  USING (
    is_platform_owner()
    OR aws_monthly_billing_job()
    OR (current_setting('request.provider_webhook_apply'::text, true) = '1'::text)
  )
  WITH CHECK (
    is_platform_owner()
    OR aws_monthly_billing_job()
    OR (current_setting('request.provider_webhook_apply'::text, true) = '1'::text)
  );

COMMIT;
