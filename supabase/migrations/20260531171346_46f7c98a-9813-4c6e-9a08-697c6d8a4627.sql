
-- bank_balance: restrict to admins, authenticated only
DROP POLICY IF EXISTS "Admins can insert bank balance" ON public.bank_balance;
DROP POLICY IF EXISTS "Admins can update bank balance" ON public.bank_balance;
DROP POLICY IF EXISTS "Admins can view bank balance" ON public.bank_balance;
CREATE POLICY "Admins can view bank balance" ON public.bank_balance FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can insert bank balance" ON public.bank_balance FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can update bank balance" ON public.bank_balance FOR UPDATE TO authenticated USING (has_role(auth.uid(), 'admin'::app_role)) WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- outstanding_checks: admins only, authenticated
DROP POLICY IF EXISTS "Admins can delete outstanding checks" ON public.outstanding_checks;
DROP POLICY IF EXISTS "Admins can insert outstanding checks" ON public.outstanding_checks;
DROP POLICY IF EXISTS "Admins can update outstanding checks" ON public.outstanding_checks;
DROP POLICY IF EXISTS "Admins can view outstanding checks" ON public.outstanding_checks;
CREATE POLICY "Admins can view outstanding checks" ON public.outstanding_checks FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can insert outstanding checks" ON public.outstanding_checks FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can update outstanding checks" ON public.outstanding_checks FOR UPDATE TO authenticated USING (has_role(auth.uid(), 'admin'::app_role)) WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can delete outstanding checks" ON public.outstanding_checks FOR DELETE TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));

-- claim_events: restrict to authenticated staff/admin/read_only
DROP POLICY IF EXISTS claim_events_select ON public.claim_events;
DROP POLICY IF EXISTS claim_events_insert ON public.claim_events;
DROP POLICY IF EXISTS claim_events_update ON public.claim_events;
DROP POLICY IF EXISTS claim_events_delete ON public.claim_events;
CREATE POLICY claim_events_select ON public.claim_events FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'staff'::app_role) OR has_role(auth.uid(),'read_only'::app_role));
CREATE POLICY claim_events_insert ON public.claim_events FOR INSERT TO authenticated
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'staff'::app_role));
CREATE POLICY claim_events_update ON public.claim_events FOR UPDATE TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'staff'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'staff'::app_role));
CREATE POLICY claim_events_delete ON public.claim_events FOR DELETE TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role));

-- extracted_document_data: require staff/admin/read_only role
DROP POLICY IF EXISTS "Users can view extracted data for accessible claims" ON public.extracted_document_data;
CREATE POLICY "Staff can view extracted data" ON public.extracted_document_data FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'staff'::app_role) OR has_role(auth.uid(),'read_only'::app_role));

-- darwin_action_log: restrict
DROP POLICY IF EXISTS "System can insert darwin action logs" ON public.darwin_action_log;
DROP POLICY IF EXISTS "Users can view darwin action logs" ON public.darwin_action_log;
CREATE POLICY "Service role inserts darwin action logs" ON public.darwin_action_log FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Staff can view darwin action logs" ON public.darwin_action_log FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'staff'::app_role));

-- sms_conversation_state: restrict full-access policy to service role
DROP POLICY IF EXISTS "Service role full access on conversation state" ON public.sms_conversation_state;
CREATE POLICY "Service role full access on conversation state" ON public.sms_conversation_state FOR ALL TO service_role USING (true) WITH CHECK (true);

-- user_phone_links: restrict service-role read
DROP POLICY IF EXISTS "Service role can read all phone links" ON public.user_phone_links;
CREATE POLICY "Service role can read all phone links" ON public.user_phone_links FOR SELECT TO service_role USING (true);

-- jobnimbus_sync_queue
DROP POLICY IF EXISTS "Service role can manage sync queue" ON public.jobnimbus_sync_queue;
CREATE POLICY "Service role can manage sync queue" ON public.jobnimbus_sync_queue FOR ALL TO service_role USING (true) WITH CHECK (true);

-- counter_arguments: require auth
DROP POLICY IF EXISTS "Anyone can view active counter arguments" ON public.counter_arguments;
CREATE POLICY "Authenticated users can view active counter arguments" ON public.counter_arguments FOR SELECT TO authenticated USING (is_active = true);

-- signature_document_presets: remove anon read
DROP POLICY IF EXISTS "Anyone can read presets" ON public.signature_document_presets;

-- can_manage_roles: remove bootstrap escalation path
CREATE OR REPLACE FUNCTION public.can_manage_roles(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.has_role(_user_id, 'admin'::app_role);
$function$;
