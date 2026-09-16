-- AWS RDS lock-in matching verified staging endorsement state (2026-09-16).
-- Staging already has this state. Do not apply to production from this PR.
-- Do not apply SQL 40.
-- Do not drop public.advance_check_on_endorsement_complete().
-- Do not touch trg_hle_endorsement_insert or trg_hle_endorsement_update.
-- Automatic Ready remains an application concern gated by AWS_ENDORSEMENT_AUTO_ADVANCE.

-- 1. Permit signature_method = in_person (idempotent).
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.check_endorsements'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%signature_method%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%in_person%'
  LOOP
    EXECUTE format('ALTER TABLE public.check_endorsements DROP CONSTRAINT %I', rec.conname);
    EXECUTE $sql$
      ALTER TABLE public.check_endorsements
        ADD CONSTRAINT check_endorsements_signature_method_check
        CHECK (signature_method IN ('portal','sms','email','internal','manual','in_person'))
    $sql$;
  END LOOP;
END $$;

-- 2. Column-level UPDATE for official-rear versioning. deposit_recommendation
--    UPDATE already exists on staging; this file does not grant it again.
GRANT UPDATE (endorsement_render_version)
  ON TABLE public.check_intake_items
  TO checksops, authenticated;

-- 3. Remove the inherited Ready controller. Application #331 owns Ready.
DROP TRIGGER IF EXISTS trg_advance_on_endorsement_complete ON public.check_endorsements;

-- public.advance_check_on_endorsement_complete() is intentionally preserved.
