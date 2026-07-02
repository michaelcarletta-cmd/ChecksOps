-- checkalt-poll-status silently falls back to the deposit's existing status
-- whenever CheckAlt's /fincapture/deposit/item response doesn't carry a
-- status/statusCode field it recognizes (observed for reference 51283920,
-- whose response only contained ruleDetails, no status field at all). That
-- fallback previously left no trace, so a deposit could be polled
-- indefinitely without anyone knowing the poll was actually a no-op.
ALTER TABLE public.checkalt_deposits
  ADD COLUMN IF NOT EXISTS status_unresolved boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.checkalt_deposits.status_unresolved IS
  'true when the most recent poll of /fincapture/deposit/item returned a response checkalt-poll-status could not map to an internal status (missing/unrecognized status field) — status was left unchanged.';
