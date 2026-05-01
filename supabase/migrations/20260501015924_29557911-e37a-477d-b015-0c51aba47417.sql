
INSERT INTO storage.buckets (id, name, public)
VALUES ('email-assets', 'email-assets', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='Public read email-assets'
  ) THEN
    CREATE POLICY "Public read email-assets"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'email-assets');
  END IF;
END$$;
