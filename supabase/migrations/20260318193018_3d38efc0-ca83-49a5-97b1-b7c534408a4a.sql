
-- Create the backup bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('claim-files-backup', 'claim-files-backup', false)
ON CONFLICT (id) DO NOTHING;

-- RLS: only service role should access backup bucket (no public policies)
-- Admin read access for disaster recovery
CREATE POLICY "Admins can view backup files"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'claim-files-backup'
  AND has_role(auth.uid(), 'admin'::app_role)
);

-- Create a table to track backup status
CREATE TABLE IF NOT EXISTS public.storage_backup_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_bucket text NOT NULL,
  source_path text NOT NULL,
  backup_bucket text NOT NULL,
  backup_path text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE public.storage_backup_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view backup logs"
ON public.storage_backup_log FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

-- Create function to notify edge function when a file is uploaded to claim-files
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

    -- Fire off edge function via pg_net
    PERFORM net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1) || '/functions/v1/storage-backup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_service_role_key' LIMIT 1)
      ),
      body := jsonb_build_object(
        'bucket', 'claim-files',
        'path', NEW.name
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

-- Attach trigger to storage.objects
CREATE TRIGGER on_file_upload_backup
  AFTER INSERT ON storage.objects
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_file_backup();
