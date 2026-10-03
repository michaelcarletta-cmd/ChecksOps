export const PINNED_SQL47_SHA256 = 'bdbdccbc44ca70ae86c7212f16fb1a2d2786071b61acb6b62c98e7863b2cc99c';
export const PINNED_SQL48_SHA256 = 'be6c712587ded69ee209524be08edcdc640a438bd0196d0be978cbe9ae48ef9f';
export const PINNED_SQL49_SHA256 = '3bda6740d08b159ee21e3861443d9b9ae74f2e2efc01ae147467da00bcf3a550';
export const EXPECTED_SQL39_HASH = '0d959621d34c99879dc9092cb925bfdb169273a21bea76c6a44242c2d64cd126';
export const EXPECTED_SQL47_CATALOG = '3ef6b9b6ff9506e7c33d097cb5e01604cd7454f943114a6d3e85f0f5364ec7c0';
export const EXPECTED_SQL48_RETURN_HASH = '4a8edeb99404042b141b06a2566d3f7ccfd3a74a1a423ebfdb4df99a0b87ac76';
export const EXPECTED_CBE_COUNT = 131;
export const FUNCTION_NAME = 'checksops-prod-macomp49-oneshot-ad99';
export const FORBIDDEN_FUNCTIONS = Object.freeze([
  'checksops-staging-api',
  'checksops-staging-guarded-sql-executor',
  'checksops-staging-sql44-2d41',
  'checksops-staging-rehearsal-oneshot',
  'checksops-staging-macomp47-oneshot',
  'checksops-staging-macomp48-oneshot',
  'checksops-production-prep-api',
  'checksops-production-origin-verify',
  'checksops-prod-sql47-inspect-2d41',
  'checksops-prod-sql47-apply-2d41',
  'checksops-prod-mortgage-ops-sql-2d41',
  'checksops-prod-mops-sql-transition-ad99',
  'checksops-prod-macomp47-oneshot-ad99',
  'checksops-prod-macomp48-oneshot-ad99',
]);
export const EXPECTED_CBE_UIDX_NAME = 'check_billing_events_mortgage_ops_check_uidx';
export const EXPECTED_CBE_UIDX_DEF = 'CREATE UNIQUE INDEX check_billing_events_mortgage_ops_check_uidx ON public.check_billing_events USING btree (check_intake_item_id) WHERE ((event_type = ANY (ARRAY[\'mortgage_ops_initial\'::text, \'mortgage_ops_additional_check\'::text])) AND (check_intake_item_id IS NOT NULL))';
export const FALLBACK_UIDX_NAME = 'check_billing_events_one_mortgage_ops_per_check';
export const FREEDOM_REQUEST_ID = '5b20db20-13e1-4919-9528-06388d8661d2';
export const FREEDOM_CBE_ID = '6c661cc3-9be0-4906-9996-210e3be005dc';
export const SYNTHETIC_A = '7a7ec1ce-de9a-4601-875c-4a67db635fd2';
export const SYNTHETIC_B = '71ea6822-df95-4aa9-a04c-4a00a5f6d043';
export const KNOWN_CBE_IDS = Object.freeze([
  FREEDOM_CBE_ID,
  '3df0c417-641d-45c2-87dc-47fdd2c1d80c',
  'e68193b5-cb9c-4754-92dd-a85884cd2f98',
]);
export const EXPECTED_SQL47_FN_HASHES = Object.freeze({
  aws_is_active_mortgage_agent: 'd8846afb599babf83e5657ec63e54a7cd8a6e950bec96096ab5925972b37c98b',
  aws_can_admin_mortgage_agent_compensation: 'ea033ce8511dff0858ca5dce65e690025488ecb36524e4140f85d6808e92386a',
  earn_mortgage_agent_compensation: '23d7f8357d8f8377cf2f51780b6e70c894dea58045e9a57a3690487c17fe3d38',
  set_mortgage_agent_account_status: 'e2abcf95f7125a663491e874eabad996b228206987d0e6d045ec6d6b862824f0',
  approve_mortgage_agent_compensation: '62ce80b64aa29e3e9cbde11c9e14c0be50812b804a90d1cc5a7f04af2fbb2efb',
  mark_mortgage_agent_compensation_paid: 'e884991457cadfe625d299c0ef07f6b89a0e31f529da6065d86aedf67eef177f',
  mortgage_agent_compensation_reconciliation: 'edd48e8286d99a9a848917cde0a0e3ec3f92e53775127012aa7e390006721c3a',
});
