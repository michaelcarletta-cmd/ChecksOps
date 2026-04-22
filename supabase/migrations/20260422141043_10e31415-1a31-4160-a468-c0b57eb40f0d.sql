-- Storage bucket for tenant logos
INSERT INTO storage.buckets (id, name, public)
VALUES ('tenant-logos', 'tenant-logos', true)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload tenant logos
CREATE POLICY "Authenticated users can upload tenant logos"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'tenant-logos');

-- Allow public read access to tenant logos
CREATE POLICY "Public can view tenant logos"
ON storage.objects FOR SELECT
USING (bucket_id = 'tenant-logos');

-- Allow authenticated users to update/delete their uploads
CREATE POLICY "Authenticated users can update tenant logos"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'tenant-logos');

CREATE POLICY "Authenticated users can delete tenant logos"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'tenant-logos');

-- Add email config columns to tenants
ALTER TABLE public.tenants
ADD COLUMN IF NOT EXISTS email_from_name text,
ADD COLUMN IF NOT EXISTS email_from_address text,
ADD COLUMN IF NOT EXISTS email_reply_to text,
ADD COLUMN IF NOT EXISTS email_provider text DEFAULT 'none',
ADD COLUMN IF NOT EXISTS email_provider_config jsonb DEFAULT '{}'::jsonb;