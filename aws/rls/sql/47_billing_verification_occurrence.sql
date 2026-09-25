-- Additive: typed occurrence_kind on tenant_maintenance_payments.
-- Distinguishes monthly invoices, isolated billing-verification debits, and
-- historical period-null rows. Does not create occurrences, post ACH, or
-- enable monthly / verification production POST.
--
-- Backfill:
--   billing_period present => monthly_subscription
--   billing_period null    => legacy  (includes Freedom penny; never verification)
--
-- New verification rows are inserted by the engine only:
--   occurrence_kind = billing_verification
--   amount_cents    = 100
--   billing_period  IS NULL

ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS occurrence_kind text;

UPDATE public.tenant_maintenance_payments
SET occurrence_kind = CASE
  WHEN billing_period IS NOT NULL AND btrim(billing_period) <> '' THEN 'monthly_subscription'
  ELSE 'legacy'
END
WHERE occurrence_kind IS NULL;

ALTER TABLE public.tenant_maintenance_payments
  ALTER COLUMN occurrence_kind SET DEFAULT 'monthly_subscription';

UPDATE public.tenant_maintenance_payments
SET occurrence_kind = 'legacy'
WHERE occurrence_kind IS NULL;

ALTER TABLE public.tenant_maintenance_payments
  ALTER COLUMN occurrence_kind SET NOT NULL;

ALTER TABLE public.tenant_maintenance_payments
  DROP CONSTRAINT IF EXISTS tenant_maintenance_payments_occurrence_kind_check;

ALTER TABLE public.tenant_maintenance_payments
  ADD CONSTRAINT tenant_maintenance_payments_occurrence_kind_check
  CHECK (occurrence_kind = ANY (ARRAY[
    'monthly_subscription',
    'billing_verification',
    'legacy'
  ]));

ALTER TABLE public.tenant_maintenance_payments
  DROP CONSTRAINT IF EXISTS tenant_maintenance_payments_verification_contract_check;

ALTER TABLE public.tenant_maintenance_payments
  ADD CONSTRAINT tenant_maintenance_payments_verification_contract_check
  CHECK (
    occurrence_kind <> 'billing_verification'
    OR (billing_period IS NULL AND amount_cents = 100)
  );

CREATE UNIQUE INDEX IF NOT EXISTS tenant_maintenance_payments_verification_uidx
  ON public.tenant_maintenance_payments (tenant_id, idempotence_key)
  WHERE occurrence_kind = 'billing_verification';

-- Required for ON CONFLICT (idempotence_key) on verification insert.
-- Harmless if the original UNIQUE column constraint already exists.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_maintenance_payments_idempotence_key_uidx
  ON public.tenant_maintenance_payments (idempotence_key);

COMMENT ON COLUMN public.tenant_maintenance_payments.occurrence_kind IS
  'monthly_subscription = period-keyed invoice; billing_verification = isolated $1 debit; legacy = historical period-null rows including the Freedom penny.';
