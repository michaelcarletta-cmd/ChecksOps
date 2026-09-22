-- Isolated-production claim-ownership fixture.
-- Runs entirely inside one transaction and ROLLBACKs. Do not COMMIT.
-- Proves cases 1–10 against live counts without leaving business rows.

BEGIN;
SET LOCAL row_security = off;

CREATE TEMP TABLE _claim_owner_probe ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.claims) AS claims_n,
  (SELECT count(*) FROM public.claims WHERE org_id = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a') AS claims_freedom,
  (SELECT count(*) FROM public.claims WHERE org_id IS NULL) AS claims_null,
  (SELECT count(*) FROM public.check_intake_items) AS checks_n,
  (SELECT count(*) FROM public.check_intake_items WHERE tenant_id = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a') AS checks_freedom,
  (SELECT count(*) FILTER (WHERE target_tenant_id = '4f172140-f57a-4744-8050-95f4f07b13b4' AND revoked_at IS NULL) FROM public.shared_checks) AS share_c1c,
  (SELECT count(*) FILTER (WHERE target_tenant_id = 'fd77533e-6e72-4f28-a22d-cf026b392a4f' AND revoked_at IS NULL) FROM public.shared_checks) AS share_barzzini,
  (SELECT count(*) FILTER (WHERE target_tenant_id = '3ea1e5eb-9f60-4905-99bb-59afbe7e1265' AND revoked_at IS NULL) FROM public.shared_checks) AS share_home_hero,
  (SELECT org_id FROM public.claims WHERE id = 'ea7d428b-1f8f-493c-9a10-fca3e75da40d') AS claim_271682_org,
  (SELECT tenant_id FROM public.check_intake_items WHERE id = '8eb2eb71-42e2-4615-a069-aee1a4a67151') AS check_271682_tenant;

DO $$
DECLARE
  _freedom uuid := '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
  _c1c uuid := '4f172140-f57a-4744-8050-95f4f07b13b4';
  _freedom_user uuid := '7dbb3009-f059-4767-b5dc-1c5c72379330';
  _c1c_user uuid := 'fd857564-9534-4b0f-95ac-624ed1273725';
  _claim uuid := 'ea7d428b-1f8f-493c-9a10-fca3e75da40d';
  _check uuid := '8eb2eb71-42e2-4615-a069-aee1a4a67151';
  _org uuid;
  _share jsonb;
  _share_id uuid;
BEGIN
  PERFORM set_config('request.app_user_id', _freedom_user::text, true);
  PERFORM set_config('request.active_tenant_slug', '', true);
  INSERT INTO public.claims (claim_number, org_id) VALUES ('__probe_freedom__', NULL) RETURNING org_id INTO _org;
  IF _org IS DISTINCT FROM _freedom THEN
    RAISE EXCEPTION 'case1_freedom_create_failed %', _org;
  END IF;

  INSERT INTO public.claims (claim_number, org_id) VALUES ('__probe_freedom_spoof__', _c1c) RETURNING org_id INTO _org;
  IF _org IS DISTINCT FROM _freedom THEN
    RAISE EXCEPTION 'case3_5_freedom_spoof_failed %', _org;
  END IF;

  PERFORM set_config('request.app_user_id', _c1c_user::text, true);
  INSERT INTO public.claims (claim_number, org_id) VALUES ('__probe_c1c__', NULL) RETURNING org_id INTO _org;
  IF _org IS DISTINCT FROM _c1c THEN
    RAISE EXCEPTION 'case2_c1c_create_failed %', _org;
  END IF;

  INSERT INTO public.claims (claim_number, org_id) VALUES ('__probe_c1c_spoof__', _freedom) RETURNING org_id INTO _org;
  IF _org IS DISTINCT FROM _c1c THEN
    RAISE EXCEPTION 'case3_6_c1c_spoof_failed %', _org;
  END IF;

  PERFORM set_config('request.app_user_id', _freedom_user::text, true);
  _share := public.aws_share_check_with_partner(_check, _c1c);
  SELECT org_id INTO _org FROM public.claims WHERE id = _claim;
  IF _org IS DISTINCT FROM _freedom THEN
    RAISE EXCEPTION 'case7_share_changed_claim_org %', _org;
  END IF;
  IF (SELECT tenant_id FROM public.check_intake_items WHERE id = _check) IS DISTINCT FROM _freedom THEN
    RAISE EXCEPTION 'case7_share_changed_check_tenant';
  END IF;

  _share_id := (_share->>'share_id')::uuid;
  PERFORM public.aws_revoke_shared_check(_share_id);
  SELECT org_id INTO _org FROM public.claims WHERE id = _claim;
  IF _org IS DISTINCT FROM _freedom THEN
    RAISE EXCEPTION 'case8_revoke_changed_claim_org %', _org;
  END IF;
END $$;

CREATE TEMP TABLE _claim_owner_result ON COMMIT DROP AS
SELECT
  p.claims_n, p.claims_freedom, p.claims_null, p.checks_n, p.checks_freedom,
  p.share_c1c, p.share_barzzini, p.share_home_hero,
  p.claim_271682_org, p.check_271682_tenant,
  (SELECT count(*) FROM public.claims) AS claims_n_after_tx,
  (SELECT org_id FROM public.claims WHERE id = 'ea7d428b-1f8f-493c-9a10-fca3e75da40d') AS claim_271682_org_after,
  jsonb_build_object(
    'case9_claims_183_freedom', p.claims_n = 183 AND p.claims_freedom = 183 AND p.claims_null = 0,
    'case10_shares', p.share_c1c = 94 AND p.share_barzzini = 8 AND p.share_home_hero = 2,
    'checks_194_freedom', p.checks_n = 194 AND p.checks_freedom = 194,
    'claim_271682_freedom', p.claim_271682_org = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
    'check_271682_freedom', p.check_271682_tenant = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a'
  ) AS invariants
FROM _claim_owner_probe p;

SELECT row_to_json(r) FROM _claim_owner_result r;

ROLLBACK;
