-- Proposed additive unique index for send-transactional-email idempotency.
-- NOT APPLIED. Do not run against staging or production in this PR.
--
-- Application code fail-closes on a supplied idempotency_key:
--   1. SELECT existing row; replay without sending if present
--   2. INSERT a pending reservation before the mailer
--   3. Unique violation (23505) replays without sending
--   4. Lookup/claim failure returns 503 and does not send
--
-- This index is the race-safety net for concurrent duplicate keys.
-- Sequential duplicates are already blocked in application code.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_send_log_idempotency_key
  ON public.email_send_log (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

-- Optional: persist sink outcomes without violating the historical CHECK.
-- Skip this ALTER if the live constraint already includes 'sunk'.
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
