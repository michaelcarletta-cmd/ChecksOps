-- Stage 11: retire storage buckets for removed CRM/AI domains (both empty)
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND (qual ILIKE '%ai-knowledge-base%' OR with_check ILIKE '%ai-knowledge-base%'
        OR qual ILIKE '%contractor-documents%' OR with_check ILIKE '%contractor-documents%')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', pol.policyname);
  END LOOP;
END $$;