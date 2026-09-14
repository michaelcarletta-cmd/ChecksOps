-- Lock the 8 repaired production Cognito mappings against staging/rehearsal/test writes.
-- Does NOT change tenant memberships, roles, profiles, MFA, provider IDs, or financial data.
-- Authorized production identity repair must set:
--   SELECT set_config('request.production_identity_write', '1', true);
-- Staging oneshots and tenant-admin must never set that GUC.

SELECT set_config('request.production_identity_write', '1', true);

CREATE TABLE IF NOT EXISTS public.identity_production_cognito_locks (
  application_user_id uuid PRIMARY KEY
    REFERENCES public.identity_accounts (application_user_id),
  cognito_sub text NOT NULL
);

COMMENT ON TABLE public.identity_production_cognito_locks IS
  'Production Cognito mappings that staging/rehearsal/test writers cannot change.';

REVOKE ALL ON TABLE public.identity_production_cognito_locks FROM PUBLIC;
GRANT SELECT ON TABLE public.identity_production_cognito_locks TO checksops;

DO $$
DECLARE
  matched int;
BEGIN
  SELECT count(*) INTO matched
  FROM (VALUES
    ('0160a5f3-30a4-4aba-8e54-6529f1ceb0d4'::uuid, 'd418a4f8-80f1-70d6-36c9-fe490220bf4a'),
    ('30d0505c-bcfa-4732-81fd-869dc46da5dd'::uuid, '34388468-a021-7036-c34d-2ff14a20ed40'),
    ('3af0234c-de1b-4819-938d-fa4f9390811b'::uuid, '24d874d8-80d1-7092-7f34-48b8704702f8'),
    ('7dbb3009-f059-4767-b5dc-1c5c72379330'::uuid, 'a45884b8-d051-70b3-b19d-ca704964c6e8'),
    ('abd3c2a0-6dc0-4680-92dd-a013e1141c91'::uuid, 'f468b438-4081-7004-d865-a1b86eb19beb'),
    ('b100f05d-9e81-4a7b-b9cc-9baf173131d9'::uuid, '34c8a478-e0d1-70f3-3c49-02225e7404b6'),
    ('e2ad0849-c6b6-4f4a-a68a-8c52f563c6fd'::uuid, '647894c8-2011-70d4-e874-efd4b080700e'),
    ('fd857564-9534-4b0f-95ac-624ed1273725'::uuid, '74286478-c0c1-7068-9fea-9deea6f61627')
  ) AS v(application_user_id, cognito_sub)
  JOIN public.identity_accounts ia
    ON ia.application_user_id = v.application_user_id
   AND ia.cognito_sub = v.cognito_sub;
  IF matched <> 8 THEN
    RAISE EXCEPTION 'production_cognito_lock_seed_mismatch'
      USING ERRCODE = '42501',
            HINT = 'Live identity_accounts.cognito_sub did not match all 8 repaired production mappings.';
  END IF;
END;
$$;

INSERT INTO public.identity_production_cognito_locks (application_user_id, cognito_sub)
SELECT v.application_user_id, v.cognito_sub
FROM (VALUES
  ('0160a5f3-30a4-4aba-8e54-6529f1ceb0d4'::uuid, 'd418a4f8-80f1-70d6-36c9-fe490220bf4a'),
  ('30d0505c-bcfa-4732-81fd-869dc46da5dd'::uuid, '34388468-a021-7036-c34d-2ff14a20ed40'),
  ('3af0234c-de1b-4819-938d-fa4f9390811b'::uuid, '24d874d8-80d1-7092-7f34-48b8704702f8'),
  ('7dbb3009-f059-4767-b5dc-1c5c72379330'::uuid, 'a45884b8-d051-70b3-b19d-ca704964c6e8'),
  ('abd3c2a0-6dc0-4680-92dd-a013e1141c91'::uuid, 'f468b438-4081-7004-d865-a1b86eb19beb'),
  ('b100f05d-9e81-4a7b-b9cc-9baf173131d9'::uuid, '34c8a478-e0d1-70f3-3c49-02225e7404b6'),
  ('e2ad0849-c6b6-4f4a-a68a-8c52f563c6fd'::uuid, '647894c8-2011-70d4-e874-efd4b080700e'),
  ('fd857564-9534-4b0f-95ac-624ed1273725'::uuid, '74286478-c0c1-7068-9fea-9deea6f61627')
) AS v(application_user_id, cognito_sub)
JOIN public.identity_accounts ia
  ON ia.application_user_id = v.application_user_id
 AND ia.cognito_sub = v.cognito_sub
ON CONFLICT (application_user_id) DO UPDATE
  SET cognito_sub = EXCLUDED.cognito_sub;

DO $$
DECLARE
  lock_count int;
BEGIN
  SELECT count(*) INTO lock_count FROM public.identity_production_cognito_locks;
  IF lock_count <> 8 THEN
    RAISE EXCEPTION 'production_cognito_lock_seed_mismatch'
      USING ERRCODE = '42501',
            HINT = 'Live identity_accounts.cognito_sub did not match all 8 repaired production mappings.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_protect_production_cognito()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  locked_sub text;
BEGIN
  IF current_setting('request.production_identity_write', true) = '1' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM public.identity_production_cognito_locks l
      WHERE l.application_user_id = OLD.application_user_id
    ) THEN
      RAISE EXCEPTION 'production_cognito_mapping_locked'
        USING ERRCODE = '42501',
              HINT = 'Staging/rehearsal/test cannot delete a locked production Cognito mapping.';
    END IF;
    RETURN OLD;
  END IF;

  SELECT l.cognito_sub INTO locked_sub
    FROM public.identity_production_cognito_locks l
   WHERE l.application_user_id = OLD.application_user_id;

  IF locked_sub IS NOT NULL AND (
    NEW.application_user_id IS DISTINCT FROM OLD.application_user_id
    OR NEW.cognito_sub IS DISTINCT FROM locked_sub
  ) THEN
    RAISE EXCEPTION 'production_cognito_mapping_locked'
      USING ERRCODE = '42501',
            HINT = 'Staging/rehearsal/test cannot overwrite a locked production Cognito mapping.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS identity_protect_production_cognito ON public.identity_accounts;
CREATE TRIGGER identity_protect_production_cognito
  BEFORE UPDATE OR DELETE ON public.identity_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.identity_protect_production_cognito();

CREATE OR REPLACE FUNCTION public.identity_protect_production_cognito_locks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('request.production_identity_write', true) = '1' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'production_cognito_mapping_locked'
    USING ERRCODE = '42501',
          HINT = 'Lock table changes require request.production_identity_write=1.';
END;
$$;

DROP TRIGGER IF EXISTS identity_protect_production_cognito_locks ON public.identity_production_cognito_locks;
CREATE TRIGGER identity_protect_production_cognito_locks
  BEFORE INSERT OR UPDATE OR DELETE ON public.identity_production_cognito_locks
  FOR EACH ROW
  EXECUTE FUNCTION public.identity_protect_production_cognito_locks();

REVOKE ALL ON FUNCTION public.identity_protect_production_cognito() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.identity_protect_production_cognito_locks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.identity_protect_production_cognito() TO checksops;
GRANT EXECUTE ON FUNCTION public.identity_protect_production_cognito_locks() TO checksops;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops_admin') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.identity_protect_production_cognito() TO checksops_admin';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.identity_protect_production_cognito_locks() TO checksops_admin';
  END IF;
END;
$$;
