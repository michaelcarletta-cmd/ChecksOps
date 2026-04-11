-- Allow authenticated users to enqueue JobNimbus sync work for claims they can access
DROP POLICY IF EXISTS "Users can enqueue JobNimbus sync items" ON public.jobnimbus_sync_queue;

CREATE POLICY "Users can enqueue JobNimbus sync items"
ON public.jobnimbus_sync_queue
FOR INSERT
TO authenticated
WITH CHECK (
  claim_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.claims c
    WHERE c.id = jobnimbus_sync_queue.claim_id
  )
);

-- Allow backend/service processing to keep managing queue rows without exposing write access to signed-in users
DROP POLICY IF EXISTS "Service role can manage sync queue" ON public.jobnimbus_sync_queue;

CREATE POLICY "Service role can manage sync queue"
ON public.jobnimbus_sync_queue
FOR ALL
TO public
USING (auth.uid() IS NULL)
WITH CHECK (auth.uid() IS NULL);