-- SQL 93: each tenant keeps its own company information and document letterhead.
--
-- Branding Settings "Company Information" (address, phone, email) and the
-- "Document Letterhead" used to write the platform-owner-only
-- company_branding singleton, so tenant members could not save them and a
-- tenant's documents fell back to the platform's details. They now live on
-- the tenant's own row. Company name is the existing tenants.name.
--
-- The existing business_address / business_phone (KYC / payment-provider
-- onboarding) and email_reply_to (email sending) columns are deliberately not
-- reused: editing display branding must not change KYC data or reply-to.
--
-- All columns are nullable with no default, so existing rows are unchanged and
-- readers fall back exactly as before until a tenant saves values.
--
-- Write policy (reconciled with SQL 90 for the 2026-10-17 release): there is
-- ONE members-only tenants UPDATE policy, SQL 90's aws_write_tenants
-- (aws_is_tenant_member(id)). This file no longer adds a second permissive
-- policy; it drops the aws_member_update_tenant_branding policy an earlier
-- draft of this file created, and refuses to run (55000
-- sql93_prerequisite_missing) unless SQL 90's helper and policy are present.
--
-- Columns: RLS is row-level, so a BEFORE UPDATE trigger
-- (aws_tenants_member_column_guard) limits what an end-user request
-- (request.app_user_id set) may change on its tenant's row to the display
-- columns the API writes for members:
--   name, logo_url, primary_color, secondary_color, invoice_letterhead_url,
--   invoice_footer_note, invoice_default_terms, invoice_accent_color,
--   invoice_theme, company_address, company_phone, company_email,
--   letterhead_url (write-app-metadata executeTenantsNarrow and the tenant
--   branding display columns), and updated_at.
-- business_address, business_phone (KYC / payment-provider data) and
-- email_reply_to are not member-writable: the only route that wrote them,
-- tenant-company-branding-save, is retired (410). Email Reply-To is saved in
-- tenant_email_settings (tenant-email-branding-save), KYC in the Moov
-- onboarding tables.
-- Any other column (slug, moov_*, payment_provider, payment_rail,
-- is_test_account, is_system_tenant, kyc_*, ein, partner_code, rates, caps,
-- actum_*, ...) changed by an end-user request is refused with 42501
-- tenant_column_not_member_writable. A column-level GRANT would not fit:
-- checksops is the API's only login role, so it would also bind server-side
-- writes. Requests with no caller are not end-user writes and are already
-- refused by RLS (aws_is_authenticated()).
--
-- Idempotent: safe to re-run. Not applied by this change.
--
-- Writer: aws/functions/api/write-app-metadata.mjs (executeTenantsNarrow).
-- Readers: aws/functions/api/email-branding.mjs (resolveTenantDocumentBranding),
--          aws/functions/api/storage.mjs (tenant-logos letterhead reads).

DO $$
BEGIN
  IF to_regprocedure('public.aws_is_tenant_member(uuid)') IS NULL
     OR to_regprocedure('public.aws_is_authenticated()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'tenants'
          AND policyname = 'aws_write_tenants' AND cmd = 'UPDATE')
  THEN
    RAISE EXCEPTION 'sql93_prerequisite_missing: apply SQL 90 (aws_is_tenant_member, aws_write_tenants) first'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS company_address TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS company_phone TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS company_email TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS letterhead_url TEXT;

COMMENT ON COLUMN public.tenants.company_address IS
  'Tenant company address shown on its own documents. Not the KYC business_address.';
COMMENT ON COLUMN public.tenants.company_phone IS
  'Tenant company phone shown on its own documents. Not the KYC business_phone.';
COMMENT ON COLUMN public.tenants.company_email IS
  'Tenant company contact email shown on its own documents. Not email_reply_to.';
COMMENT ON COLUMN public.tenants.letterhead_url IS
  'Tenant document letterhead object path in tenant-logos ({tenant_id}/letterhead-<time>.<ext>).';

-- One members-only tenants UPDATE policy: SQL 90's aws_write_tenants.
DROP POLICY IF EXISTS aws_member_update_tenant_branding ON public.tenants;

CREATE OR REPLACE FUNCTION public.aws_tenants_member_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_member_columns CONSTANT text[] := ARRAY[
    'name', 'logo_url', 'primary_color', 'secondary_color',
    'invoice_letterhead_url', 'invoice_footer_note', 'invoice_default_terms',
    'invoice_accent_color', 'invoice_theme',
    'company_address', 'company_phone', 'company_email', 'letterhead_url',
    'updated_at'
  ];
  v_old jsonb := to_jsonb(OLD);
  v_changed text[];
BEGIN
  -- Only end-user requests are limited; RLS already refuses requests with no caller.
  -- aws_is_authenticated() (SECURITY DEFINER, granted to checksops) is
  -- auth.uid() IS NOT NULL without needing USAGE on schema auth.
  IF NOT COALESCE(public.aws_is_authenticated(), false) THEN
    RETURN NEW;
  END IF;
  SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(to_jsonb(NEW)) AS n
   WHERE NOT (n.key = ANY (v_member_columns))
     AND n.value IS DISTINCT FROM (v_old -> n.key);
  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_column_not_member_writable: %', array_to_string(v_changed, ', ')
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.aws_tenants_member_column_guard() IS
  'SQL 93: an end-user tenants UPDATE may change only display/branding/company-info columns; sensitive columns are refused (42501).';

DROP TRIGGER IF EXISTS aws_tenants_member_column_guard ON public.tenants;
CREATE TRIGGER aws_tenants_member_column_guard
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_tenants_member_column_guard();
