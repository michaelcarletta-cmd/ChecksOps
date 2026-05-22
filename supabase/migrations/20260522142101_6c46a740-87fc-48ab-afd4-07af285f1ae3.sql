ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS check_source text NOT NULL DEFAULT 'insurance'
    CHECK (check_source IN ('insurance', 'cash_job')),
  ADD COLUMN IF NOT EXISTS cash_job_id uuid REFERENCES public.cash_jobs(id),
  ADD COLUMN IF NOT EXISTS cash_job_payment_class text
    CHECK (cash_job_payment_class IN ('initial_deposit', 'final_payment', 'progress_payment', 'other'));

CREATE INDEX IF NOT EXISTS idx_check_intake_items_cash_job_id
  ON public.check_intake_items(cash_job_id)
  WHERE cash_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_cash_job_check_payment()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_existing_payment_id uuid;
BEGIN
  IF NEW.check_source != 'cash_job' THEN RETURN NEW; END IF;
  IF NEW.cash_job_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status != 'deposited' THEN RETURN NEW; END IF;
  IF OLD.status = 'deposited' THEN RETURN NEW; END IF;

  SELECT id INTO v_existing_payment_id
    FROM public.cash_job_payments
    WHERE cash_job_id = NEW.cash_job_id
      AND reference_number = NEW.id::text
    LIMIT 1;

  IF v_existing_payment_id IS NOT NULL THEN RETURN NEW; END IF;

  INSERT INTO public.cash_job_payments (
    tenant_id, cash_job_id, created_by,
    amount, payment_method, payment_date,
    reference_number, notes
  ) VALUES (
    NEW.tenant_id, NEW.cash_job_id, NEW.uploaded_by,
    COALESCE(NEW.amount, 0), 'check', CURRENT_DATE,
    NEW.id::text,
    CASE NEW.cash_job_payment_class
      WHEN 'initial_deposit' THEN 'Initial deposit check via ChecksOps'
      WHEN 'final_payment' THEN 'Final payment check via ChecksOps'
      WHEN 'progress_payment' THEN 'Progress payment check via ChecksOps'
      ELSE 'Check deposit via ChecksOps'
    END
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sync_cash_job_check_payment ON public.check_intake_items;
CREATE TRIGGER trg_sync_cash_job_check_payment
  AFTER UPDATE OF status ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.sync_cash_job_check_payment();