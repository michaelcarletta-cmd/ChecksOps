CREATE POLICY "Admins and staff can view claim files"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'claim-files'
  AND (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
);

CREATE POLICY "Admins and staff can update claim files"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'claim-files'
  AND (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
)
WITH CHECK (
  bucket_id = 'claim-files'
  AND (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
);