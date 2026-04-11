-- Remove duplicate trigger on claim_updates (keep the newer, better one)
DROP TRIGGER IF EXISTS trg_queue_note_to_jobnimbus ON claim_updates;

-- Remove duplicate trigger on claim_files (keep trigger_jobnimbus_file_sync)
DROP TRIGGER IF EXISTS queue_jobnimbus_file_sync ON claim_files;

-- Drop the now-unused function
DROP FUNCTION IF EXISTS queue_claim_update_to_jobnimbus();