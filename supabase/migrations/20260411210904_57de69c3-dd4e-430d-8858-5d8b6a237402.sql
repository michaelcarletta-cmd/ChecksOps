DROP POLICY IF EXISTS "Users can enqueue JobNimbus sync items" ON public.jobnimbus_sync_queue;

DROP POLICY IF EXISTS "Service role can manage sync queue" ON public.jobnimbus_sync_queue;

CREATE POLICY "Service role can manage sync queue"
ON public.jobnimbus_sync_queue
FOR ALL
TO public
USING (auth.uid() IS NULL)
WITH CHECK (auth.uid() IS NULL);

ALTER TABLE public.jobnimbus_sync_queue FORCE ROW LEVEL SECURITY;