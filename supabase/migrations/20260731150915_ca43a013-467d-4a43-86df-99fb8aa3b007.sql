DROP POLICY IF EXISTS "Uploader or admin can delete check files" ON public.check_files;
CREATE POLICY "Authorized uploader or admin can delete check files"
ON public.check_files FOR DELETE TO authenticated
USING (
  public.user_can_access_check(auth.uid(), check_intake_item_id)
  AND (uploaded_by = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role))
);

DROP POLICY IF EXISTS "Senders can update their own messages" ON public.check_messages;
CREATE POLICY "Authorized senders can update their messages"
ON public.check_messages FOR UPDATE TO authenticated
USING (sender_id = auth.uid() AND public.user_can_access_check(auth.uid(), check_id))
WITH CHECK (sender_id = auth.uid() AND public.user_can_access_check(auth.uid(), check_id));

DROP POLICY IF EXISTS "Senders or admins can delete messages" ON public.check_messages;
CREATE POLICY "Authorized senders or admins can delete messages"
ON public.check_messages FOR DELETE TO authenticated
USING (
  public.user_can_access_check(auth.uid(), check_id)
  AND (sender_id = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role))
);