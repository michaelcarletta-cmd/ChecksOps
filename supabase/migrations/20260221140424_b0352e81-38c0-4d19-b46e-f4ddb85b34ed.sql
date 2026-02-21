-- Fix darwin_sms_activity RLS: restrict SELECT to own records
DROP POLICY IF EXISTS "Users can view SMS activity" ON public.darwin_sms_activity;

CREATE POLICY "Users can view own SMS activity"
ON public.darwin_sms_activity
FOR SELECT
USING (auth.uid() = user_id);

-- Also restrict INSERT to own records
DROP POLICY IF EXISTS "Service can insert SMS activity" ON public.darwin_sms_activity;

CREATE POLICY "Service and owner can insert SMS activity"
ON public.darwin_sms_activity
FOR INSERT
WITH CHECK (true);
