
-- Enable extensions for cron
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Trigger for claim notes/updates
CREATE OR REPLACE FUNCTION public.queue_jobnimbus_note_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.claim_id IS NOT NULL THEN
    INSERT INTO jobnimbus_sync_queue (claim_id, contractor_id, sync_type, status, payload)
    VALUES (
      NEW.claim_id,
      NULL,
      'note',
      'pending',
      jsonb_build_object('data', jsonb_build_object(
        'content', COALESCE(NEW.content, ''),
        'source_table', TG_TABLE_NAME,
        'source_id', NEW.id
      ))
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_jobnimbus_note_sync ON claim_updates;
CREATE TRIGGER trigger_jobnimbus_note_sync
  AFTER INSERT ON claim_updates
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_jobnimbus_note_sync();

DROP TRIGGER IF EXISTS trigger_jobnimbus_comm_sync ON claim_communications_diary;
CREATE TRIGGER trigger_jobnimbus_comm_sync
  AFTER INSERT ON claim_communications_diary
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_jobnimbus_note_sync();

-- Trigger for file uploads
CREATE OR REPLACE FUNCTION public.queue_jobnimbus_file_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.claim_id IS NOT NULL THEN
    INSERT INTO jobnimbus_sync_queue (claim_id, contractor_id, sync_type, status, payload)
    VALUES (
      NEW.claim_id,
      NULL,
      'file',
      'pending',
      jsonb_build_object('data', jsonb_build_object(
        'file_name', COALESCE(NEW.file_name, 'file'),
        'file_path', COALESCE(NEW.file_path, ''),
        'source_id', NEW.id
      ))
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_jobnimbus_file_sync ON claim_files;
CREATE TRIGGER trigger_jobnimbus_file_sync
  AFTER INSERT ON claim_files
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_jobnimbus_file_sync();

-- Trigger for inspections
CREATE OR REPLACE FUNCTION public.queue_jobnimbus_inspection_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.claim_id IS NOT NULL THEN
    INSERT INTO jobnimbus_sync_queue (claim_id, contractor_id, sync_type, status, payload)
    VALUES (
      NEW.claim_id,
      NULL,
      'task',
      'pending',
      jsonb_build_object('data', jsonb_build_object(
        'title', COALESCE(NEW.inspection_type, 'Inspection') || ' - ' || COALESCE(NEW.inspection_date::text, 'TBD'),
        'description', 'Inspector: ' || COALESCE(NEW.inspector_name, 'TBD') || '. Notes: ' || COALESCE(NEW.notes, ''),
        'due_date', NEW.inspection_date,
        'status', COALESCE(NEW.status, 'scheduled'),
        'source_id', NEW.id
      ))
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_jobnimbus_inspection_sync ON inspections;
CREATE TRIGGER trigger_jobnimbus_inspection_sync
  AFTER INSERT OR UPDATE ON inspections
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_jobnimbus_inspection_sync();
