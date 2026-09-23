export const TARGET_RDS = {
  identifier: 'checksops-staging',
  engine: 'postgres',
  engineVersion: '18.3',
  endpointHost: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
  port: 5432,
  defaultDatabase: 'postgres',
  recommendedRestoreDatabase: 'checksops',
  applicationRole: 'checksops',
  adminRole: 'checksops_admin',
};

export const LIVE_SOURCE_COUNTS = {
  publicBaseTables: 166,
  publicViews: 20,
  publicRelationsTablesPlusViews: 186,
  publicFunctions: 960,
  publicTriggers: 211,
  publicRlsPolicies: 380,
  authUsers: 9,
  storageObjects: 1335,
  publicForeignKeysToAuthUsers: 0,
  supabaseFunctionDependencies: {
    authUid: 40,
    authJwt: 0,
    net: 4,
    cron: 2,
    vault: 5,
    pgmq: 5,
  },
};

export const SOURCE = {
  kind: 'live-supabase-lovable',
  projectRef: 'nbcqwpysqgyxrrbgtmkw',
  projectUrl: 'https://nbcqwpysqgyxrrbgtmkw.supabase.co',
  inventoryFile: 'aws/db-copy/LIVE_SOURCE_INVENTORY.md',
  ...LIVE_SOURCE_COUNTS,
  twentyTableDiscrepancy: false,
  doNotUseProjectRef: 'sqyyvpaymashtdwjjmku',
  generatedTypesNote:
    'Generated src/types/database.ts lists the same 166 public tables and 20 views as the live catalog. 186 was tables+views, not a missing-table gap. PostgREST types list 358 functions (subset of live 960). Do not treat the other Management-API-visible project named ChecksOps (sqyyvpaymashtdwjjmku) as live.',
};

export const EXCLUDED_SCHEMAS = [
  'auth',
  'storage',
  'realtime',
  '_realtime',
  'supabase_functions',
  'supabase_migrations',
  'vault',
  'pgsodium',
  'pgmq',
  'net',
  'cron',
  'extensions',
  'graphql',
  'graphql_public',
  'pgbouncer',
  'supabase_security',
];

export const RDS_SUPPORTED_EXTENSIONS = [
  { name: 'pgcrypto', required: true, notes: 'Live source has pgcrypto 1.3. Required for hashing/token helpers.' },
  { name: 'uuid-ossp', required: true, notes: 'Live source has uuid-ossp 1.1.' },
  { name: 'pg_stat_statements', required: false, notes: 'Live source has 1.11. Observability only.' },
  { name: 'postgis', required: true, notes: 'Live source has postgis 3.3.7. Stop the first copy if RDS cannot enable it.' },
  { name: 'vector', required: true, notes: 'Live source has vector 0.8.0. Stop the first copy if RDS cannot enable it.' },
];

export const CONDITIONAL_RDS_EXTENSIONS = [
  { name: 'pg_trgm', reason: 'Enable only if the live dump references it.' },
  { name: 'citext', reason: 'Enable only if the live dump references it.' },
  { name: 'unaccent', reason: 'Enable only if the live dump references it.' },
  { name: 'btree_gin', reason: 'Enable only if the live dump references it.' },
  { name: 'btree_gist', reason: 'Enable only if the live dump references it.' },
];

export const UNSUPPORTED_OR_SUPABASE_EXTENSIONS = [
  { name: 'pg_net', action: 'do-not-restore', replacement: 'AWS Lambda / EventBridge HTTP' },
  { name: 'pg_cron', action: 'do-not-restore-jobs', replacement: 'Amazon EventBridge schedules' },
  { name: 'pgsodium', action: 'do-not-restore', replacement: 'AWS KMS / Secrets Manager' },
  { name: 'supabase_vault', action: 'do-not-restore', replacement: 'AWS Secrets Manager' },
  { name: 'pgmq', action: 'do-not-restore', replacement: 'SQS or EventBridge' },
  { name: 'supabase_vault / vault', action: 'do-not-restore', replacement: 'AWS Secrets Manager' },
];

export const POSTGIS_CATALOG_VIEWS = ['geography_columns', 'geometry_columns'];

