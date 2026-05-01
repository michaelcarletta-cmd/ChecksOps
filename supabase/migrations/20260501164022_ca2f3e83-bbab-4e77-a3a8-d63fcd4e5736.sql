CREATE OR REPLACE FUNCTION public.notify_file_backup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.bucket_id = 'claim-files' THEN
    INSERT INTO public.storage_backup_log (source_bucket, source_path, backup_bucket, backup_path, status)
    VALUES ('claim-files', NEW.name, 'claim-files-backup', NEW.name, 'pending');

    PERFORM net.http_post(
      url := 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/storage-backup',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw"}'::jsonb,
      body := jsonb_build_object('bucket', 'claim-files', 'path', NEW.name)
    );
  END IF;
  RETURN NEW;
END;
$fn$;