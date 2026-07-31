DO $$
DECLARE
  p record;
  using_expr text;
  check_expr text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, cmd
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename LIKE 'claim\_%' ESCAPE '\'
      AND tablename NOT IN ('claim_knowledge_library', 'claim_sub_statuses', 'claim_roof_outline_edits')
      AND roles && ARRAY['authenticated','public']::name[]
      AND (coalesce(qual, '') IN ('true','(true)') OR coalesce(with_check, '') IN ('true','(true)'))
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = pg_policies.tablename
          AND c.column_name = 'claim_id'
      )
  LOOP
    using_expr := 'public.user_can_access_claim(auth.uid(), claim_id)';
    check_expr := 'public.user_can_access_claim(auth.uid(), claim_id)';

    IF p.cmd = 'SELECT' OR p.cmd = 'DELETE' THEN
      EXECUTE format('ALTER POLICY %I ON public.%I TO authenticated USING (%s)', p.policyname, p.tablename, using_expr);
    ELSIF p.cmd = 'INSERT' THEN
      EXECUTE format('ALTER POLICY %I ON public.%I TO authenticated WITH CHECK (%s)', p.policyname, p.tablename, check_expr);
    ELSIF p.cmd = 'UPDATE' OR p.cmd = 'ALL' THEN
      EXECUTE format('ALTER POLICY %I ON public.%I TO authenticated USING (%s) WITH CHECK (%s)', p.policyname, p.tablename, using_expr, check_expr);
    END IF;
  END LOOP;
END $$;

DROP POLICY IF EXISTS "Staff can manage roof outline edits" ON public.claim_roof_outline_edits;
CREATE POLICY "Authorized users can view roof outline edits"
ON public.claim_roof_outline_edits FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.claim_roof_measurements rm
  WHERE rm.id = roof_measurement_id
    AND public.user_can_access_claim(auth.uid(), rm.claim_id)
));
CREATE POLICY "Authorized users can insert roof outline edits"
ON public.claim_roof_outline_edits FOR INSERT TO authenticated
WITH CHECK (
  created_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.claim_roof_measurements rm
    WHERE rm.id = roof_measurement_id
      AND public.user_can_access_claim(auth.uid(), rm.claim_id)
  )
);
CREATE POLICY "Authorized users can update roof outline edits"
ON public.claim_roof_outline_edits FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.claim_roof_measurements rm
  WHERE rm.id = roof_measurement_id
    AND public.user_can_access_claim(auth.uid(), rm.claim_id)
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.claim_roof_measurements rm
  WHERE rm.id = roof_measurement_id
    AND public.user_can_access_claim(auth.uid(), rm.claim_id)
));
CREATE POLICY "Authorized users can delete roof outline edits"
ON public.claim_roof_outline_edits FOR DELETE TO authenticated
USING (
  created_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.claim_roof_measurements rm
    WHERE rm.id = roof_measurement_id
      AND public.user_can_access_claim(auth.uid(), rm.claim_id)
  )
);

DROP POLICY IF EXISTS "Authenticated users can view knowledge entries" ON public.claim_knowledge_library;
CREATE POLICY "Signed in users can view knowledge entries"
ON public.claim_knowledge_library FOR SELECT TO authenticated
USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can create sub-statuses" ON public.claim_sub_statuses;
DROP POLICY IF EXISTS "Authenticated users can delete sub-statuses" ON public.claim_sub_statuses;
DROP POLICY IF EXISTS "Authenticated users can update sub-statuses" ON public.claim_sub_statuses;
DROP POLICY IF EXISTS "Authenticated users can view sub-statuses" ON public.claim_sub_statuses;
CREATE POLICY "Signed in users can view claim sub statuses"
ON public.claim_sub_statuses FOR SELECT TO authenticated
USING (auth.uid() IS NOT NULL);
CREATE POLICY "Admins can insert claim sub statuses"
ON public.claim_sub_statuses FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins can update claim sub statuses"
ON public.claim_sub_statuses FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins can delete claim sub statuses"
ON public.claim_sub_statuses FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role));