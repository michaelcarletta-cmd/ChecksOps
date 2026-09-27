export const HARNESS_FUNCTION_NAME = 'checksops-staging-mortgage-desk-e2e-harness';
export const HARNESS_ROLE_NAME = 'checksops-staging-mortgage-desk-e2e-harness-role';
export const HARNESS_STACK_NAME = 'checksops-staging-mortgage-desk-e2e-harness';
export const HARNESS_LOG_GROUP = '/aws/lambda/checksops-staging-mortgage-desk-e2e-harness';

export const AWS_ACCOUNT_ID = '806168576068';
export const AWS_REGION = 'us-east-1';

export const STAGING_API_FUNCTION = 'checksops-staging-api';
export const PREP_API_FUNCTION = 'checksops-production-prep-api';

export const STAGING_SHA_BASELINE = '/E0seEu57bvTZ9RuVQgQ8obE684BHCF4mQqqUfsMQC8=';
export const PREP_SHA_BASELINE = '9OLR9DMhuDrAUp5/TmT6+8bfQC2I6USFk+zwFkluJLQ=';

export const STAGING_RDS_HOST = 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
export const STAGING_DATABASE_NAME = 'checksops';
export const STAGING_DB_USER = 'checksops';
export const STAGING_SECRET_NAME_PREFIX = 'rds-db-credentials/checksops-staging/checksops/1788286468693';
export const STAGING_SECRET_ARN_PREFIX = `arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:${STAGING_SECRET_NAME_PREFIX}`;

export const STAGING_API_URL = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';

export const FREEDOM_TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
export const C1C_TENANT_ID = '4f172140-f57a-4744-8050-95f4f07b13b4';
export const MORTGAGE_AGENT_USER_ID = 'b100f05d-9e81-4a7b-b9cc-9baf173131d9';
export const MORTGAGE_AGENT_EMAIL = 'claims@freedomadj.com';

export const READONLY_PROBE_IDENTITIES = [
  { id: 'b100f05d-9e81-4a7b-b9cc-9baf173131d9', email: 'claims@freedomadj.com', label: 'mortgage_agent' },
  { id: 'abd3c2a0-6dc0-4680-92dd-a013e1141c91', email: 'checksops-tester@freedomadj.com', label: 'freedom_tester' },
  { id: '7dbb3009-f059-4767-b5dc-1c5c72379330', email: 'mcarletta@freedomadj.com', label: 'freedom_admin' },
  { id: 'dd24eea5-5d12-47d1-999e-d5930c278b7d', email: null, label: 'unknown_admin' },
  { id: '3af0234c-de1b-4819-938d-fa4f9390811b', email: 'asukanick@condition1commercial.com', label: 'c1c_admin' },
];

export const EXPECTED_INITIAL_RATE_CENTS = 1000;
export const EXPECTED_ADDITIONAL_RATE_CENTS = 500;

export const CLAIM_MARKER_PREFIX = 'SYNTHETIC-MDE2E-';
export const SYNTHETIC_LABEL = 'SYNTHETIC / TEST / NOT NEGOTIABLE';

export const FORBIDDEN_SECRET_PATTERNS = [
  /checksops-production/i,
  /checksops_admin/i,
  /\/providers/i,
  /moov/i,
  /checkalt/i,
  /plaid/i,
  /stripe/i,
];

export const FORBIDDEN_HOST_PATTERNS = [
  /production/i,
  /localhost/i,
  /127\.0\.0\.1/,
];

export const WRITE_ACTIONS = new Set(['run_initial', 'run_additional', 'cleanup']);

export const FIXTURE_TABLES = [
  'claims',
  'check_intake_items',
  'mortgage_handling_requests',
  'check_billing_events',
  'check_audit_log',
  'check_messages',
];
