-- 1) Add funds_type and property_address to check_intake_items
ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS funds_type text,
  ADD COLUMN IF NOT EXISTS property_address text;

-- Validation: allowed funds_type values (nullable allowed)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'check_intake_items_funds_type_check'
  ) THEN
    ALTER TABLE public.check_intake_items
      ADD CONSTRAINT check_intake_items_funds_type_check
      CHECK (funds_type IS NULL OR funds_type IN ('acv','rcv','recoverable_depreciation','supplement','overhead_and_profit'));
  END IF;
END$$;

-- 2) Allow partner-tenant users to read storage objects (front/back images) for checks shared with their tenant
CREATE POLICY "Partner tenants can view shared check images"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'claim-files'
  AND EXISTS (
    SELECT 1
    FROM public.check_intake_items cii
    JOIN public.shared_checks sc
      ON sc.check_id = cii.id AND sc.revoked_at IS NULL
    WHERE (cii.front_image_path = objects.name OR cii.back_image_path = objects.name)
      AND public.user_belongs_to_tenant(auth.uid(), sc.target_tenant_id)
  )
);
