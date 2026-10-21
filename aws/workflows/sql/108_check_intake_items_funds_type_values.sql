-- SQL 108: check_intake_items.funds_type accepts every value the application offers.
--
-- public.check_intake_items_funds_type_check was added on Supabase
-- (supabase/migrations/20260506145529_61e262df-66f0-4b5d-b477-5f4fa7add9d6.sql) with five
-- values: acv, rcv, recoverable_depreciation, supplement, overhead_and_profit. No later
-- migration changed it, and both AWS databases carry it. The SPA's Funds Type pickers
-- (FUNDS_TYPE_OPTIONS in src/features/check-command/status.ts, used by FundsTypeField in
-- src/pages/CheckCommandCenter.tsx, and the Check Classification select in
-- src/components/check-review/CheckReviewConsole.tsx) also offer deductible,
-- other_structures, personal_property and additional_living_expenses (added 2026-06-08), and
-- the API passes funds_type through as text (write-check-workflow.mjs, workflow.mjs). Every
-- save of one of those four is refused by the database: production
-- /prep/data/write on 2026-10-21 15:57:52-15:58:54 UTC (five requests, FmgYKjjxIAMEJxw= to
-- Fmgh3i9bIAMEcUw=, log group /aws/lambda/checksops-production-prep-api) and staging
-- (2026-09-12, 2026-10-01 /staging/workflow/checks) logged
-- 'new row for relation "check_intake_items" violates check constraint
-- "check_intake_items_funds_type_check"'.
--
-- Replaces the constraint with one allowing NULL or the nine values the SPA offers (the five
-- above plus the four). Accepted predecessor: exactly the five-value list; anything else
-- refuses (sql108_unsupported_funds_type_check) and a missing constraint refuses. Rows that
-- would violate the new constraint refuse (sql108_invalid_rows); no row is read into or
-- rewritten by the file. Does not change any column, grant, policy, trigger or other
-- constraint.
--
-- Idempotent: when the constraint already allows exactly the nine values it is left as it
-- is (sql108_funds_type_check_already_current). One DO block, no BEGIN/COMMIT (the guarded
-- tools run it in their own transaction).
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect,
-- staging first.

DO $sql108$
DECLARE
  def text;
  def_md5 text;
  vals text[];
  pred5 constant text[] := ARRAY[
    'acv',
    'overhead_and_profit',
    'rcv',
    'recoverable_depreciation',
    'supplement'
  ]::text[];
  next9 constant text[] := ARRAY[
    'acv',
    'additional_living_expenses',
    'deductible',
    'other_structures',
    'overhead_and_profit',
    'personal_property',
    'rcv',
    'recoverable_depreciation',
    'supplement'
  ]::text[];
  invalid_n bigint;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid)
    INTO def
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'check_intake_items'
    AND c.conname = 'check_intake_items_funds_type_check'
    AND c.contype = 'c';

  IF def IS NULL THEN
    RAISE EXCEPTION 'sql108_unsupported_funds_type_check: constraint check_intake_items_funds_type_check not found' USING ERRCODE = '55000';
  END IF;
  def_md5 := md5(def);

  IF def ~* 'like' OR def ~ '~' OR def !~ '\(funds_type IS NULL\) OR' OR (def !~* 'IN\s*\(' AND def !~* '= ANY') THEN
    RAISE EXCEPTION 'sql108_unsupported_funds_type_check md5=%', def_md5 USING ERRCODE = '55000';
  END IF;

  SELECT coalesce(array_agg(m[1] ORDER BY m[1]), ARRAY[]::text[])
    INTO vals
  FROM regexp_matches(def, $re$'([^']+)'$re$, 'g') AS m;

  IF vals = next9 THEN
    RAISE NOTICE 'sql108_funds_type_check_already_current md5=%', def_md5;
    RETURN;
  END IF;

  IF vals IS DISTINCT FROM pred5 THEN
    RAISE EXCEPTION 'sql108_unsupported_funds_type_check md5=% n=%', def_md5, coalesce(array_length(vals, 1), 0)
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::bigint INTO invalid_n
  FROM public.check_intake_items
  WHERE funds_type IS NOT NULL AND NOT (funds_type = ANY (next9));
  IF invalid_n > 0 THEN
    RAISE EXCEPTION 'sql108_invalid_rows: % existing rows would violate the new funds_type rule', invalid_n
      USING ERRCODE = '55000';
  END IF;

  ALTER TABLE public.check_intake_items DROP CONSTRAINT check_intake_items_funds_type_check;
  ALTER TABLE public.check_intake_items
    ADD CONSTRAINT check_intake_items_funds_type_check
    CHECK (funds_type IS NULL OR funds_type IN (
      'acv',
      'rcv',
      'recoverable_depreciation',
      'supplement',
      'overhead_and_profit',
      'deductible',
      'other_structures',
      'personal_property',
      'additional_living_expenses'
    ));

  RAISE NOTICE 'sql108_funds_type_check_applied predecessor_md5=%', def_md5;
END
$sql108$;
