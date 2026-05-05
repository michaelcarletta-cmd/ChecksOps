-- Phase 1: New unified check lifecycle stage

-- Enum
DO $$ BEGIN
  CREATE TYPE public.check_stage AS ENUM ('review','loss_draft','endorsing','ready_for_deposit','deposited');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- check_intake_items
ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS check_stage public.check_stage NOT NULL DEFAULT 'review',
  ADD COLUMN IF NOT EXISTS ocr_needs_verification boolean NOT NULL DEFAULT false;

-- claim_checks
ALTER TABLE public.claim_checks
  ADD COLUMN IF NOT EXISTS check_stage public.check_stage NOT NULL DEFAULT 'review',
  ADD COLUMN IF NOT EXISTS ocr_needs_verification boolean NOT NULL DEFAULT false;

-- Backfill check_intake_items.check_stage from legacy text status
UPDATE public.check_intake_items SET check_stage = CASE
  WHEN status IN ('deposited') THEN 'deposited'::public.check_stage
  WHEN status IN ('approved_for_deposit','branch_deposit_required','ready_for_deposit') THEN 'ready_for_deposit'::public.check_stage
  WHEN status IN ('loss_draft_required','loss_draft','mortgage_pending','mortgage_monitoring') THEN 'loss_draft'::public.check_stage
  WHEN status IN ('endorsing','endorsement_pending','awaiting_endorsement') THEN 'endorsing'::public.check_stage
  ELSE 'review'::public.check_stage
END;

UPDATE public.check_intake_items
  SET ocr_needs_verification = true
  WHERE ocr_status IN ('failed','low_confidence','manual_required')
     OR (ocr_status IS NULL AND status IN ('review','needs_review','unverified'));

-- Backfill claim_checks
UPDATE public.claim_checks SET check_stage = CASE
  WHEN deposit_status IN ('deposited','cleared') THEN 'deposited'::public.check_stage
  WHEN deposit_status IN ('ready','ready_for_deposit','approved') THEN 'ready_for_deposit'::public.check_stage
  WHEN endorsement_status IN ('signed','complete','completed') AND deposit_status NOT IN ('deposited','cleared') THEN 'ready_for_deposit'::public.check_stage
  WHEN mortgage_flag = true AND deposit_status IS DISTINCT FROM 'deposited' THEN 'loss_draft'::public.check_stage
  WHEN endorsement_status IN ('pending','sent','requested','in_progress') THEN 'endorsing'::public.check_stage
  ELSE 'review'::public.check_stage
END;

CREATE INDEX IF NOT EXISTS idx_check_intake_items_stage ON public.check_intake_items(check_stage);
CREATE INDEX IF NOT EXISTS idx_claim_checks_stage ON public.claim_checks(check_stage);