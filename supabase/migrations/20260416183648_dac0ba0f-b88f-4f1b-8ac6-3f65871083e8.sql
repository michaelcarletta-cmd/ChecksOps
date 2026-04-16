
-- Trigger function: enqueue file sync to JobNimbus on new claim_files row
CREATE OR REPLACE FUNCTION public.enqueue_jobnimbus_file_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jn_job_id text;
  v_lower_name text;
BEGIN
  -- Only enqueue when the claim is linked to JobNimbus
  SELECT jobnimbus_job_id INTO v_jn_job_id
  FROM public.claims
  WHERE id = NEW.claim_id;

  IF v_jn_job_id IS NULL OR v_jn_job_id = '' THEN
    RETURN NEW;
  END IF;

  -- Skip files that originate from email ingestion (already synced via email path)
  IF NEW.source = 'email' OR NEW.email_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Skip auto-generated artifacts (signed PDFs, AI photo reports, POL docx, etc.)
  v_lower_name := lower(coalesce(NEW.file_name, ''));
  IF v_lower_name LIKE 'ai photo report%'
     OR v_lower_name LIKE 'signed -%'
     OR v_lower_name LIKE '%proof of loss%'
     OR v_lower_name LIKE 'photo report%' THEN
    RETURN NEW;
  END IF;

  -- Avoid re-enqueueing on version updates / non-latest versions
  IF NEW.is_latest_version IS DISTINCT FROM TRUE THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.jobnimbus_sync_queue (claim_id, sync_type, status, payload)
  VALUES (
    NEW.claim_id,
    'file',
    'pending',
    jsonb_build_object(
      'data', jsonb_build_object(
        'file_id', NEW.id,
        'file_name', NEW.file_name,
        'file_path', NEW.file_path,
        'file_type', NEW.file_type,
        'file_size', NEW.file_size
      )
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_jobnimbus_file_sync ON public.claim_files;

CREATE TRIGGER trg_enqueue_jobnimbus_file_sync
AFTER INSERT ON public.claim_files
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_jobnimbus_file_sync();
