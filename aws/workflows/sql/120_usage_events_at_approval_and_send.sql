-- AWS: usage events at Check Alt approval and at send time (SQL 120).
-- Forward migration on top of SQL 98 (tenant fee collection) and SQL 96 (tenant pricing).
-- AWS only: nothing under supabase/migrations changes.
--
-- Why (owner, 2026-10-27): "I processed 1 check this month and it didn't
-- register on freedom usage", and "when a user chooses same day or next day
-- that cost of $0.75 or $1.00 should automatically show up on their usage and
-- for what claim check". Owner rule: "we don't want users being charged if the
-- check didn't go thru".
--
--   - SQL 98's record_check_billing_event records check_processing only when a
--     check_intake_items row becomes 'deposited'. A check deposited through
--     Check Alt never reaches 'deposited' (its checkalt_deposits row goes
--     submitted, then cleared), so it was never counted.
--   - The next-day / same-day fee was only computed at month end
--     (tenant-billing-engine.mjs persistMoovUsageForPeriod), so the usage page
--     showed nothing for it during the month and never named the check.
--
-- 1) public.aws_check_processing_price_cents(tenant uuid) (new, STABLE,
--    SECURITY DEFINER): SQL 98's per-check price rule, unchanged: the tenant's
--    per_check_rate_cents when per-check billing is on and a rate is set; NULL
--    (no fee) when it is off and aws_check_billing_charges_when_per_check_off()
--    is false; otherwise aws_check_billing_default_price_cents().
-- 2) public.aws_record_checkalt_billing_event() (new trigger function,
--    SECURITY DEFINER) and trigger aws_checkalt_deposit_billing_event, AFTER
--    INSERT OR UPDATE OF status on public.checkalt_deposits:
--      a. When a deposit becomes approved or accepted (status 'submitted' or
--         'cleared', from any other status) and names its check, records one
--         check_processing event for the check (the same row SQL 98 records,
--         one per check: an existing event is kept; a voided, uninvoiced one is
--         recorded again). Tenant: the deposit's tenant_id, else the check's.
--      b. When a deposit is rejected, errors or is a duplicate (status
--         'rejected', 'error', 'duplicate') after it was approved, the check's
--         uninvoiced check_processing event is voided, unless another deposit
--         of the check is approved or accepted or the check is 'deposited'.
--      Returned deposits are not voided: a return is its own fee (later work).
-- 3) public.aws_send_speed_fee_type(speed text) (new, IMMUTABLE): the event
--    type of a send's delivery speed, as feeTypeForTransfer
--    (tenant-billing-engine.mjs): same_day -> moov_same_day; standard
--    (next day) -> moov_next_day; instant or unknown -> NULL (no fee here).
--    public.aws_send_speed_fee_cents(tenant uuid, event_type text) (new,
--    STABLE, SECURITY DEFINER): the tenant's next_day_rate_cents /
--    same_day_rate_cents, else 75 / 100 (DEFAULT_NEXT_DAY_RATE_CENTS,
--    DEFAULT_SAME_DAY_RATE_CENTS).
-- 4) public.aws_record_send_speed_fee() (new trigger function, SECURITY
--    DEFINER) and trigger aws_payment_transfer_send_speed_fee, AFTER INSERT OR
--    UPDATE OF status on public.payment_transfers. Only send legs
--    (leg_role 'send_wallet' or 'send_bank', moov-send.mjs) for a check
--    (check_id set). One recipient of one send is one fee: its legs share
--    provider_metadata request_hash and recipient_index (a wallet leg and a
--    bank top-up leg for the same recipient are one payment).
--      a. When a leg leaves 'ready' for any status but failed or canceled (it
--         was posted), records one event for the recipient, unless one exists:
--         event_type from the speed, unit price from 3), payment_transfer_id =
--         that leg, claim_id = the check's claim, source_kind = the event type,
--         source_id = the leg. A voided, uninvoiced event is recorded again.
--         A send that is held (legs stay 'ready') records nothing.
--      b. When a leg fails or is canceled and none of the recipient's legs is
--         posted and not failed or canceled, the recipient's uninvoiced event
--         is voided. Returned transfers are not voided (the payment went out).
-- 5) Unique index check_billing_events_transfer_event_uidx on
--    (payment_transfer_id, event_type) WHERE payment_transfer_id IS NOT NULL,
--    unless a unique index on those columns (and at most tenant_id) exists,
--    and only when no duplicated pair exists (as SQL 98's check index; the
--    guarded tools refuse to run while duplicates exist and none covers them):
--    one fee per leg, whoever writes it (this trigger, or the month-end engine).
-- 6) Backfill from 2026-10-01 (the month the owner reported): approved or
--    accepted Check Alt deposits with no check_processing event for their
--    check, and posted, not failed or canceled send legs with no fee for their
--    recipient, each billed at the time it happened (submitted_at, else
--    created_at). Nothing before 2026-10-01 is touched.
--
-- Not changed: no policy, no grant to checksops, no table or column. SQL 98's
-- record_check_billing_event and its trigger are unchanged (a check that
-- becomes 'deposited' after a Check Alt approval keeps its one event). The
-- trigger functions are EXECUTE for their owner only.

