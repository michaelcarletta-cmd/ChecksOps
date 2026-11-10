-- AWS: invoice fee and failed deposit fee usage events (SQL 149).
-- Forward migration on top of SQL 98 (tenant fee collection) and SQL 120 (usage events at
-- approval and send). AWS only: nothing under supabase/migrations changes.
--
-- Why (owner, 2026-11-10): the SaaS Subscription Agreement charges "$0.30 per invoice sent"
-- (section 3.6) and "$2.00 per failed deposit" (section 3.7), but nothing records either fee,
-- so neither shows on Settings -> Usage or on the monthly invoice. A failed deposit only
-- voids the $4.00 check fee (SQL 120) and charges nothing in its place.
--
--   Agreement 3.6: "Thirty Cents ($0.30) for each invoice Subscriber sends through the
--   Platform, recorded when the invoice is sent. Invoices ChecksOps sends to Subscriber for
--   fees under this Agreement carry no Invoice Fee."
--   Agreement 3.7: "Two Dollars ($2.00) for each Check deposit submitted through the Platform
--   that is rejected, returned, or otherwise fails, recorded when the failure is reported.
--   The Failed Deposit Fee applies in place of the Check Processing Fee for that failed
--   deposit; if the Check is later deposited successfully, the Check Processing Fee applies
--   to that deposit."
--
-- 1) public.tenant_usage_fee_launch (new, one row): launched_at, set when this file is
--    first applied (re-runs keep it). Neither fee is charged for anything that happened
--    before it: no backfill. RLS on, no policy, no grant: only the definer functions below
--    and the table owner read it.
-- 2) public.aws_invoice_fee_cents() = 30 and public.aws_failed_deposit_fee_cents() = 200
--    (new, IMMUTABLE): the agreement's rates. The API mirrors them
--    (tenant-billing-engine.mjs DEFAULT_INVOICE_FEE_CENTS, DEFAULT_FAILED_DEPOSIT_FEE_CENTS).
--    No per-tenant rate yet (a later reviewed change, with the Billing tab).
-- 3) public.aws_record_invoice_fee() (new trigger function, SECURITY DEFINER) and trigger
--    aws_moov_invoice_fee, AFTER INSERT OR UPDATE OF sent_at ON public.moov_invoices
--    (Payments -> Invoices, the tenant's invoices to its own customers; ChecksOps' fee
--    invoices to tenants are emails from tenant_fee_invoice_outbox and are never here):
--    when sent_at is first set (NULL -> a time, or an insert that carries one) and is not
--    before the launch, records one invoice_sent event: unit price 2), billed_at = sent_at,
--    claim_id = the invoice's claim, source_kind 'moov_invoice', source_id = the invoice,
--    check_intake_item_id NULL. A resend, a sync or a cancel records nothing more: one fee
--    per invoice.
-- 4) public.aws_record_failed_deposit_fee() (new trigger function, SECURITY DEFINER) and
--    trigger aws_checkalt_deposit_failed_fee, AFTER INSERT OR UPDATE OF status ON
--    public.checkalt_deposits: when a deposit that names its check enters a failed status
--    (rejected, error, duplicate, returned: the statuses SQL 120 and SQL 123 treat as "did
--    not go through" plus a bank return) from any other status, records one failed_deposit
--    event for THAT deposit: unit price 2), billed_at now() (when the failure is reported),
--    claim_id = the check's claim, source_kind 'checkalt_deposit', source_id = the deposit,
--    check_intake_item_id NULL (so a check whose deposit fails twice is charged twice, one
--    per deposit, as 3.7 says; the check is the deposit's). Tenant: the deposit's
--    tenant_id, else the check's.
--    SQL 120 is unchanged: on rejected / error / duplicate after approval it still voids the
--    check's uninvoiced check_processing event, so the $2.00 replaces the $4.00; a later
--    approved deposit of the check records the check fee again. A returned deposit keeps
--    its check fee (SQL 120: "a return is its own fee") and now also carries this one.
-- 5) Unique index check_billing_events_usage_source_uidx on (source_kind, source_id,
--    event_type) WHERE event_type IN ('invoice_sent', 'failed_deposit'): one fee per invoice
--    and per deposit, whoever writes it.
-- 6) public.tenant_maintenance_payments gains invoice_fee_count, invoice_fee_amount_cents,
--    failed_deposit_count, failed_deposit_amount_cents (integer NOT NULL DEFAULT 0), the
--    monthly invoice's breakdown of the two fees, beside the existing check / next-day /
--    same-day / Mortgage Ops columns. usage_total_cents and amount_cents already carry them.
--
-- Not changed: no policy, no grant to checksops, no existing function or trigger. The new
-- events are rows of public.check_billing_events like every other fee, so
-- get_tenant_check_usage (SQL 126) lists them on Settings -> Usage as it is. The trigger
-- functions are EXECUTE for their owner only.
--
-- Refuses to run (55000 sql149_prerequisite_missing) without check_billing_events (with
-- source_kind, source_id, claim_id), checkalt_deposits, moov_invoices,
-- tenant_maintenance_payments and SQL 120's aws_record_checkalt_billing_event. Idempotent.
-- No BEGIN/COMMIT: the guarded SQL executor runs it in one transaction. Not applied by this
-- change.

