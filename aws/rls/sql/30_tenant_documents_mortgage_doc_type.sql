-- 30_tenant_documents_mortgage_doc_type.sql
-- Unapplied AWS operator package. Do not run from completeAuth, CI, deploy,
-- package scripts, Supabase Preview, or application startup.
--
-- Replaces public.tenant_documents_doc_type_check so Mortgage Ops library
-- categories can be stored. Adds only the seven canonical
-- library:mortgage:* values the application emits. Does not allow arbitrary
-- library:mortgage:* suffixes. Does not rewrite rows. Touches no other
-- table, policy, function, trigger, grant, or data.
--
-- Predecessor shapes (fail closed on anything else):
--   3-value IN list from supabase/migrations/20260506174503_52acae08-cbb8-4bcd-9dbd-e013c72d6191.sql
--     w9, license, insurance
--   6-value IN list from supabase/migrations/20260709153833_66ac5141-9ddc-42d8-87b1-5140546745a3.sql
--     those plus saas_agreement, terms_of_service, privacy_policy
--
-- SQL 29 prefix filters stay defense in depth and are not modified here.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $apply$
DECLARE
  def text;
  def_md5 text;
  vals text[];
  pred3 constant text[] := ARRAY['insurance', 'license', 'w9']::text[];
  pred6 constant text[] := ARRAY[
    'insurance',
    'license',
    'privacy_policy',
    'saas_agreement',
    'terms_of_service',
    'w9'
  ]::text[];
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
  invalid_n bigint;
  col_udt text;
  col_nullable text;
BEGIN
  IF to_regclass('public.tenant_documents') IS NULL THEN
    RAISE EXCEPTION 'sql30_abort: public.tenant_documents is missing';
  END IF;

  SELECT c.udt_name, c.is_nullable
    INTO col_udt, col_nullable
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'tenant_documents'
    AND c.column_name = 'doc_type';

  IF col_udt IS NULL THEN
    RAISE EXCEPTION 'sql30_abort: public.tenant_documents.doc_type is missing';
  END IF;
  IF col_udt IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'sql30_abort: doc_type udt_name=% expected text', col_udt;
  END IF;
  IF col_nullable IS DISTINCT FROM 'NO' THEN
    RAISE EXCEPTION 'sql30_abort: doc_type is_nullable=% expected NO', col_nullable;
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
    RAISE EXCEPTION 'sql30_abort: constraint tenant_documents_doc_type_check not found';
  END IF;

  def_md5 := md5(def);
  IF def !~* 'doc_type' THEN
    RAISE EXCEPTION 'sql30_abort: constraint does not mention doc_type md5=%', def_md5;
  END IF;
  IF def ~* 'like' THEN
    RAISE EXCEPTION 'sql30_abort: constraint uses LIKE; unsupported predecessor md5=%', def_md5;
  END IF;
  IF def !~* 'IN\s*\(' AND def !~* '= ANY' THEN
    RAISE EXCEPTION 'sql30_abort: constraint is not an IN / = ANY list md5=%', def_md5;
  END IF;

  SELECT coalesce(array_agg(m[1] ORDER BY m[1]), ARRAY[]::text[])
    INTO vals
  FROM regexp_matches(def, $re$'([^']+)'$re$, 'g') AS m;

  IF vals = target THEN
    RAISE NOTICE 'sql30_already_current tenant_documents_doc_type_check md5=%', def_md5;
    RETURN;
  END IF;

  IF vals IS DISTINCT FROM pred3 AND vals IS DISTINCT FROM pred6 THEN
    RAISE EXCEPTION
      'sql30_abort: unsupported predecessor constraint md5=% n=%',
      def_md5,
      coalesce(array_length(vals, 1), 0);
  END IF;

  SELECT count(*)::bigint
    INTO invalid_n
  FROM public.tenant_documents
  WHERE doc_type IS NULL
     OR doc_type <> ALL (target);

  IF invalid_n > 0 THEN
    RAISE EXCEPTION
      'sql30_abort: % existing rows would violate replacement constraint',
      invalid_n;
  END IF;

  ALTER TABLE public.tenant_documents DROP CONSTRAINT tenant_documents_doc_type_check;

  IF current_setting('checksops.tenant_documents_doc_type_test_fail_after_drop', true) = '1' THEN
    RAISE EXCEPTION 'sql30_injected_failure_after_drop';
  END IF;

  ALTER TABLE public.tenant_documents
    ADD CONSTRAINT tenant_documents_doc_type_check
    CHECK (doc_type IN (
      'w9',
      'license',
      'insurance',
      'saas_agreement',
      'terms_of_service',
      'privacy_policy',
      'library:mortgage:w-9',
      'library:mortgage:contractor-license',
      'library:mortgage:general-liability-insurance',
      'library:mortgage:workers-comp-insurance',
      'library:mortgage:certificate-of-insurance',
      'library:mortgage:signed-contract',
      'library:mortgage:adjuster-tpa-letter'
    ));

  RAISE NOTICE 'sql30_applied predecessor_md5=%', def_md5;
END
$apply$;

COMMIT;
