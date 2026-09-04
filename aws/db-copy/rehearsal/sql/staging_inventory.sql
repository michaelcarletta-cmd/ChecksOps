-- Sanitized staging inventory for migration rehearsal (no PII columns selected).
-- Run via in-VPC oneshot as checksops_admin against database checksops.
-- Report-only: no DDL/DML.

-- Catalog summary
SELECT 'catalog' AS section, jsonb_build_object(
  'base_tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'),
  'views', (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='VIEW'),
  'routines', (SELECT count(*) FROM information_schema.routines WHERE routine_schema='public'),
  'triggers', (SELECT count(*) FROM information_schema.triggers WHERE trigger_schema='public'),
  'rls_policies', (SELECT count(*) FROM pg_policies WHERE schemaname='public'),
  'extensions', (SELECT coalesce(jsonb_agg(extname ORDER BY extname), '[]'::jsonb) FROM pg_extension)
) AS payload;
