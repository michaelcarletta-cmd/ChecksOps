-- Harden branding asset storage policies.
-- Tenant assets: enforce `{tenantId}/...` prefixes for writes (tenant-logos bucket).
-- Platform assets: restrict company-branding writes to platform staff/admin only.
-- Public reads remain enabled to support email/image rendering.

-- -------------------------
-- tenant-logos (tenant scoped)
-- -------------------------
DROP POLICY IF EXISTS "Authenticated users can upload tenant logos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update tenant logos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete tenant logos" ON storage.objects;
DROP POLICY IF EXISTS "Public can view tenant logos" ON storage.objects;

CREATE POLICY "Public can view tenant logos"
ON storage.objects FOR SELECT
USING (bucket_id = 'tenant-logos');

CREATE POLICY "Tenant members can upload tenant logos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'tenant-logos'
  AND (
    public.is_master_owner()
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'staff')
    )
    OR (
      (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND public.is_tenant_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  )
);

CREATE POLICY "Tenant members can update tenant logos"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'tenant-logos'
  AND (
    public.is_master_owner()
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'staff')
    )
    OR (
      (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND public.is_tenant_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  )
)
WITH CHECK (
  bucket_id = 'tenant-logos'
  AND (
    public.is_master_owner()
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'staff')
    )
    OR (
      (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND public.is_tenant_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  )
);

CREATE POLICY "Tenant members can delete tenant logos"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'tenant-logos'
  AND (
    public.is_master_owner()
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'staff')
    )
    OR (
      (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND public.is_tenant_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  )
);

-- -------------------------
-- company-branding (platform scoped)
-- -------------------------
DROP POLICY IF EXISTS "Users can upload their own logos" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own logos" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view company branding" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can read company branding files" ON storage.objects;
DROP POLICY IF EXISTS "Admin can upload company branding files" ON storage.objects;
DROP POLICY IF EXISTS "Admin can update company branding files" ON storage.objects;
DROP POLICY IF EXISTS "Admin can delete company branding files" ON storage.objects;

CREATE POLICY "Anyone can read company branding files"
ON storage.objects FOR SELECT
USING (bucket_id = 'company-branding');

CREATE POLICY "Platform staff can upload company branding files"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'company-branding'
  AND (
    public.is_master_owner()
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'staff')
    )
  )
);

CREATE POLICY "Platform staff can update company branding files"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'company-branding'
  AND (
    public.is_master_owner()
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'staff')
    )
  )
)
WITH CHECK (
  bucket_id = 'company-branding'
  AND (
    public.is_master_owner()
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'staff')
    )
  )
);

CREATE POLICY "Platform staff can delete company branding files"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'company-branding'
  AND (
    public.is_master_owner()
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'staff')
    )
  )
);

