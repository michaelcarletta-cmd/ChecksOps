export const writesEnabled = () => String(process.env.AWS_WRITES_ENABLED || '') === 'true';

export const WRITE_OPS = new Set(['insert', 'update', 'upsert', 'delete', 'get_or_create']);

const IGNORED = new Set([
  'user_id',
  'application_user_id',
  'applicationUserId',
  'sub',
  'tenant_id',
  'tenantId',
  'org_id',
  'role',
  'created_by',
  'updated_by',
]);

export const CLIENT_IDENTITY_KEYS = IGNORED;

export const WRITE_ALLOWLIST = {
  check_message_reads: {
    ops: new Set(['insert', 'update', 'upsert', 'delete']),
    columns: new Set(['check_id', 'last_read_at']),
    identityColumn: 'user_id',
    requiredForWrite: { insert: ['check_id'], upsert: ['check_id'] },
    conflictTarget: ['user_id', 'check_id'],
    filterColumns: new Set(['check_id']),
    frontend: {
      file: 'src/components/check-messages/CheckMessageThread.tsx',
      op: 'upsert',
      reason: 'Marks a check message thread as read when the Messages UI loads. No money movement.',
    },
  },
  notification_preferences: {
    ops: new Set(['insert', 'update', 'delete', 'get_or_create']),
    columns: new Set(['in_app_enabled', 'email_enabled', 'sms_enabled']),
    identityColumn: 'user_id',
    requiredForWrite: { insert: [], upsert: [] },
    conflictTarget: ['user_id'],
    filterColumns: new Set(),
    frontend: {
      file: 'src/components/settings/NotificationPreferencesSettings.tsx',
      op: 'update + get_or_create_notification_preferences',
      reason: 'Stores in-app/email/SMS flags only. Does not send email or SMS.',
    },
  },
};

export const FINANCIAL_OR_PROVIDER_TABLES = new Set([
  'actum_transactions',
  'cash_job_payments',
  'check_intake_items',
  'checkalt_config',
  'checkalt_deposits',
  'checkalt_tenant_accounts',
  'claim_check_payments',
  'claim_disbursements',
  'claim_payments',
  'deposit_batches',
  'deposit_items',
  'disbursement_batches',
  'disbursement_splits',
  'homeowner_ledger_events',
  'payment_event_log',
  'payment_idempotency_keys',
  'payment_methods',
  'payment_provider_accounts',
  'payment_sweep_configs',
  'payment_transfer_groups',
  'payment_transfers',
  'payment_wallet_ledger',
  'payment_wallet_sub_ledgers',
  'payment_wallets',
  'payment_webhook_events',
  'payroll_runs',
  'plaid_transfer_events',
  'plaid_webhook_cursors',
  'platform_fee_line_items',
  'platform_fee_occurrences',
  'platform_fee_schedules',
  'tenant_credit_transactions',
  'tenant_wallet_funding_settings',
  'wallet_funding_queue',
  'wallet_funding_requests',
]);

export const denyTableReason = (table) => {
  if (WRITE_ALLOWLIST[table]) return null;
  if (FINANCIAL_OR_PROVIDER_TABLES.has(table)) return 'financial_or_provider';
  return 'unknown_table';
};

export const pickAllowlistedValues = (table, values = {}) => {
  const spec = WRITE_ALLOWLIST[table];
  if (!spec) {
    return { error: 'table_not_allowlisted', reason: denyTableReason(table), table };
  }
  const out = {};
  const denied = [];
  const ignored = [];
  for (const [key, value] of Object.entries(values || {})) {
    if (IGNORED.has(key) || key === spec.identityColumn) {
      ignored.push(key);
      continue;
    }
    if (!spec.columns.has(key)) {
      denied.push(key);
      continue;
    }
    out[key] = value;
  }
  if (denied.length) {
    return { error: 'column_not_allowlisted', columns: denied, table };
  }
  return { values: out, ignored, spec };
};
