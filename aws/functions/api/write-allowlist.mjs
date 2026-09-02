export const writesEnabled = () => String(process.env.AWS_WRITES_ENABLED || '') === 'true';

/** Independent T2 kill switch. Unset inherits AWS_WRITES_ENABLED. Explicit false disables check-workflow writes only. */
export const checkWorkflowWritesEnabled = () => {
  const value = process.env.AWS_CHECK_WORKFLOW_WRITES_ENABLED;
  if (value === undefined || value === '') return writesEnabled();
  return String(value) === 'true';
};

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

const INTAKE_SAFE_COLUMNS = [
  'carrier_name',
  'check_number',
  'issue_date',
  'payee_line',
  'property_address',
  'funds_type',
  'review_notes',
  'payee_address',
  'expiration_days',
  'is_multi_payee',
  'updated_at',
];

export const INTAKE_PROHIBITED_COLUMNS = new Set([
  'amount',
  'pa_fee_amount',
  'pa_fee_pct',
  'routing_number',
  'account_number',
  'status',
  'check_stage',
  'claim_id',
  'detected_claim_number',
  'deposit_recommendation',
  'deposit_recommendation_reasons',
  'deposited_at',
  'deposited_by_tenant_id',
  'mortgage_monitoring_type',
  'mortgage_received_at',
  'mortgage_final_released_at',
  'front_image_path',
  'back_image_path',
  'endorsement_packet_path',
  'endorsement_override',
  'partner_status',
  'partner_status_label',
  'check_source',
  'cash_job_id',
  'cash_job_payment_class',
  'uploaded_by',
  'reviewed_by',
]);

export const WRITE_ALLOWLIST = {
  check_message_reads: {
    tranche: 1,
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
    tranche: 1,
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
  check_intake_items: {
    tranche: 2,
    ops: new Set(['update']),
    columns: new Set(INTAKE_SAFE_COLUMNS),
    identityColumn: null,
    requiredForWrite: { update: [] },
    filterColumns: new Set(['id']),
    resource: 'check',
    clientIgnored: new Set(['id']),
    frontend: {
      file: 'CheckCommandCenter EditableField / ReviewDecisionPanel persistMeta / CheckAdminEditDialog (safe fields only)',
      op: 'update',
      reason: 'Descriptive/workflow metadata only. Status, amounts, routing, deposit, and mortgage fields stay denied.',
    },
  },
  check_payees: {
    tranche: 2,
    ops: new Set(['insert', 'update', 'delete']),
    columns: new Set(['check_id', 'payee_name', 'payee_type', 'contact_email', 'contact_phone', 'updated_at']),
    identityColumn: null,
    requiredForWrite: { insert: ['check_id', 'payee_name'] },
    filterColumns: new Set(['id', 'check_id']),
    resource: 'check',
    clientIgnored: new Set([
      'id',
      'endorsement_token',
      'endorsement_token_expires_at',
      'endorsement_status',
      'endorsed_at',
      'endorsement_image_path',
      'notification_delivery_status',
      'notification_error',
      'notification_sent_at',
      'notification_sent_via',
    ]),
    frontend: {
      file: 'PayeeManager / PayeeReconciliation / EndorsementChecklist add/edit/remove',
      op: 'insert/update/delete',
      reason: 'Payee record management. Does not send endorsement email or invoke Moov/KYC.',
    },
  },
  check_endorsements: {
    tranche: 2,
    ops: new Set(['update', 'delete']),
    columns: new Set(['payee_name', 'payee_type', 'contact_email', 'contact_phone', 'notes', 'updated_at']),
    identityColumn: null,
    requiredForWrite: { update: [] },
    filterColumns: new Set(['id', 'payee_id', 'check_id']),
    resource: 'check',
    clientIgnored: new Set(['id', 'check_id']),
    frontend: {
      file: 'EndorsementChecklist contact metadata / payee remove',
      op: 'update/delete',
      reason: 'Endorsement contact/name metadata and pending-row delete. Status/signed_at stay denied (stage + partner HTTP side effects).',
    },
  },
  check_endorsement_events: {
    tranche: 2,
    ops: new Set(['delete']),
    columns: new Set([]),
    identityColumn: null,
    requiredForWrite: { delete: [] },
    filterColumns: new Set(['id', 'payee_id', 'check_id']),
    resource: 'check',
    frontend: {
      file: 'PayeeManager / EndorsementChecklist removePayee',
      op: 'delete',
      reason: 'Cleanup endorsement event rows when removing a payee. No inserts (those can be signature/send telemetry).',
    },
  },
  check_audit_log: {
    tranche: 2,
    ops: new Set(['insert']),
    columns: new Set(['check_id', 'event_type', 'event_description', 'event_data']),
    identityColumn: 'actor_id',
    requiredForWrite: { insert: ['check_id', 'event_type'] },
    filterColumns: new Set(['check_id']),
    resource: 'check',
    clientIgnored: new Set(['id', 'created_at']),
    frontend: {
      file: 'CheckReviewConsole / CheckAdminEditDialog / payee corrections',
      op: 'insert',
      reason: 'Operational audit notes. actor_id and tenant_id are server-derived.',
    },
  },
  check_messages: {
    tranche: 2,
    ops: new Set(['update']),
    columns: new Set(['is_deleted', 'updated_at']),
    identityColumn: 'sender_id',
    requiredForWrite: { update: [] },
    filterColumns: new Set(['id', 'check_id']),
    resource: 'check',
    frontend: {
      file: 'CheckMessageThread deleteMutation',
      op: 'update is_deleted',
      reason: 'Soft-delete only. INSERT stays disabled because trg_mirror_check_message_to_homeowner_ledger writes homeowner_ledger_events.',
    },
  },
};

export const FINANCIAL_OR_PROVIDER_TABLES = new Set([
  'actum_transactions',
  'cash_job_payments',
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
  const extraIgnored = spec.clientIgnored || new Set();
  const out = {};
  const denied = [];
  const ignored = [];
  for (const [key, value] of Object.entries(values || {})) {
    if (IGNORED.has(key) || key === spec.identityColumn || extraIgnored.has(key)) {
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
