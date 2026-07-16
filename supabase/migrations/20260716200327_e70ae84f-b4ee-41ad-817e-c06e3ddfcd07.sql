
CREATE POLICY "Mortgage agents manage signature requests"
  ON public.signature_requests FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'mortgage_agent'::app_role))
  WITH CHECK (has_role(auth.uid(), 'mortgage_agent'::app_role));

CREATE POLICY "Mortgage agents manage signature signers"
  ON public.signature_signers FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'mortgage_agent'::app_role))
  WITH CHECK (has_role(auth.uid(), 'mortgage_agent'::app_role));
