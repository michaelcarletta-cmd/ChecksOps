-- Add dedicated OCR heartbeat field for stale-lock detection
ALTER TABLE public.check_intake_items
ADD COLUMN IF NOT EXISTS ocr_heartbeat_at timestamptz DEFAULT NULL;