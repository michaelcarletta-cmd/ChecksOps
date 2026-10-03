-- Staging email_send_log.status CHECK: complete legitimate set, not a sunk-only patch.
-- Staging RDS applied 2026-09-11. Do not apply to production or production-prep.
--
-- Current AWS writers persist:
--   pending (idempotency reservation)
--   sent    (SES success)
--   sunk    (sink / lock rewrite)
--   failed  (SES catch; delivery may be sink_fallback — that is NOT a status)
--   suppressed
--
-- Original table vocabulary still present in live data / CHECK:
--   bounced, complained, dlq
-- Live data on 2026-09-11: pending=70, sent=65, dlq=5, sunk>=0.
--
-- Not permitted: sink_fallback (mailer delivery field only).
-- Fail closed if live rows or the current CHECK contain any other status.

BEGIN;

DO $$
DECLARE
  def text;
  unexpected int;
  allowed text[] := ARRAY[
    'pending', 'sent', 'sunk', 'suppressed', 'failed', 'bounced', 'complained', 'dlq'
  ];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'public.email_send_log'::regclass
    AND conname = 'email_send_log_status_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'email_send_log_status_check missing';
  END IF;

  SELECT count(*) INTO unexpected
  FROM public.email_send_log
  WHERE status IS NULL OR status <> ALL (allowed);

  IF unexpected > 0 THEN
    RAISE EXCEPTION 'email_send_log has % row(s) with status outside allowed set', unexpected;
  END IF;

  IF def LIKE '%sink_fallback%' THEN
    RAISE EXCEPTION 'refusing CHECK that treats sink_fallback as a status: %', def;
  END IF;

  ALTER TABLE public.email_send_log DROP CONSTRAINT email_send_log_status_check;
  ALTER TABLE public.email_send_log
    ADD CONSTRAINT email_send_log_status_check
    CHECK (status IN (
      'pending', 'sent', 'sunk', 'suppressed', 'failed', 'bounced', 'complained', 'dlq'
    ));
END $$;

COMMIT;
