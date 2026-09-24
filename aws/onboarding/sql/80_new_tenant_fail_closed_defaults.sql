-- Recommended fail-closed defaults for newly inserted tenants.
-- Does not rewrite Freedom or any existing tenant row.
-- Do not apply automatically from CI. Operator review required.

ALTER TABLE public.tenants
  ALTER COLUMN moov_allowlisted SET DEFAULT false;

COMMENT ON COLUMN public.tenants.moov_allowlisted IS
  'Per-tenant Moov enablement. New tenants stay false until intentionally approved.';
