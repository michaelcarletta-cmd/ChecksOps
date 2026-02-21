-- Drop the legacy permissive SELECT policy that overrides the scoped one
DROP POLICY IF EXISTS "Authenticated users can view Darwin SMS activity" ON public.darwin_sms_activity;

-- Also drop the overly-permissive ALL policy for service role (service role bypasses RLS anyway)
DROP POLICY IF EXISTS "Service role full access on Darwin SMS activity" ON public.darwin_sms_activity;