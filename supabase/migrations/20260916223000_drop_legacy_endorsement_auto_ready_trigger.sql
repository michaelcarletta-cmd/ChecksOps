-- Follow-on lock so a full supabase/migration replay cannot leave
-- trg_advance_on_endorsement_complete as an active Ready controller.
-- Do not apply to production from this PR. Staging AWS already dropped the trigger.
-- Preserve public.advance_check_on_endorsement_complete().
-- Do not touch trg_hle_endorsement_insert or trg_hle_endorsement_update.

DROP TRIGGER IF EXISTS trg_advance_on_endorsement_complete ON public.check_endorsements;

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
