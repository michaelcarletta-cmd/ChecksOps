DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'disbursement_splits'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.disbursement_splits';
  END IF;
END $$;
ALTER TABLE public.disbursement_splits REPLICA IDENTITY FULL;
ALTER TABLE public.check_intake_items REPLICA IDENTITY FULL;