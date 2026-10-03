export const PINNED_SQL47_SHA256 = 'bdbdccbc44ca70ae86c7212f16fb1a2d2786071b61acb6b62c98e7863b2cc99c';
export const EXPECTED_SQL39_HASH = '0d959621d34c99879dc9092cb925bfdb169273a21bea76c6a44242c2d64cd126';
export const FUNCTION_NAME = 'checksops-prod-macomp47-oneshot-ad99';
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
]);
export const EXPECTED_CBE_UIDX_NAME = 'check_billing_events_mortgage_ops_check_uidx';
export const EXPECTED_CBE_UIDX_DEF = 'CREATE UNIQUE INDEX check_billing_events_mortgage_ops_check_uidx ON public.check_billing_events USING btree (check_intake_item_id) WHERE ((event_type = ANY (ARRAY[\'mortgage_ops_initial\'::text, \'mortgage_ops_additional_check\'::text])) AND (check_intake_item_id IS NOT NULL))';
export const FREEDOM_REQUEST_ID = '5b20db20-13e1-4919-9528-06388d8661d2';
export const FREEDOM_CBE_ID = '6c661cc3-9be0-4906-9996-210e3be005dc';
export const SYNTHETIC_A = '7a7ec1ce-de9a-4601-875c-4a67db635fd2';
export const SYNTHETIC_B = '71ea6822-df95-4aa9-a04c-4a00a5f6d043';
export const KNOWN_CBE_IDS = Object.freeze([
  FREEDOM_CBE_ID,
  '3df0c417-641d-45c2-87dc-47fdd2c1d80c',
  'e68193b5-cb9c-4754-92dd-a85884cd2f98',
]);
