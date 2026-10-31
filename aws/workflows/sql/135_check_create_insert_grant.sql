-- SQL 135: the column INSERT privileges the check create (Upload & Analyze) needs on AWS.
--
-- Why: staging "Upload & Analyze" on the Check Command Center fails. The staging API log
-- (/aws/lambda/checksops-staging-api, 2026-10-31 13:06:40Z and 13:15:40Z) shows
-- POST /staging/workflow/checks answered 403 with the PostgreSQL error
-- "permission denied for table check_intake_items". That route is handleCreateCheck
-- (aws/functions/api/workflow.mjs), which runs, as checksops (the API login), one
--   INSERT INTO public.check_intake_items (
--     id, tenant_id, uploaded_by, status, check_stage, ocr_status, front_image_path,
--     back_image_path, ocr_needs_verification, carrier_name, check_number, payee_line,
--     property_address, funds_type, review_notes, payee_address, expiration_days,
--     is_multi_payee, issue_date, amount, claim_id
--     [, cash_job_id, check_source, cash_job_payment_class]   -- a cash-job check only
--   ) ... RETURNING *
-- claim_id has been named on every create since the cash-jobs change (#1317, 2026-10-27);
-- the three cash-job columns only for a check uploaded from a cash job. SQL 50
-- (aws/workflows/sql/50_tranche5_write_grants.sql) granted column INSERT on the first
-- twenty columns (not claim_id: the create then left it null) to checksops and
-- authenticated; SQL 51 (51_tranche5_revoke_write_grants.sql) revokes INSERT on the table
-- from both where it is run (a table-level REVOKE also removes their column INSERT); no
-- later file grants INSERT on check_intake_items. PostgreSQL checks table and column
-- privileges before row-level security, so the create is refused (42501) before
-- aws_write_check_intake_items is evaluated. Production's checksops held table-level
-- INSERT at its SQL 89 inspect (ACL checksops=arwd, now ard); staging's live column ACL is
-- not recorded in this repository: the staging read-live of this file reads it.
--
-- A new migration, not an edit to SQL 50 or SQL 51 (AGENTS.md: migrations are append-only).
--
-- Grants checksops (the role the API runs as) column INSERT on exactly the twenty-four
-- columns handleCreateCheck can name, and revokes the same columns' INSERT from
-- authenticated, so that both environments reach one state: the twenty-four columns carry
-- checksops INSERT and no authenticated INSERT (SQL 50's authenticated lines, where SQL 51
-- was never run; checksops is a member of authenticated and is granted directly here).
-- Seventeen of the columns also keep SQL 89's checksops UPDATE; this file does not touch it.
--
-- Not changed: no table-wide INSERT; no UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER; no
-- SELECT (RETURNING * reads with the table SELECT checksops already holds); nothing to
-- PUBLIC or anon; no other column. No policy, RLS setting, function, trigger, column or row
-- changes: aws_write_check_intake_items (aws/rls/sql/21_proposed_write_policies.sql:
-- FOR ALL TO authenticated, USING / WITH CHECK aws_can_write_tenant(tenant_id)) and
-- aws_select_check_intake_items remain the authorization boundary.
--
-- Preconditions fail closed: the table, each of the twenty-four columns and the roles
-- checksops and authenticated must exist (sql135_* exceptions, nothing changes otherwise).
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: GRANT of a held privilege and REVOKE of an absent one are no-ops. Not applied
-- by this change: staging first, then production, through the guarded SQL path (AGENTS.md).

DO $sql135_preconditions$
DECLARE
  v_column text;
  v_role text;
BEGIN
  IF pg_catalog.to_regclass('public.check_intake_items') IS NULL THEN
    RAISE EXCEPTION 'sql135_table_missing: public.check_intake_items does not exist'
      USING ERRCODE = '42P01';
  END IF;
  FOREACH v_column IN ARRAY ARRAY[
    'id', 'tenant_id', 'uploaded_by', 'status', 'check_stage', 'ocr_status',
    'front_image_path', 'back_image_path', 'ocr_needs_verification', 'carrier_name',
    'check_number', 'payee_line', 'property_address', 'funds_type', 'review_notes',
    'payee_address', 'expiration_days', 'is_multi_payee', 'issue_date', 'amount',
    'claim_id', 'cash_job_id', 'check_source', 'cash_job_payment_class'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.check_intake_items'::regclass
         AND a.attname = v_column
         AND a.attnum > 0
         AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION 'sql135_column_missing: public.check_intake_items.% does not exist', v_column
        USING ERRCODE = '42703';
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['checksops', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      RAISE EXCEPTION 'sql135_role_missing: role % does not exist', v_role
        USING ERRCODE = '42704';
    END IF;
  END LOOP;
END
$sql135_preconditions$;

GRANT INSERT (
  id,
  tenant_id,
  uploaded_by,
  status,
  check_stage,
  ocr_status,
  front_image_path,
  back_image_path,
  ocr_needs_verification,
  carrier_name,
  check_number,
  payee_line,
  property_address,
  funds_type,
  review_notes,
  payee_address,
  expiration_days,
  is_multi_payee,
  issue_date,
  amount,
  claim_id,
  cash_job_id,
  check_source,
  cash_job_payment_class
) ON TABLE public.check_intake_items TO checksops;

REVOKE INSERT (
  id,
  tenant_id,
  uploaded_by,
  status,
  check_stage,
  ocr_status,
  front_image_path,
  back_image_path,
  ocr_needs_verification,
  carrier_name,
  check_number,
  payee_line,
  property_address,
  funds_type,
  review_notes,
  payee_address,
  expiration_days,
  is_multi_payee,
  issue_date,
  amount,
  claim_id,
  cash_job_id,
  check_source,
  cash_job_payment_class
) ON TABLE public.check_intake_items FROM authenticated;
