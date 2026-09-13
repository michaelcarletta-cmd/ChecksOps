-- 30_tenant_documents_mortgage_doc_type_rollback.sql
-- Unapplied AWS operator package. Restores the 6-value predecessor CHECK
-- from supabase/migrations/20260709153833_66ac5141-9ddc-42d8-87b1-5140546745a3.sql.
--
-- Abort if the live constraint is not the SQL 30 target, or if any
-- tenant_documents row uses a Mortgage Ops library doc_type. Those rows must
-- be resolved out of band first. This script does not delete or rewrite rows.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $rollback$
DECLARE
  def text;
  def_md5 text;
  vals text[];
  target constant text[] := ARRAY[
    'insurance',
    'library:mortgage:adjuster-tpa-letter',
    'library:mortgage:certificate-of-insurance',
    'library:mortgage:contractor-license',
    'library:mortgage:general-liability-insurance',
    'library:mortgage:signed-contract',
    'library:mortgage:w-9',
    'library:mortgage:workers-comp-insurance',
    'license',
    'privacy_policy',
    'saas_agreement',
    'terms_of_service',
    'w9'
  ]::text[];
  pred6 constant text[] := ARRAY[
    'insurance',
    'license',
    'privacy_policy',
    'saas_agreement',
    'terms_of_service',
    'w9'
  ]::text[];
  mortgage_n bigint;
BEGIN
  IF to_regclass('public.tenant_documents') IS NULL THEN
    RAISE EXCEPTION 'sql30_rollback_abort: public.tenant_documents is missing';
  END IF;

  SELECT pg_get_constraintdef(c.oid)
    INTO def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'tenant_documents'
    AND c.conname = 'tenant_documents_doc_type_check'
    AND c.contype = 'c';

  IF def IS NULL THEN
    RAISE EXCEPTION 'sql30_rollback_abort: constraint tenant_documents_doc_type_check not found';
  END IF;

  def_md5 := md5(def);
  SELECT coalesce(array_agg(m[1] ORDER BY m[1]), ARRAY[]::text[])
    INTO vals
  FROM regexp_matches(def, $re$'([^']+)'$re$, 'g') AS m;

  IF vals = pred6 THEN
    RAISE NOTICE 'sql30_rollback_already_predecessor tenant_documents_doc_type_check md5=%', def_md5;
    RETURN;
  END IF;

  IF vals IS DISTINCT FROM target THEN
    RAISE EXCEPTION
      'sql30_rollback_abort: live constraint is not the SQL 30 target md5=% n=%',
      def_md5,
      coalesce(array_length(vals, 1), 0);
  END IF;

  SELECT count(*)::bigint
    INTO mortgage_n
  FROM public.tenant_documents
  WHERE doc_type LIKE 'library:mortgage:%';

  IF mortgage_n > 0 THEN
    RAISE EXCEPTION
      'sql30_rollback_abort: % Mortgage Ops document rows would be invalidated; resolve them first. This script does not delete or rewrite rows.',
      mortgage_n;
  END IF;

  ALTER TABLE public.tenant_documents DROP CONSTRAINT tenant_documents_doc_type_check;
  ALTER TABLE public.tenant_documents
    ADD CONSTRAINT tenant_documents_doc_type_check
    CHECK (doc_type IN (
      'w9',
      'license',
      'insurance',
      'saas_agreement',
      'terms_of_service',
      'privacy_policy'
    ));

  RAISE NOTICE 'sql30_rollback_applied from_md5=%', def_md5;
END
$rollback$;

COMMIT;
