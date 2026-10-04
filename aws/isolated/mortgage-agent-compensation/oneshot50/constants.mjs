export const PINNED_SQL47_SHA256 = 'bdbdccbc44ca70ae86c7212f16fb1a2d2786071b61acb6b62c98e7863b2cc99c';
export const PINNED_SQL48_SHA256 = 'be6c712587ded69ee209524be08edcdc640a438bd0196d0be978cbe9ae48ef9f';
export const PINNED_SQL49_SHA256 = '3bda6740d08b159ee21e3861443d9b9ae74f2e2efc01ae147467da00bcf3a550';
export const PINNED_SQL50_SHA256 = '066819a40ba83c594a20d5bd18453331ccf53be8f1076333643bdcdd5eda3460';
export const FUNCTION_NAME = 'checksops-staging-macomp50-oneshot';
export const APPLY_CONFIRM = 'STAGING_EXCLUDE_MACOMP_DEMO_A47_A48';
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
SELECT x, $2
  FROM unnest($1::uuid[]) AS x
 ON CONFLICT (mortgage_request_id) DO NOTHING`;
