-- 1) darwin_estimate_lines: require access to the parent claim
DROP POLICY IF EXISTS "Authenticated users can manage estimate lines" ON public.darwin_estimate_lines;
CREATE POLICY "Claim users can manage estimate lines"
ON public.darwin_estimate_lines FOR ALL TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id))
WITH CHECK (public.user_can_access_claim(auth.uid(), claim_id));

-- 2) org_members: remove self-insertion privilege-escalation path;
--    membership is managed by org admins / platform admins (existing ALL policy) or backend functions
DROP POLICY IF EXISTS "Users can insert themselves into their org" ON public.org_members;

-- 3) Shared reference tables: read stays open, writes restricted to admin/staff
DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.building_code_citations;
CREATE POLICY "Staff can manage building code citations"
ON public.building_code_citations FOR ALL TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'staff'::app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'staff'::app_role)
);

DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.manufacturer_specs;
CREATE POLICY "Staff can manage manufacturer specs"
ON public.manufacturer_specs FOR ALL TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'staff'::app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'staff'::app_role)
);