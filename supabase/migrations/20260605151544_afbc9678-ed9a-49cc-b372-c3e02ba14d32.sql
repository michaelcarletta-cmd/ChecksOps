-- Add tracking columns
ALTER TABLE public.deposit_items ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.deposit_items ADD COLUMN IF NOT EXISTS provider_status_raw JSONB;
ALTER TABLE public.disbursement_batches ADD COLUMN IF NOT EXISTS reserve_released_at TIMESTAMP WITH TIME ZONE;
