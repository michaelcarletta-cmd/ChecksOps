DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'claims' AND COLUMN_NAME = 'signature_cc_email') THEN
    ALTER TABLE public.claims ADD COLUMN signature_cc_email TEXT;
  END IF;
END $$;

-- No specific GRANTs needed if the table already has them, but ensuring general access for completeness if it were a new table.
-- Since it's an existing table, we'll assume RLS and GRANTs are already configured correctly.
