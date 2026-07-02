ALTER TABLE public.checkalt_deposits
  ADD COLUMN IF NOT EXISTS status_unresolved boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.checkalt_deposits.status_unresolved IS
  'true when the most recent poll of /fincapture/deposit/item returned a response checkalt-poll-status could not map to an internal status (missing/unrecognized status field) — status was left unchanged.';