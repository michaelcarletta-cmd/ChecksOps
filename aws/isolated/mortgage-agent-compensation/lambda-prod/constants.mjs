export const FUNCTION_NAME = 'checksops-production-prep-api';
export const WORKSTREAM_ID = 'mortgage-agent-compensation-ad99';
export const EXPECTED_LIVE_CODE_SHA256 = 'S2CV0j3zWfYfyfSvmIq0axMhnSib1UntZZVqOvzxBbc=';
export const EXPECTED_LIVE_REVISION_ID = '2f112f18-9055-4760-859d-62be8899b91f';
export const OWNED_REPLACE = Object.freeze([
  'app-services.mjs',
  'tenant-admin.mjs',
  'identity.mjs',
]);
export const OWNED_ADD = Object.freeze([
  'mortgage-agent-compensation.mjs',
]);
export const PRESERVE = Object.freeze([
  'email-branding.mjs',
  'homeowner.mjs',
  'workflow-rpc.mjs',
  'write-check-workflow.mjs',
  'index.mjs',
]);
export const MEMBER_SOURCES = Object.freeze({
  'app-services.mjs': 'aws/functions/api/app-services.mjs',
  'tenant-admin.mjs': 'aws/functions/api/tenant-admin.mjs',
  'identity.mjs': 'aws/functions/api/identity.mjs',
  'mortgage-agent-compensation.mjs': 'aws/functions/api/mortgage-agent-compensation.mjs',
});
export const ACCEPTED_SOURCE_SHA256 = Object.freeze({
  'app-services.mjs': 'cce9d0ff48ce7644083e5aa04aec77c5100246b93a440c20ddb1ba5701bcc0c5',
  'tenant-admin.mjs': '8fc1f049860979387ff83ca3a4c7fdaa384a7dc2aa6eabd620cdf1c40c950bff',
  'identity.mjs': '30abd75f4483c5ed25b9c506f08023645c26f7b8aee49c831fb73e702022515b',
  'mortgage-agent-compensation.mjs': '531837ab7ff9fb8279bcfb6cf624bde8aa183820f4a2ac355c6f7a1814cca4bb',
});
export const STAGING_ACCEPTANCE = Object.freeze({
  ok: true,
  reference: 'Mortgage Agent staging acceptance of roster/monthly/drilldown/approve/pay/Return/Adjust. SQL 47+48+49 production accepted. Do not absorb Homeowner #641.',
});