-- 1) per-check price ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_check_processing_price_cents(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_enabled boolean;
  v_rate integer;
BEGIN
  SELECT t.per_check_billing_enabled, t.per_check_rate_cents
    INTO v_enabled, v_rate
    FROM public.tenants t
   WHERE t.id = p_tenant_id;

  IF v_enabled IS TRUE AND v_rate IS NOT NULL THEN
    RETURN v_rate;
  ELSIF v_enabled IS NOT TRUE AND NOT public.aws_check_billing_charges_when_per_check_off() THEN
    RETURN NULL;
  END IF;
  RETURN public.aws_check_billing_default_price_cents();
END
$$;
REVOKE ALL ON FUNCTION public.aws_check_processing_price_cents(uuid) FROM PUBLIC;
COMMENT ON FUNCTION public.aws_check_processing_price_cents(uuid) IS
  'SQL 120: the per-check price of SQL 98 (tenant rate when per-check billing is on, else the active default; NULL when no fee applies).';

-- 2) Check Alt approval ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_record_checkalt_billing_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_new text := lower(COALESCE(NEW.status, ''));
  v_old text := CASE WHEN TG_OP = 'UPDATE' THEN lower(COALESCE(OLD.status, '')) ELSE '' END;
  v_tenant uuid;
  v_price integer;
  v_event record;
BEGIN
  IF NEW.check_intake_item_id IS NULL OR v_new = v_old THEN
    RETURN NULL;
  END IF;

  SELECT e.id, e.status, e.invoice_id
    INTO v_event
    FROM public.check_billing_events e
   WHERE e.check_intake_item_id = NEW.check_intake_item_id
     AND e.event_type = 'check_processing'
   ORDER BY e.created_at
   LIMIT 1;

  IF v_new IN ('submitted', 'cleared') AND v_old NOT IN ('submitted', 'cleared') THEN
    IF v_event.id IS NOT NULL THEN
      IF v_event.status = 'voided' AND v_event.invoice_id IS NULL THEN
        UPDATE public.check_billing_events
           SET status = 'recorded', billed_at = now(), updated_at = now()
         WHERE id = v_event.id;
      END IF;
      RETURN NULL;
    END IF;

    v_tenant := COALESCE(
      NEW.tenant_id,
      (SELECT c.tenant_id FROM public.check_intake_items c WHERE c.id = NEW.check_intake_item_id));
    IF v_tenant IS NULL THEN
      RETURN NULL;
    END IF;
    v_price := public.aws_check_processing_price_cents(v_tenant);
    IF v_price IS NULL THEN
      RETURN NULL;
    END IF;

    INSERT INTO public.check_billing_events (
      tenant_id, check_intake_item_id, unit_price_cents, currency, status, event_type
    ) VALUES (
      v_tenant, NEW.check_intake_item_id, v_price, 'usd', 'recorded', 'check_processing'
    )
    ON CONFLICT DO NOTHING;
    RETURN NULL;
  END IF;

  IF v_new IN ('rejected', 'error', 'duplicate') AND v_old IN ('submitted', 'cleared')
     AND v_event.id IS NOT NULL AND v_event.status = 'recorded' AND v_event.invoice_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.checkalt_deposits d
        WHERE d.check_intake_item_id = NEW.check_intake_item_id
          AND d.id <> NEW.id
          AND lower(COALESCE(d.status, '')) IN ('submitted', 'cleared'))
     AND NOT EXISTS (
       SELECT 1 FROM public.check_intake_items c
        WHERE c.id = NEW.check_intake_item_id AND c.status = 'deposited') THEN
    UPDATE public.check_billing_events
       SET status = 'voided', updated_at = now()
     WHERE id = v_event.id;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.aws_record_checkalt_billing_event() FROM PUBLIC;
