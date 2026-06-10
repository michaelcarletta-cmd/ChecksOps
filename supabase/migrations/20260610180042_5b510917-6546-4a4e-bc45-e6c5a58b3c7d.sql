-- The check_audit_log table has an index 'idx_check_audit_idempotent' on (check_id, event_type, created_at)
-- but it's only a unique index, not a unique constraint. Postgres ON CONFLICT requires a constraint.

-- 1. Drop the existing unique index if it exists as a plain index
DROP INDEX IF EXISTS public.idx_check_audit_idempotent;

-- 2. Add it as a proper UNIQUE CONSTRAINT so ON CONFLICT can target it
ALTER TABLE public.check_audit_log 
ADD CONSTRAINT check_audit_log_idempotent_key UNIQUE (check_id, event_type, created_at);

-- 3. Update the seed_endorsements_from_payee_line function to be more robust
-- and ensure it doesn't fail if called multiple times
CREATE OR REPLACE FUNCTION public.seed_endorsements_from_payee_line(_check_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 AS $$
DECLARE
  v_check record;
  v_line text;
  v_parts text[];
  v_part text;
  v_clean text;
  v_count integer := 0;
BEGIN
  SELECT id, tenant_id, payee_line
    INTO v_check
    FROM public.check_intake_items
    WHERE id = _check_id;

  IF NOT FOUND OR v_check.payee_line IS NULL OR length(trim(v_check.payee_line)) = 0 THEN
    RETURN 0;
  END IF;

  -- Don't overwrite existing endorsements
  IF EXISTS (SELECT 1 FROM public.check_endorsements WHERE check_id = _check_id) THEN
    RETURN 0;
  END IF;

  v_line := v_check.payee_line;
  v_line := regexp_replace(v_line, '\s+\d{1,6}\s+[A-Za-z0-9\s\.#]+(\d{5}).*$', '', 'i');
  v_parts := regexp_split_to_array(v_line, '\s*&\s*|\s+AND\s+|\s+and\s+');

  FOREACH v_part IN ARRAY v_parts LOOP
    v_clean := trim(regexp_replace(v_part, '\s+', ' ', 'g'));
    IF v_clean ~* '^(isaoa|atima|isaoa-atima|its successors)$' THEN
      CONTINUE;
    END IF;
    v_clean := regexp_replace(v_clean, '\s+ISAOA[-\s]?ATIMA.*$', '', 'i');
    v_clean := trim(v_clean);
    IF length(v_clean) < 2 THEN
      CONTINUE;
    END IF;

    -- Use ON CONFLICT here as well to be safe
    INSERT INTO public.check_endorsements (
      check_id, tenant_id, payee_name, payee_type, status, signature_method
    ) VALUES (
      _check_id,
      v_check.tenant_id,
      v_clean,
      public.classify_payee_type(v_clean),
      'pending',
      'portal'
    ) ON CONFLICT DO NOTHING;
    
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;