DO $sql149_prerequisites$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.check_billing_events') IS NULL THEN v_missing := array_append(v_missing, 'public.check_billing_events'); END IF;
  IF to_regclass('public.checkalt_deposits') IS NULL THEN v_missing := array_append(v_missing, 'public.checkalt_deposits'); END IF;
  IF to_regclass('public.moov_invoices') IS NULL THEN v_missing := array_append(v_missing, 'public.moov_invoices'); END IF;
  IF to_regclass('public.check_intake_items') IS NULL THEN v_missing := array_append(v_missing, 'public.check_intake_items'); END IF;
  IF to_regclass('public.tenant_maintenance_payments') IS NULL THEN v_missing := array_append(v_missing, 'public.tenant_maintenance_payments'); END IF;
  IF to_regprocedure('public.aws_record_checkalt_billing_event()') IS NULL THEN
    v_missing := array_append(v_missing, 'public.aws_record_checkalt_billing_event() (SQL 120)');
  END IF;
  IF to_regclass('public.check_billing_events') IS NOT NULL AND (
       SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'check_billing_events'
          AND column_name IN ('source_kind', 'source_id', 'claim_id', 'event_type')) <> 4 THEN
    v_missing := array_append(v_missing, 'check_billing_events.source_kind/source_id/claim_id/event_type');
  END IF;
  IF to_regclass('public.moov_invoices') IS NOT NULL AND (
       SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'moov_invoices'
          AND column_name IN ('tenant_id', 'sent_at', 'claim_id')) <> 3 THEN
    v_missing := array_append(v_missing, 'moov_invoices.tenant_id/sent_at/claim_id');
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'sql149_prerequisite_missing: %', array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$sql149_prerequisites$;

-- 1) launch ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_usage_fee_launch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  launched_at timestamptz NOT NULL DEFAULT now(),
  note text
);
ALTER TABLE public.tenant_usage_fee_launch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_usage_fee_launch FROM PUBLIC;
INSERT INTO public.tenant_usage_fee_launch (singleton, launched_at, note)
VALUES (true, now(), 'SQL 149: invoice fee and failed deposit fee recorded from this time')
ON CONFLICT (singleton) DO NOTHING;
COMMENT ON TABLE public.tenant_usage_fee_launch IS
  'SQL 149: when the invoice fee and failed deposit fee started (set once, at first apply). Nothing before it is charged.';

CREATE OR REPLACE FUNCTION public.aws_usage_fee_launched_at()
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT l.launched_at FROM public.tenant_usage_fee_launch l WHERE l.singleton
$$;
REVOKE ALL ON FUNCTION public.aws_usage_fee_launched_at() FROM PUBLIC;
COMMENT ON FUNCTION public.aws_usage_fee_launched_at() IS
  'SQL 149: the launch time of the invoice fee and failed deposit fee (NULL: not launched, nothing is charged).';

-- 2) rates -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_invoice_fee_cents()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT 30 $$;
REVOKE ALL ON FUNCTION public.aws_invoice_fee_cents() FROM PUBLIC;
COMMENT ON FUNCTION public.aws_invoice_fee_cents() IS
  'SQL 149: the invoice fee in cents (agreement 3.6, $0.30 per invoice sent).';

CREATE OR REPLACE FUNCTION public.aws_failed_deposit_fee_cents()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT 200 $$;
REVOKE ALL ON FUNCTION public.aws_failed_deposit_fee_cents() FROM PUBLIC;
COMMENT ON FUNCTION public.aws_failed_deposit_fee_cents() IS
  'SQL 149: the failed deposit fee in cents (agreement 3.7, $2.00 per failed deposit).';

