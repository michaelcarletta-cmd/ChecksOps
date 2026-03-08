
-- Add endorsement_packet_path to check_intake_items
ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS endorsement_packet_path text;

-- Create storage bucket for endorsement packets
INSERT INTO storage.buckets (id, name, public)
VALUES ('endorsement-packets', 'endorsement-packets', false)
ON CONFLICT (id) DO NOTHING;

-- RLS: authenticated users can read endorsement packets
CREATE POLICY "Authenticated users can read endorsement packets"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'endorsement-packets');

-- RLS: service role can insert (edge function uses service role)
CREATE POLICY "Service role can insert endorsement packets"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'endorsement-packets');
