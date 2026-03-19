-- Add email customization columns to company_branding
ALTER TABLE public.company_branding 
  ADD COLUMN IF NOT EXISTS esign_email_header_color text DEFAULT '#1a56db',
  ADD COLUMN IF NOT EXISTS esign_email_button_color text DEFAULT '#1a56db';
