export const PINNED_SQL47_SHA256 = 'bdbdccbc44ca70ae86c7212f16fb1a2d2786071b61acb6b62c98e7863b2cc99c';
export const PINNED_SQL48_SHA256 = 'be6c712587ded69ee209524be08edcdc640a438bd0196d0be978cbe9ae48ef9f';
export const PINNED_SQL49_SHA256 = '3bda6740d08b159ee21e3861443d9b9ae74f2e2efc01ae147467da00bcf3a550';
export const PINNED_SQL50_DOC_SHA256 = '6c6561cb69a9055d485dd9afb7029915592b8a2658df23ec8acf1c1fe200443a';
export const PINNED_TEMP_TRIGGER_SHA256 = '882bd2c9613bde48f96c0cb156a07be631e901b2bf4054c6b754d75500eb4fd4';
export const PINNED_RESTORE_TRIGGER_SHA256 = 'cdac6beb58ae6d5c94e7834c1649d0dc7e448564adba24ee7525f9195bd16d0b';
export const FUNCTION_NAME = 'checksops-staging-macomp50-oneshot';
export const APPLY_CONFIRM = 'STAGING_EXCLUDE_MACOMP_DEMO_A47_A48';
export const AUTHORIZED_IDS_FINGERPRINT =
  '66aa2f109a4cb55adedd99779287057c363d1eaf9f43883ec813ece74e60bb4f';
export const FORBIDDEN_FUNCTIONS = Object.freeze([
  'checksops-staging-api',
  'checksops-staging-guarded-sql-executor',
  'checksops-staging-macomp47-oneshot',
  'checksops-staging-macomp48-oneshot',
  'checksops-production-prep-api',
  'checksops-production-origin-verify',
  'checksops-prod-sql47-inspect-2d41',
  'checksops-prod-sql47-apply-2d41',
  'checksops-prod-macomp47-oneshot-ad99',
  'checksops-prod-macomp48-oneshot-ad99',
  'checksops-prod-macomp49-oneshot-ad99',
]);

export const SYNTHETIC_TENANT_ID = 'a2c0fbfe-e8c5-42dc-bc32-2c4edf8f2074';
export const ALLOWED_AGENTS = Object.freeze([
  'b100f05d-9e81-4a7b-b9cc-9baf173131d9',
  '4584ac20-2703-4a2f-835e-7bd574aa5376',
]);
export const ALLOWED_REQUESTS = Object.freeze([
  'a47cad99-0000-4000-8000-000000000021',
  'a47cad99-0000-4000-8000-000000000022',
  'a47cad99-0000-4000-8000-000000000023',
  'a48cad99-0000-4000-8000-000000000021',
  'a48cad99-0000-4000-8000-000000000024',
]);
export const ALLOWED_CHECKS = Object.freeze([
  'a47cad99-0000-4000-8000-000000000011',
  'a47cad99-0000-4000-8000-000000000012',
  'a47cad99-0000-4000-8000-000000000013',
  'a48cad99-0000-4000-8000-000000000011',
  'a48cad99-0000-4000-8000-000000000013',
]);
export const KNOWN_ROOT_IDS = Object.freeze([
  '50509ac0-f3c3-4051-acf6-69fc9988be74',
  '60745413-ce5e-4c65-8992-b0fd401bfa42',
  '144e5657-f0c9-4fab-9bb8-eea28ad41136',
]);
export const FORBIDDEN_REQUESTS = Object.freeze([
  '5b20db20-13e1-4919-9528-06388d8661d2',
  '7a7ec1ce-de9a-4601-875c-4a67db635fd2',
  '71ea6822-df95-4aa9-a04c-4a00a5f6d043',
  'c4f1b55b-18ba-4e70-86ce-230bdf14ed49',
]);
export const EXCLUDE_REASON =
  'SQL47/48/49 staging demo leftover. Exclude from active Mortgage Agent payables.';
export const EXCLUSIONS_INSERT_SQL = `
INSERT INTO public.mortgage_agent_compensation_exclusions (mortgage_request_id, reason)
SELECT x, $2::text
  FROM unnest($1::uuid[]) AS x
 ON CONFLICT (mortgage_request_id) DO NOTHING`;
export const EXCLUDE_UPDATE_SQL = `
UPDATE public.mortgage_agent_compensation_entries
   SET status = 'excluded',
       exclusion_reason = $2
 WHERE id = ANY($1::uuid[])
   AND tenant_id = $3::uuid
   AND mortgage_request_id = ANY($4::uuid[])
   AND (check_intake_item_id IS NULL OR check_intake_item_id = ANY($5::uuid[]))
   AND agent_user_id = ANY($6::uuid[])
   AND status NOT IN ('voided', 'excluded')
RETURNING id::text, status, payment_reference, paid_at, amount_cents`;
export const AUDIT_INSERT_SQL = `
INSERT INTO public.mortgage_agent_compensation_audit (
  entry_id, actor_id, action, from_status, to_status, payload
) VALUES (
  $1::uuid, $2::uuid, 'exclude', $3::text, 'excluded',
  jsonb_build_object(
    'reason', $4::text,
    'bookkeeping_only', true,
    'payment_reference_preserved', true
  )
)`;
export const TRIGGER_DEF_SQL =
  `SELECT pg_get_functiondef('public.tg_protect_mortgage_agent_compensation_facts()'::regprocedure) AS def`;
