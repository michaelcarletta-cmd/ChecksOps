-- Staging follow-up after idempotency columns+index.
-- Allow email_send_log.status = 'sunk' so PR #223 finalizeClaimedLog can persist
-- sink outcomes without aborting the request transaction.
--
-- Live CHECK currently:
--   pending, sent, suppressed, failed, bounced, complained, dlq
-- Application sink path writes 'sunk'. A failing UPDATE aborts the transaction,
-- and withIdentity COMMIT then discards the pending reservation.
--
-- Do not rewrite historical rows. Fail closed if the live CHECK is unexpected.

BEGIN;

DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'public.email_send_log'::regclass
    AND conname = 'email_send_log_status_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'email_send_log_status_check missing';
  END IF;

  IF def LIKE '%sunk%' THEN
    RETURN;
  END IF;

  IF def NOT LIKE '%pending%'
     OR def NOT LIKE '%sent%'
     OR def NOT LIKE '%suppressed%'
     OR def NOT LIKE '%failed%'
     OR def NOT LIKE '%bounced%'
     OR def NOT LIKE '%complained%'
     OR def NOT LIKE '%dlq%' THEN
    RAISE EXCEPTION 'unexpected email_send_log_status_check: %', def;
  END IF;

  ALTER TABLE public.email_send_log DROP CONSTRAINT email_send_log_status_check;
  ALTER TABLE public.email_send_log
    ADD CONSTRAINT email_send_log_status_check
    CHECK (status IN (
      'pending', 'sent', 'sunk', 'suppressed', 'failed', 'bounced', 'complained', 'dlq'
    ));
END $$;

COMMIT;
