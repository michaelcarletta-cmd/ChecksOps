-- ============================================================================
-- NOT SAFE TO APPLY / DESIGN ONLY
-- Do not run this file. It is not a migration, not a oneshot, and not
-- authorized for production, staging, or any live database.
-- Intentionally stored outside supabase/migrations and outside every
-- automatic runner glob (aws/write-path/sql, aws/workflows/sql,
-- aws/financial/sql, aws/rls/sql, aws/migrations/proposed).
-- Filename prefix NOT_APPLIED_ is required.
-- ============================================================================
-- TENANT PAYMENT RECIPIENT DISPLAY OVERRIDES — DO NOT APPLY IN THIS PR.
--
-- Payments-specific display name/type for tenant: aggregate keys.
-- Does not rename public.tenants. Does not rewrite
-- disbursement_splits.recipient_tenant_id or
-- payment_transfers.destination_tenant_id.
--
-- Apply only in a later reviewed sql-apply workstream.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tenant_payment_recipient_overrides (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  aggregate_key text NOT NULL,
  display_name text NOT NULL,
  display_type text NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, aggregate_key),
  CONSTRAINT tenant_payment_recipient_overrides_key_check
    CHECK (aggregate_key ~ '^tenant:[0-9a-f-]{36}$'),
  CONSTRAINT tenant_payment_recipient_overrides_type_check
    CHECK (display_type IN (
      'subcontractor', 'contractor', 'sales_rep', 'appraisal', 'supplier',
      'adjuster', 'vendor', 'client', 'insured', 'overhead', 'operating', 'other'
    ))
);

COMMENT ON TABLE public.tenant_payment_recipient_overrides IS
  'Payer-scoped display overlay for tenant-to-tenant Payments rows. Never mutates tenant identity or provider transfers.';

REVOKE ALL ON TABLE public.tenant_payment_recipient_overrides FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tenant_payment_recipient_overrides TO checksops, authenticated;

ALTER TABLE public.tenant_payment_recipient_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_payment_recipient_overrides FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aws_select_tenant_payment_recipient_overrides ON public.tenant_payment_recipient_overrides;
CREATE POLICY aws_select_tenant_payment_recipient_overrides ON public.tenant_payment_recipient_overrides
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_tenant_payment_recipient_overrides ON public.tenant_payment_recipient_overrides;
CREATE POLICY aws_write_tenant_payment_recipient_overrides ON public.tenant_payment_recipient_overrides
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

-- Prepared for review only. Do not apply this file.

COMMIT;
