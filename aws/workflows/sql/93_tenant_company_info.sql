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
-- Write policy: the existing aws_write_tenants UPDATE policy requires
-- aws_can_write_tenant() (member plus user_roles admin/staff). Under the
-- users-only rule every tenant member may edit its own tenant's branding, so
-- this adds a permissive UPDATE policy for any tenant_users member of that
-- tenant (aws_user_tenant_ids()). Policies are row-level; the column set a
-- client may write stays restricted by the API (write-allowlist.mjs tenants
-- entry and executeTenantsNarrow in write-app-metadata.mjs). Other tenants
-- and non-member cross-tenant readers gain nothing.
--
-- Idempotent: safe to re-run. Not applied by this change.
--
-- Writer: aws/functions/api/write-app-metadata.mjs (executeTenantsNarrow).
-- Readers: aws/functions/api/email-branding.mjs (resolveTenantDocumentBranding),
--          aws/functions/api/storage.mjs (tenant-logos letterhead reads).

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

DROP POLICY IF EXISTS aws_member_update_tenant_branding ON public.tenants;
CREATE POLICY aws_member_update_tenant_branding ON public.tenants
  FOR UPDATE TO authenticated
  USING (
    public.aws_is_authenticated()
    AND id IN (SELECT public.aws_user_tenant_ids())
  )
  WITH CHECK (
    public.aws_is_authenticated()
    AND id IN (SELECT public.aws_user_tenant_ids())
  );
