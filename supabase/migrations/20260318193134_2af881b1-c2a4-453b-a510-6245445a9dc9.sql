
-- Drop and recreate the trigger function with hardcoded project URL
CREATE OR REPLACE FUNCTION public.notify_file_backup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.bucket_id = 'claim-files' THEN
    -- Insert a pending backup record
    INSERT INTO public.storage_backup_log (source_bucket, source_path, backup_bucket, backup_path, status)
    VALUES ('claim-files', NEW.name, 'claim-files-backup', NEW.name, 'pending');

    -- Fire off edge function via pg_net using known project URL and anon key
    PERFORM net.http_post(
      url := 'https://yvagrvfkeuvzjezfsbun.supabase.co/functions/v1/storage-backup',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2YWdydmZrZXV2emplemZzYnVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NzcyMjUsImV4cCI6MjA4NzQ1MzIyNX0.1Jgm-plSdEFFnPrtA492s0jH-GQcCN08WplZS_VrtEg"}'::jsonb,
      body := jsonb_build_object(
        'bucket', 'claim-files',
        'path', NEW.name
      )
    );
  END IF;
  RETURN NEW;
END;
$$;