-- 3) invoice fee -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_record_invoice_fee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_launch timestamptz;
BEGIN
  IF NEW.sent_at IS NULL OR NEW.tenant_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.sent_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  v_launch := public.aws_usage_fee_launched_at();
  IF v_launch IS NULL OR NEW.sent_at < v_launch THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.check_billing_events e
     WHERE e.source_kind = 'moov_invoice' AND e.source_id = NEW.id AND e.event_type = 'invoice_sent') THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.check_billing_events (
    tenant_id, check_intake_item_id, event_type, unit_price_cents, currency, status,
    billed_at, claim_id, source_kind, source_id
  ) VALUES (
    NEW.tenant_id, NULL, 'invoice_sent', public.aws_invoice_fee_cents(), 'usd', 'recorded',
    NEW.sent_at, NEW.claim_id, 'moov_invoice', NEW.id
  )
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.aws_record_invoice_fee() FROM PUBLIC;
COMMENT ON FUNCTION public.aws_record_invoice_fee() IS
  'SQL 149: records the $0.30 invoice fee once per invoice when it is first sent (sent_at set), from the launch on.';

DROP TRIGGER IF EXISTS aws_moov_invoice_fee ON public.moov_invoices;
CREATE TRIGGER aws_moov_invoice_fee
  AFTER INSERT OR UPDATE OF sent_at ON public.moov_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_record_invoice_fee();

-- 4) failed deposit fee ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_record_failed_deposit_fee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_new text := lower(COALESCE(NEW.status, ''));
  v_old text := CASE WHEN TG_OP = 'UPDATE' THEN lower(COALESCE(OLD.status, '')) ELSE '' END;
  v_failed constant text[] := ARRAY['rejected', 'error', 'duplicate', 'returned'];
  v_launch timestamptz;
  v_tenant uuid;
  v_claim uuid;
BEGIN
  IF NEW.check_intake_item_id IS NULL OR NOT (v_new = ANY (v_failed)) OR v_old = ANY (v_failed) THEN
    RETURN NULL;
  END IF;
  v_launch := public.aws_usage_fee_launched_at();
  IF v_launch IS NULL OR now() < v_launch THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.check_billing_events e
     WHERE e.source_kind = 'checkalt_deposit' AND e.source_id = NEW.id AND e.event_type = 'failed_deposit') THEN
    RETURN NULL;
  END IF;

  SELECT c.tenant_id, c.claim_id INTO v_tenant, v_claim
    FROM public.check_intake_items c
   WHERE c.id = NEW.check_intake_item_id;
  v_tenant := COALESCE(NEW.tenant_id, v_tenant);
  IF v_tenant IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.check_billing_events (
    tenant_id, check_intake_item_id, event_type, unit_price_cents, currency, status,
    billed_at, claim_id, source_kind, source_id
  ) VALUES (
    v_tenant, NULL, 'failed_deposit', public.aws_failed_deposit_fee_cents(), 'usd', 'recorded',
    now(), v_claim, 'checkalt_deposit', NEW.id
  )
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.aws_record_failed_deposit_fee() FROM PUBLIC;
COMMENT ON FUNCTION public.aws_record_failed_deposit_fee() IS
  'SQL 149: records the $2.00 failed deposit fee once per Check Alt deposit when it is rejected, errors, is a duplicate or is returned, from the launch on.';

DROP TRIGGER IF EXISTS aws_checkalt_deposit_failed_fee ON public.checkalt_deposits;
CREATE TRIGGER aws_checkalt_deposit_failed_fee
  AFTER INSERT OR UPDATE OF status ON public.checkalt_deposits
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_record_failed_deposit_fee();

-- 5) one fee per invoice and per deposit -----------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS check_billing_events_usage_source_uidx
  ON public.check_billing_events (source_kind, source_id, event_type)
  WHERE event_type IN ('invoice_sent', 'failed_deposit');

-- 6) monthly invoice breakdown ---------------------------------------------------
ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS invoice_fee_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invoice_fee_amount_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_deposit_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_deposit_amount_cents integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.tenant_maintenance_payments.invoice_fee_count IS
  'SQL 149: invoices sent in the period (invoice_sent usage events).';
COMMENT ON COLUMN public.tenant_maintenance_payments.failed_deposit_count IS
  'SQL 149: failed deposits in the period (failed_deposit usage events).';
