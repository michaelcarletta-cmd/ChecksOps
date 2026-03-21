
CREATE POLICY "Anyone can read presets"
ON public.signature_document_presets FOR SELECT
TO anon USING (true);
