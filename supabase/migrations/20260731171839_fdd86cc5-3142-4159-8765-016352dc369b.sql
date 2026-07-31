-- 1) Audit logs: stop letting any signed-in user forge entries
DROP POLICY IF EXISTS "audit_logs_insert_only" ON public.audit_logs;
CREATE POLICY "audit_logs_insert_self" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- 2) Global automation settings + workflow rules: admin/staff only for writes
DROP POLICY IF EXISTS "Authenticated users can insert settings" ON public.global_automation_settings;
DROP POLICY IF EXISTS "Authenticated users can update settings" ON public.global_automation_settings;
CREATE POLICY "Admins can insert automation settings" ON public.global_automation_settings
  FOR INSERT TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can update automation settings" ON public.global_automation_settings
  FOR UPDATE TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Authenticated users can manage workflow rules" ON public.workflow_automation_rules;
CREATE POLICY "Authenticated users can view workflow rules" ON public.workflow_automation_rules
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage workflow rules" ON public.workflow_automation_rules
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 3) Disbursement splits: remove fuzzy tenant-name matching
DROP POLICY IF EXISTS "recipient_name_tenant_read_disbursement_splits" ON public.disbursement_splits;