COMMENT ON FUNCTION public.aws_record_checkalt_billing_event() IS
  'SQL 120: records the check_processing usage event when a Check Alt deposit is approved or accepted (once per check); voids it, uninvoiced, when the deposit is then rejected.';

DROP TRIGGER IF EXISTS aws_checkalt_deposit_billing_event ON public.checkalt_deposits;
CREATE TRIGGER aws_checkalt_deposit_billing_event
  AFTER INSERT OR UPDATE OF status ON public.checkalt_deposits
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_record_checkalt_billing_event();

-- 3) send speed fee -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_send_speed_fee_type(p_speed text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN s IN ('same_day', 'moov_same_day') THEN 'moov_same_day'
    WHEN s IN ('standard', 'next_day', 'moov_next_day', 'ach') THEN 'moov_next_day'
  END
  FROM (SELECT replace(lower(COALESCE(p_speed, 'standard')), '-', '_') AS s) x
$$;
REVOKE ALL ON FUNCTION public.aws_send_speed_fee_type(text) FROM PUBLIC;
COMMENT ON FUNCTION public.aws_send_speed_fee_type(text) IS
  'SQL 120: the usage event type of a send speed (feeTypeForTransfer): moov_same_day, moov_next_day, or NULL (no fee).';

CREATE OR REPLACE FUNCTION public.aws_send_speed_fee_cents(p_tenant_id uuid, p_event_type text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT GREATEST(0, COALESCE(
    (SELECT CASE p_event_type
              WHEN 'moov_same_day' THEN t.same_day_rate_cents
              ELSE t.next_day_rate_cents
            END
       FROM public.tenants t
      WHERE t.id = p_tenant_id),
    CASE p_event_type WHEN 'moov_same_day' THEN 100 ELSE 75 END))
$$;
REVOKE ALL ON FUNCTION public.aws_send_speed_fee_cents(uuid, text) FROM PUBLIC;
COMMENT ON FUNCTION public.aws_send_speed_fee_cents(uuid, text) IS
  'SQL 120: the tenant''s next-day / same-day fee in cents (tenant rate, else 75 / 100).';

-- 4) send fee at send time ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_record_send_speed_fee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_status text := lower(COALESCE(NEW.status, ''));
  v_type text;
  v_hash text := NEW.provider_metadata->>'request_hash';
  v_recipient text := NEW.provider_metadata->>'recipient_index';
  v_event record;
BEGIN
  IF NEW.leg_role IS NULL OR NEW.leg_role NOT IN ('send_wallet', 'send_bank')
     OR NEW.check_id IS NULL OR NEW.tenant_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND v_status = lower(COALESCE(OLD.status, '')) THEN
    RETURN NULL;
  END IF;
  v_type := public.aws_send_speed_fee_type(COALESCE(NEW.requested_speed, NEW.speed));
  IF v_type IS NULL THEN
    RETURN NULL;
  END IF;

  -- The recipient's fee, written on whichever of its legs was posted first.
  SELECT e.id, e.status, e.invoice_id
    INTO v_event
    FROM public.check_billing_events e
    JOIN public.payment_transfers t ON t.id = e.payment_transfer_id
   WHERE e.event_type = v_type
     AND t.tenant_id = NEW.tenant_id
     AND (t.id = NEW.id
          OR (v_hash IS NOT NULL
              AND t.provider_metadata->>'request_hash' = v_hash
              AND t.provider_metadata->>'recipient_index' IS NOT DISTINCT FROM v_recipient))
   ORDER BY e.created_at
   LIMIT 1;

  IF v_status IN ('failed', 'canceled', 'cancelled') THEN
    IF v_event.id IS NOT NULL AND v_event.status = 'recorded' AND v_event.invoice_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.payment_transfers t
          WHERE t.id <> NEW.id
            AND t.tenant_id = NEW.tenant_id
            AND v_hash IS NOT NULL
            AND t.provider_metadata->>'request_hash' = v_hash
            AND t.provider_metadata->>'recipient_index' IS NOT DISTINCT FROM v_recipient
            AND lower(COALESCE(t.status, '')) NOT IN ('draft', 'ready', 'failed', 'canceled', 'cancelled')) THEN
      UPDATE public.check_billing_events
         SET status = 'voided', updated_at = now()
       WHERE id = v_event.id;
    END IF;
    RETURN NULL;
  END IF;

  IF v_status IN ('', 'draft', 'ready') THEN
    RETURN NULL;
  END IF;

  IF v_event.id IS NOT NULL THEN
    IF v_event.status = 'voided' AND v_event.invoice_id IS NULL THEN
      UPDATE public.check_billing_events
         SET status = 'recorded', billed_at = now(), updated_at = now()
       WHERE id = v_event.id;
    END IF;
    RETURN NULL;
  END IF;

  INSERT INTO public.check_billing_events (
    tenant_id, check_intake_item_id, payment_transfer_id, event_type, unit_price_cents,
    currency, status, claim_id, source_kind, source_id
  ) VALUES (
    NEW.tenant_id, NULL, NEW.id, v_type, public.aws_send_speed_fee_cents(NEW.tenant_id, v_type),
    'usd', 'recorded',
    (SELECT c.claim_id FROM public.check_intake_items c WHERE c.id = NEW.check_id),
    v_type, NEW.id
  )
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.aws_record_send_speed_fee() FROM PUBLIC;
COMMENT ON FUNCTION public.aws_record_send_speed_fee() IS
  'SQL 120: records the next-day / same-day fee once per recipient of a send when its first leg is posted (linked to the leg, the check''s claim through the leg); voids it, uninvoiced, when every leg of the recipient failed or was canceled.';

