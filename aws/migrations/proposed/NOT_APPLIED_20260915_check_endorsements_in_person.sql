-- NOT APPLIED. Do not run against production or staging from this PR.
-- Smallest safe constraint update so signature_method = 'in_person' is legal
-- if the inherited Lovable CHECK is still present on AWS RDS.
--
-- Verify first:
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'public.check_endorsements'::regclass
--     AND contype = 'c';

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT conname, pg_get_constraintdef(oid) AS def
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
