-- Add notification tracking to sync queue
ALTER TABLE public.jobnimbus_sync_queue
ADD COLUMN IF NOT EXISTS notification_status text DEFAULT 'none',
ADD COLUMN IF NOT EXISTS notification_details jsonb DEFAULT '{}';

-- Add notification mode preference to profiles
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS jobnimbus_notification_mode text DEFAULT 'task';

-- Fix Lani's profile name
UPDATE public.profiles
SET full_name = 'Lani Hogan'
WHERE id = '3444b12f-ea67-4ead-bbfd-84702d5d1bb0'
AND full_name = 'Condition One Commercial';