CREATE POLICY "Mortgage agents view check file attachments"
ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'claim-files'
  AND has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND EXISTS (
    SELECT 1
    FROM public.check_files cf
    WHERE cf.file_path = storage.objects.name
      AND public.mortgage_agent_can_view_check(cf.check_intake_item_id)
  )
);