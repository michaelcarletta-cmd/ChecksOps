CREATE OR REPLACE FUNCTION public.auto_sync_claim_to_contractor_instance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  contractor_instance_url text;
  contractor_instance_name text;
  existing_link uuid;
  new_link_id uuid;
  supabase_url text := 'https://nbcqwpysqgyxrrbgtmkw.supabase.co';
BEGIN
  SELECT external_instance_url, external_instance_name
  INTO contractor_instance_url, contractor_instance_name
  FROM public.profiles
  WHERE id = NEW.contractor_id;

  IF contractor_instance_url IS NOT NULL THEN
    SELECT id INTO existing_link
    FROM public.linked_claims
    WHERE claim_id = NEW.claim_id
      AND external_instance_url = contractor_instance_url;

    IF existing_link IS NULL THEN
      INSERT INTO public.linked_claims (
        claim_id, external_instance_url, instance_name, sync_status
      ) VALUES (
        NEW.claim_id, contractor_instance_url, contractor_instance_name, 'syncing'
      )
      RETURNING id INTO new_link_id;

      PERFORM extensions.http_post(
        url := supabase_url || '/functions/v1/sync-claim-to-external',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw'
        ),
        body := jsonb_build_object(
          'claim_id', NEW.claim_id,
          'target_instance_url', contractor_instance_url,
          'instance_name', contractor_instance_name,
          'include_accounting', true
        )
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;