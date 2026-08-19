GRANT INSERT, SELECT, UPDATE ON public.signature_requests TO authenticated;
GRANT INSERT, SELECT, UPDATE ON public.signature_signers TO authenticated;
GRANT ALL ON public.signature_requests TO service_role;
GRANT ALL ON public.signature_signers TO service_role;