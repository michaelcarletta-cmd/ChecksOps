-- Proposed additive columns + unique index for send-transactional-email idempotency.
-- Staging RDS applied 2026-09-11 (columns + unique index + later status='sunk' CHECK).
-- Do not apply to production or production-prep.
--
-- Staging email_send_log currently has:
--   id, message_id, template_name, recipient_email, status, error_message,
--   metadata, created_at, tenant_id
-- It does not have idempotency_key / provider / provider_message_id.
--
-- Application code:
--   1. SELECT existing row by idempotency_key; replay without sending if present
--   2. INSERT a pending reservation before the mailer
--   3. Unique violation (23505) replays without sending
--   4. Lookup/claim failure returns 503 when AWS_EMAIL_MODE=ses (real send)
--      and does not block sink / ses-identity
--
-- Apply this before enabling AWS_EMAIL_MODE=ses. Without these columns, a
-- supplied idempotency key fail-closes real SES (503) rather than sending twice.

BEGIN;

ALTER TABLE public.email_send_log
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_message_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_send_log_idempotency_key
  ON public.email_send_log (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

-- Required for PR #223 finalize: sink outcomes use status='sunk'. Without this
-- value the UPDATE aborts the surrounding transaction and COMMIT rolls back the
-- pending reservation (PostgreSQL 25P02). Do not rewrite historical rows.
DO $$
BEGIN
  ALTER TABLE public.email_send_log DROP CONSTRAINT IF EXISTS email_send_log_status_check;
  ALTER TABLE public.email_send_log
    ADD CONSTRAINT email_send_log_status_check
    CHECK (status IN (
      'pending', 'sent', 'sunk', 'suppressed', 'failed', 'bounced', 'complained', 'dlq'
    ));
END $$;

COMMIT;
