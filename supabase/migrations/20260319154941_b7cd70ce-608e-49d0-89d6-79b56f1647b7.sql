-- Add endorsement email customization columns to company_branding
ALTER TABLE public.company_branding 
  ADD COLUMN IF NOT EXISTS endorsement_email_subject text DEFAULT 'Endorsement Required — Check #{check.number}',
  ADD COLUMN IF NOT EXISTS endorsement_email_body text DEFAULT 'An insurance check requires your endorsement before it can be processed. Please review the details below and complete your endorsement.',
  ADD COLUMN IF NOT EXISTS endorsement_reminder_subject text DEFAULT 'Reminder: Endorsement Required — Check #{check.number}',
  ADD COLUMN IF NOT EXISTS endorsement_reminder_body text DEFAULT 'This is a reminder that your endorsement is still needed for the check below. Please take a moment to review and endorse.',
  ADD COLUMN IF NOT EXISTS endorsement_email_header_color text DEFAULT '#1e293b',
  ADD COLUMN IF NOT EXISTS endorsement_email_button_color text DEFAULT '#2563eb';