export const CRITICAL_TABLE_GROUPS = {
  checks: [
    'check_cases',
    'check_intake_items',
    'check_payees',
    'check_files',
    'check_stakeholders',
    'shared_checks',
  ],
  deposits: [
    'deposit_batches',
    'deposit_items',
    'checkalt_deposits',
    'checkalt_tenant_accounts',
    'deposit_exceptions',
    'deposit_provider_attempts',
  ],
  endorsements: [
    'check_endorsements',
    'endorsement_requests',
    'check_endorsement_events',
    'endorsement_audit_log',
  ],
  disbursements: [
    'disbursement_batches',
    'disbursement_splits',
    'claim_disbursements',
    'claim_check_payments',
    'claim_payments',
  ],
  payment_events_webhooks: [
    'payment_webhook_events',
    'payment_event_log',
    'payment_idempotency_keys',
    'checkalt_webhook_events',
    'deposit_webhook_events',
    'plaid_webhook_cursors',
  ],
  wallets_provider_accounts: [
    'payment_wallets',
    'payment_wallet_ledger',
    'payment_wallet_sub_ledgers',
    'payment_provider_accounts',
    'payment_provider_methods',
    'payment_transfers',
    'payment_transfer_groups',
    'payment_sweep_configs',
    'wallet_funding_requests',
    'wallet_funding_queue',
  ],
  tenants_users: [
    'tenants',
    'tenant_users',
    'user_roles',
    'profiles',
    'stakeholder_accounts',
  ],
  claims: [
    'claims',
    'claim_checks',
    'claim_files',
    'loss_draft_tracking',
    'homeowner_ledger_events',
  ],
  audit_logs: [
    'audit_logs',
    'check_audit_log',
    'check_status_audit',
    'deposit_audit_log',
    'loss_draft_audit_log',
    'esign_event_logs',
  ],
  reconciliation_records: [
    'check_reconciliation_alerts',
  ],
};

export const FINANCIAL_METRICS = [
  { table: 'check_intake_items', expr: 'coalesce(sum(amount), 0)', label: 'check_intake_amount' },
  { table: 'check_intake_items', expr: 'coalesce(sum(pa_fee_amount), 0)', label: 'check_intake_pa_fee_amount' },
  { table: 'deposit_items', expr: 'coalesce(sum(amount), 0)', label: 'deposit_items_amount' },
  { table: 'deposit_batches', expr: 'coalesce(sum(total_amount), 0)', label: 'deposit_batches_total_amount' },
  { table: 'checkalt_deposits', expr: 'coalesce(sum(amount), 0)', label: 'checkalt_deposits_amount' },
  { table: 'disbursement_splits', expr: 'coalesce(sum(amount), 0)', label: 'disbursement_splits_amount' },
  { table: 'disbursement_batches', expr: 'coalesce(sum(check_amount), 0)', label: 'disbursement_batches_check_amount' },
  { table: 'disbursement_batches', expr: 'coalesce(sum(amount_reserved_cents), 0)', label: 'disbursement_batches_amount_reserved_cents' },
  { table: 'claim_check_payments', expr: 'coalesce(sum(check_amount), 0)', label: 'claim_check_payments_check_amount' },
  { table: 'claim_check_payments', expr: 'coalesce(sum(payment_amount), 0)', label: 'claim_check_payments_payment_amount' },
  { table: 'payment_transfers', expr: 'coalesce(sum(amount_cents), 0)', label: 'payment_transfers_amount_cents' },
  { table: 'payment_wallet_ledger', expr: 'coalesce(sum(amount_cents), 0)', label: 'payment_wallet_ledger_amount_cents' },
  { table: 'claim_payments', expr: 'coalesce(sum(amount), 0)', label: 'claim_payments_amount' },
  { table: 'homeowner_ledger_events', expr: 'coalesce(sum(amount), 0)', label: 'homeowner_ledger_amount' },
  {
    table: 'check_endorsements',
    expr: 'coalesce(sum(i.amount), 0)',
    label: 'endorsed_check_intake_amount',
    note: 'Join check_endorsements to check_intake_items; endorsement tables have no amount columns.',
  },
];

export const SENSITIVE_PUBLIC_TABLES = [
  'tenant_openai_credentials',
  'tenant_bank_accounts',
  'tenant_billing_accounts',
  'payment_methods',
  'payment_provider_accounts',
  'plaid_webhook_cursors',
];

export const STORAGE_BUCKETS = [
  'claim-files',
  'claim-files-backup',
  'deposit-attachments',
  'tenant-documents',
  'tenant-logos',
  'company-branding',
  'loss-draft-documents',
  'homeowner-uploads',
  'ai-knowledge-base',
  'contractor-documents',
  'document-templates',
  'email-assets',
  'endorsement-packets',
  'database_export_01_09_26',
];

export const WEBHOOK_EDGE_FUNCTIONS = [
  'moov-webhook',
  'plaid-transfer-webhook',
  'resend-webhook',
  'tenant-billing-webhook',
  'signature-webhook',
  'telnyx-sms-status',
  'checkalt-approve-deposit',
];

export const LANES = [
  'postgresql_schema',
  'public_application_data',
  'database_functions_triggers',
  'auth_users',
  'storage_objects',
  'rls_security_policies',
  'edge_functions_webhooks',
];

export const EXECUTE_ENV = 'CHECKSOPS_DB_COPY_EXECUTE';
export const EXECUTE_VALUE = 'I_UNDERSTAND_THIS_WRITES_DATA';

export const allCriticalTables = () =>
  [...new Set(Object.values(CRITICAL_TABLE_GROUPS).flat())];
