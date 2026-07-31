CREATE OR REPLACE FUNCTION public.user_can_access_check(_user_id uuid, _check_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.check_intake_items c
    WHERE c.id = _check_id
      AND (
        public.is_tenant_member(_user_id, c.tenant_id)
        OR EXISTS (
          SELECT 1 FROM public.shared_checks sc
          WHERE sc.check_id = c.id
            AND sc.revoked_at IS NULL
            AND public.is_tenant_member(_user_id, sc.target_tenant_id)
        )
        OR (public.has_role(_user_id, 'mortgage_agent'::public.app_role) AND public.mortgage_agent_can_view_check(c.id))
        OR public.current_tenant_is_check_funds_recipient(c.id)
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.user_can_access_claim(_user_id uuid, _claim_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.claims cl
    WHERE cl.id = _claim_id
      AND (
        public.is_tenant_member(_user_id, cl.org_id)
        OR EXISTS (
          SELECT 1 FROM public.clients c
          WHERE c.id = cl.client_id AND c.user_id = _user_id
        )
        OR EXISTS (
          SELECT 1 FROM public.claim_contractors cc
          WHERE cc.claim_id = cl.id AND cc.contractor_id = _user_id
        )
        OR EXISTS (
          SELECT 1 FROM public.guided_claim_access gca
          WHERE gca.claim_id = cl.id AND gca.user_id = _user_id
        )
        OR (public.has_role(_user_id, 'mortgage_agent'::public.app_role) AND public.mortgage_agent_can_view_claim(cl.id))
        OR public.current_tenant_is_claim_funds_recipient(cl.id)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.user_can_access_check(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_can_access_claim(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_can_access_check(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_access_claim(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "Authenticated users can view check files" ON public.check_files;
DROP POLICY IF EXISTS "Authenticated users can insert check files" ON public.check_files;
DROP POLICY IF EXISTS "Authenticated users can update check files" ON public.check_files;
CREATE POLICY "Authorized users can view check files" ON public.check_files FOR SELECT TO authenticated
USING (
  public.user_can_access_check(auth.uid(), check_intake_item_id)
  OR (signature_request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.signature_requests sr
    WHERE sr.id = signature_request_id
      AND (public.user_can_access_check(auth.uid(), sr.check_intake_item_id) OR public.user_can_access_claim(auth.uid(), sr.claim_id))
  ))
);
CREATE POLICY "Authorized users can insert check files" ON public.check_files FOR INSERT TO authenticated
WITH CHECK (
  uploaded_by = auth.uid()
  AND (
    public.user_can_access_check(auth.uid(), check_intake_item_id)
    OR (signature_request_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.signature_requests sr
      WHERE sr.id = signature_request_id
        AND (public.user_can_access_check(auth.uid(), sr.check_intake_item_id) OR public.user_can_access_claim(auth.uid(), sr.claim_id))
    ))
  )
);
CREATE POLICY "Authorized users can update check files" ON public.check_files FOR UPDATE TO authenticated
USING (public.user_can_access_check(auth.uid(), check_intake_item_id))
WITH CHECK (public.user_can_access_check(auth.uid(), check_intake_item_id));

DROP POLICY IF EXISTS "Authenticated users can manage mortgage draws" ON public.check_intake_mortgage_draws;
CREATE POLICY "Authorized users can view mortgage draws" ON public.check_intake_mortgage_draws FOR SELECT TO authenticated
USING (public.user_can_access_check(auth.uid(), check_id));
CREATE POLICY "Authorized users can insert mortgage draws" ON public.check_intake_mortgage_draws FOR INSERT TO authenticated
WITH CHECK (public.user_can_access_check(auth.uid(), check_id));
CREATE POLICY "Authorized users can update mortgage draws" ON public.check_intake_mortgage_draws FOR UPDATE TO authenticated
USING (public.user_can_access_check(auth.uid(), check_id))
WITH CHECK (public.user_can_access_check(auth.uid(), check_id));
CREATE POLICY "Authorized users can delete mortgage draws" ON public.check_intake_mortgage_draws FOR DELETE TO authenticated
USING (public.user_can_access_check(auth.uid(), check_id));

DROP POLICY IF EXISTS "Authenticated users can read check messages" ON public.check_messages;
DROP POLICY IF EXISTS "Authenticated users can post check messages" ON public.check_messages;
CREATE POLICY "Authorized users can read check messages" ON public.check_messages FOR SELECT TO authenticated
USING (public.user_can_access_check(auth.uid(), check_id));
CREATE POLICY "Authorized users can post check messages" ON public.check_messages FOR INSERT TO authenticated
WITH CHECK (sender_id = auth.uid() AND public.user_can_access_check(auth.uid(), check_id));

DROP POLICY IF EXISTS "Authenticated users can view payment directions" ON public.check_payment_directions;
DROP POLICY IF EXISTS "Authenticated users can insert payment directions" ON public.check_payment_directions;
DROP POLICY IF EXISTS "Authenticated users can update payment directions" ON public.check_payment_directions;
CREATE POLICY "Authorized users can view payment directions" ON public.check_payment_directions FOR SELECT TO authenticated
USING (
  public.user_can_access_claim(auth.uid(), claim_id)
  OR EXISTS (SELECT 1 FROM public.claim_checks cc WHERE cc.id = check_id AND public.user_can_access_check(auth.uid(), cc.check_intake_item_id))
);
CREATE POLICY "Authorized users can insert payment directions" ON public.check_payment_directions FOR INSERT TO authenticated
WITH CHECK (
  public.user_can_access_claim(auth.uid(), claim_id)
  OR EXISTS (SELECT 1 FROM public.claim_checks cc WHERE cc.id = check_id AND public.user_can_access_check(auth.uid(), cc.check_intake_item_id))
);
CREATE POLICY "Authorized users can update payment directions" ON public.check_payment_directions FOR UPDATE TO authenticated
USING (
  public.user_can_access_claim(auth.uid(), claim_id)
  OR EXISTS (SELECT 1 FROM public.claim_checks cc WHERE cc.id = check_id AND public.user_can_access_check(auth.uid(), cc.check_intake_item_id))
)
WITH CHECK (
  public.user_can_access_claim(auth.uid(), claim_id)
  OR EXISTS (SELECT 1 FROM public.claim_checks cc WHERE cc.id = check_id AND public.user_can_access_check(auth.uid(), cc.check_intake_item_id))
);

DROP POLICY IF EXISTS "Authenticated users can view signature_fields" ON public.signature_fields;
DROP POLICY IF EXISTS "Service role full access on signature_fields" ON public.signature_fields;
CREATE POLICY "Authorized users can view signature fields" ON public.signature_fields FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.signature_requests sr
  WHERE sr.id = signature_request_id
    AND (public.user_can_access_check(auth.uid(), sr.check_intake_item_id) OR public.user_can_access_claim(auth.uid(), sr.claim_id))
));
CREATE POLICY "Backend service manages signature fields" ON public.signature_fields FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated users can view signature_field_values" ON public.signature_field_values;
DROP POLICY IF EXISTS "Service role full access on signature_field_values" ON public.signature_field_values;
CREATE POLICY "Authorized users can view signature field values" ON public.signature_field_values FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1
  FROM public.signature_fields sf
  JOIN public.signature_requests sr ON sr.id = sf.signature_request_id
  WHERE sf.id = field_id
    AND (public.user_can_access_check(auth.uid(), sr.check_intake_item_id) OR public.user_can_access_claim(auth.uid(), sr.claim_id))
));
CREATE POLICY "Backend service manages signature field values" ON public.signature_field_values FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all operations for authenticated users" ON public.photo_line_item_links;
CREATE POLICY "Authorized users can view photo line links" ON public.photo_line_item_links FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.claim_photos cp WHERE cp.id = photo_id AND public.user_can_access_claim(auth.uid(), cp.claim_id)));
CREATE POLICY "Authorized users can insert photo line links" ON public.photo_line_item_links FOR INSERT TO authenticated
WITH CHECK (created_by = auth.uid() AND EXISTS (SELECT 1 FROM public.claim_photos cp WHERE cp.id = photo_id AND public.user_can_access_claim(auth.uid(), cp.claim_id)));
CREATE POLICY "Authorized users can update photo line links" ON public.photo_line_item_links FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.claim_photos cp WHERE cp.id = photo_id AND public.user_can_access_claim(auth.uid(), cp.claim_id)))
WITH CHECK (EXISTS (SELECT 1 FROM public.claim_photos cp WHERE cp.id = photo_id AND public.user_can_access_claim(auth.uid(), cp.claim_id)));
CREATE POLICY "Authorized users can delete photo line links" ON public.photo_line_item_links FOR DELETE TO authenticated
USING (created_by = auth.uid() AND EXISTS (SELECT 1 FROM public.claim_photos cp WHERE cp.id = photo_id AND public.user_can_access_claim(auth.uid(), cp.claim_id)));