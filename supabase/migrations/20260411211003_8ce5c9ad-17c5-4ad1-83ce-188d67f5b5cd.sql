DROP POLICY IF EXISTS "Users can enqueue JobNimbus sync items" ON public.jobnimbus_sync_queue;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'jobnimbus_sync_queue'
      AND policyname = 'Admins and staff can view sync queue'
  ) THEN
    CREATE POLICY "Admins and staff can view sync queue"
    ON public.jobnimbus_sync_queue
    FOR SELECT
    TO public
    USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role));
  END IF;
END $$;

DROP POLICY IF EXISTS "Service role can manage sync queue" ON public.jobnimbus_sync_queue;

CREATE POLICY "Service role can manage sync queue"
ON public.jobnimbus_sync_queue
FOR ALL
TO public
USING (auth.uid() IS NULL)
WITH CHECK (auth.uid() IS NULL);