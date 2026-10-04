export const FUNCTION_NAME = 'checksops-staging-api';
export const WORKSTREAM_ID = 'staging-macomp-dispatch-ad99';
export const BRANCH = 'cursor/staging-macomp-dispatch-ad99';
export const EXPECTED_LIVE_CODE_SHA256 = 'aZ0K2droM3XKT0eQRUYdHEKwW0ehTlAy8VY/qm7YCgE=';
export const EXPECTED_LIVE_REVISION_ID = '99a9dd03-e001-448f-8c18-7ba9f0e823e5';
export const PRODUCTION_FUNCTION_NAME = 'checksops-production-prep-api';
export const PRODUCTION_CODE_SHA256 = 'CWB8lxnHoqANyVcaNpKL7h4MtDSPMlHZ6wliFuGE6yA=';
export const PRODUCTION_REVISION_ID = '16327bba-cc0a-4a17-b2a8-55b7b2d1b069';
export const OWNED_REPLACE = Object.freeze(['app-services.mjs']);
export const OWNED_ADD = Object.freeze([]);
export const MEMBER_SOURCES = Object.freeze({
  'app-services.mjs': 'aws/functions/api/app-services.mjs',
});
export const LIVE_APP_SERVICES_SHA256 = '31b6c9d555f93941d78df067575765a565c5c58ad4c1ad9c4062f0be23207d9b';
export const PATCHED_APP_SERVICES_SHA256 = 'a82cbbd9fee129d78400ec3f715f18441f964c08c9f6e55d283622e8d43362bf';
export const LIVE_COMPENSATION_SHA256 = '531837ab7ff9fb8279bcfb6cf624bde8aa183820f4a2ac355c6f7a1814cca4bb';
export const PRESERVE = Object.freeze([
  'mortgage-agent-compensation.mjs',
  'homeowner.mjs',
  'email-branding.mjs',
  'tenant-email-domain-handlers.mjs',
  'esign.mjs',
  'tenant-admin.mjs',
  'identity.mjs',
  'workflow-rpc.mjs',
  'write-check-workflow.mjs',
  'index.mjs',
  'bill-mortgage-handling.mjs',
]);
export const LIVE_PRESERVE_SHA256 = Object.freeze({
  'mortgage-agent-compensation.mjs': '531837ab7ff9fb8279bcfb6cf624bde8aa183820f4a2ac355c6f7a1814cca4bb',
  'homeowner.mjs': 'e770bbca94c31096443a96b03aed6a0e36e780ef79b17e1e73423647ede3e302',
  'email-branding.mjs': '8b23eb8893377bad1c11d9a02522c789d222053b084d4ba53107eae7d374bb4b',
  'tenant-admin.mjs': '8fc1f049860979387ff83ca3a4c7fdaa384a7dc2aa6eabd620cdf1c40c950bff',
  'identity.mjs': '30abd75f4483c5ed25b9c506f08023645c26f7b8aee49c831fb73e702022515b',
  'workflow-rpc.mjs': 'dace9f60645bce44bc4150e0271d3697795feea1680b3a61bee6d9e25236f0ed',
  'write-check-workflow.mjs': '7d3eb430899796cc02bc7175db0a3f1cca1ee82763f2a0404b0c13380d1131a7',
  'index.mjs': '24f13aa5ff4f3d72e7f5ff4dc45dd194796aa4e75958de5bc39c8c1dce3eb4da',
  'esign.mjs': '7c60b6462f7e0caa21800481a68735a44fc38bde19d74f78c64bc5ca97956b74',
});
export const STAGING_ONLY_HOMEOWNER_ROUTES = Object.freeze([
  'homeowner-ledger-endorse-link',
  'homeowner-ledger-document-sign-link',
]);
export const STAGING_ACCEPTANCE = Object.freeze({
  ok: true,
  reference: 'Surgical staging dispatcher registration of already-present mortgage-agent-compensation.mjs. Preserve staging-only Homeowner endorse/document-sign-link, Signature Request, Branding, Mortgage Desk, and all existing Class A routes.',
});
