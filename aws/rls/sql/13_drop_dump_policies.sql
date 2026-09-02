-- Remove restored dump policies so only the AWS SELECT set remains.
-- Do not drop aws_* policies (final SELECT set + isolated probe).
-- RLS stays disabled on restored tables in this phase.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname, tablename
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname NOT LIKE 'aws_%'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;
