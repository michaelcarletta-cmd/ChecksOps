
CREATE TABLE public.docupost_contacts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT,
  address1 TEXT NOT NULL,
  address2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.docupost_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view org contacts"
ON public.docupost_contacts FOR SELECT
TO authenticated
USING (
  org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Users can create org contacts"
ON public.docupost_contacts FOR INSERT
TO authenticated
WITH CHECK (
  org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
  )
  AND created_by = auth.uid()
);

CREATE POLICY "Users can update org contacts"
ON public.docupost_contacts FOR UPDATE
TO authenticated
USING (
  org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete org contacts"
ON public.docupost_contacts FOR DELETE
TO authenticated
USING (
  org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
  )
);

CREATE INDEX idx_docupost_contacts_org_id ON public.docupost_contacts(org_id);