DROP TRIGGER IF EXISTS aws_payment_transfer_send_speed_fee ON public.payment_transfers;
CREATE TRIGGER aws_payment_transfer_send_speed_fee
  AFTER INSERT OR UPDATE OF status ON public.payment_transfers
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_record_send_speed_fee();

-- 5) one fee per leg ------------------------------------------------------------
DO $sql120_transfer_unique$
DECLARE
  v_has_unique boolean;
  v_dupes integer;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'check_billing_events'
       AND i.indisunique
       AND (
         SELECT array_agg(a.attname::text ORDER BY a.attname)
           FROM unnest(i.indkey) AS k(attnum)
           JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       ) <@ ARRAY['event_type', 'payment_transfer_id', 'tenant_id']::text[]
       AND (
         SELECT array_agg(a.attname::text)
           FROM unnest(i.indkey) AS k(attnum)
           JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       ) @> ARRAY['payment_transfer_id', 'event_type']::text[]
  ) INTO v_has_unique;
  IF v_has_unique THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_dupes FROM (
    SELECT 1 FROM public.check_billing_events
     WHERE payment_transfer_id IS NOT NULL
     GROUP BY payment_transfer_id, event_type
    HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE WARNING 'sql120: check_billing_events has % duplicated (payment_transfer_id, event_type) pairs; unique index not added (the trigger still records one fee per recipient)', v_dupes;
    RETURN;
  END IF;
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS check_billing_events_transfer_event_uidx
             ON public.check_billing_events (payment_transfer_id, event_type)
             WHERE payment_transfer_id IS NOT NULL';
END
$sql120_transfer_unique$;

-- 6) backfill from 2026-10-01 ---------------------------------------------------
INSERT INTO public.check_billing_events (
  tenant_id, check_intake_item_id, unit_price_cents, currency, status, event_type, billed_at
)
SELECT a.tenant_id, a.check_intake_item_id, a.price, 'usd', 'recorded', 'check_processing', a.at
  FROM (
    SELECT DISTINCT ON (d.check_intake_item_id)
           COALESCE(d.tenant_id, c.tenant_id) AS tenant_id,
           d.check_intake_item_id,
           public.aws_check_processing_price_cents(COALESCE(d.tenant_id, c.tenant_id)) AS price,
           COALESCE(d.submitted_at, d.created_at) AS at
      FROM public.checkalt_deposits d
      JOIN public.check_intake_items c ON c.id = d.check_intake_item_id
     WHERE lower(COALESCE(d.status, '')) IN ('submitted', 'cleared')
       AND COALESCE(d.submitted_at, d.created_at) >= timestamptz '2026-10-01 00:00:00+00'
       AND NOT EXISTS (
         SELECT 1 FROM public.check_billing_events e
          WHERE e.check_intake_item_id = d.check_intake_item_id
            AND e.event_type = 'check_processing')
     ORDER BY d.check_intake_item_id, COALESCE(d.submitted_at, d.created_at)
  ) a
 WHERE a.tenant_id IS NOT NULL AND a.price IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.check_billing_events (
  tenant_id, check_intake_item_id, payment_transfer_id, event_type, unit_price_cents,
  currency, status, claim_id, source_kind, source_id, billed_at
)
SELECT l.tenant_id, NULL, l.id, l.fee_type, public.aws_send_speed_fee_cents(l.tenant_id, l.fee_type),
       'usd', 'recorded', l.claim_id, l.fee_type, l.id, l.at
  FROM (
    SELECT DISTINCT ON (t.tenant_id, COALESCE(t.provider_metadata->>'request_hash', t.id::text),
                        t.provider_metadata->>'recipient_index')
           t.id, t.tenant_id, c.claim_id,
           public.aws_send_speed_fee_type(COALESCE(t.requested_speed, t.speed)) AS fee_type,
           t.provider_metadata->>'request_hash' AS request_hash,
           t.provider_metadata->>'recipient_index' AS recipient_index,
           COALESCE(t.submitted_at, t.created_at) AS at
      FROM public.payment_transfers t
      LEFT JOIN public.check_intake_items c ON c.id = t.check_id
     WHERE t.leg_role IN ('send_wallet', 'send_bank')
       AND t.check_id IS NOT NULL
       AND t.tenant_id IS NOT NULL
       AND lower(COALESCE(t.status, '')) NOT IN ('', 'draft', 'ready', 'failed', 'canceled', 'cancelled')
       AND COALESCE(t.submitted_at, t.created_at) >= timestamptz '2026-10-01 00:00:00+00'
     ORDER BY t.tenant_id, COALESCE(t.provider_metadata->>'request_hash', t.id::text),
              t.provider_metadata->>'recipient_index', COALESCE(t.submitted_at, t.created_at), t.id
  ) l
 WHERE l.fee_type IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM public.check_billing_events e
       JOIN public.payment_transfers t2 ON t2.id = e.payment_transfer_id
      WHERE e.event_type = l.fee_type
        AND t2.tenant_id = l.tenant_id
        AND (t2.id = l.id
             OR (l.request_hash IS NOT NULL
                 AND t2.provider_metadata->>'request_hash' = l.request_hash
                 AND t2.provider_metadata->>'recipient_index' IS NOT DISTINCT FROM l.recipient_index)))
ON CONFLICT DO NOTHING;
