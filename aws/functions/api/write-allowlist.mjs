export const writesEnabled = () => String(process.env.AWS_WRITES_ENABLED || '') === 'true';

/** Independent T2/T3 kill switch. Unset inherits AWS_WRITES_ENABLED. Explicit false disables check-workflow writes only. */
export const checkWorkflowWritesEnabled = () => {
  const value = process.env.AWS_CHECK_WORKFLOW_WRITES_ENABLED;
  if (value === undefined || value === '') return writesEnabled();
  return String(value) === 'true';
};

/** Storage upload/delete/move. Unset inherits AWS_WRITES_ENABLED. Explicit false disables storage writes only. */
export const storageWritesEnabled = () => {
  const value = process.env.AWS_STORAGE_WRITES_ENABLED;
  if (value === undefined || value === '') return writesEnabled();
  return String(value) === 'true';
};

/** Tranche 5 application-workflow writes. Only the string `true` enables. Independent of T1–T4. */
export { applicationWorkflowWritesEnabled } from './workflow-flags.mjs';

export const T5_INTAKE_COLUMNS = new Set([
  'mortgage_monitoring_type',
  'mortgage_sent_at',
  'mortgage_tracking_number',
  'mortgage_received_at',
]);

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
  'front_image_path',
  'back_image_path',
  'back_image_original_path',
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
  'mortgage_final_released_at',
  'endorsement_packet_path',
  'back_image_deposit_path',
  'endorsement_render_status',
  'endorsement_render_meta',
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
    columns: new Set([...INTAKE_SAFE_COLUMNS, ...T5_INTAKE_COLUMNS]),
    t5Columns: T5_INTAKE_COLUMNS,
    identityColumn: null,
    requiredForWrite: { update: [] },
    filterColumns: new Set(['id']),
    resource: 'check',
    clientIgnored: new Set(['id']),
    frontend: {
      file: 'CheckCommandCenter EditableField / ReviewDecisionPanel persistMeta / CheckAdminEditDialog / CheckMortgageMonitoring',
      op: 'update',
      reason: 'T2 descriptive + image paths. T5 adds mortgage monitoring timestamps (not final release, not status/amount).',
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
    tranche: 3,
    ops: new Set(['insert', 'update']),
    columns: new Set(['check_id', 'body', 'is_deleted', 'updated_at']),
    identityColumn: 'sender_id',
    requiredForWrite: { insert: ['check_id', 'body'], update: [] },
    filterColumns: new Set(['id', 'check_id']),
    resource: 'check',
    clientIgnored: new Set(['id', 'created_at']),
    frontend: {
      file: 'CheckMessageThread sendMutation / deleteMutation',
      op: 'insert + update is_deleted',
      reason: 'Internal check notes. INSERT keeps trg_mirror_check_message_to_homeowner_ledger (ops_note, no amount). sender_id is server-derived.',
    },
  },
  check_files: {
    tranche: 3,
    ops: new Set(['insert', 'update', 'delete']),
    columns: new Set([
      'check_intake_item_id',
      'file_name',
      'file_path',
      'file_type',
      'file_size',
      'category',
      'source',
      'description',
    ]),
    identityColumn: 'uploaded_by',
    requiredForWrite: { insert: ['check_intake_item_id', 'file_name', 'file_path'] },
    filterColumns: new Set(['id', 'check_intake_item_id']),
    resource: 'check',
    clientIgnored: new Set(['id', 'created_at', 'signature_request_id']),
    frontend: {
      file: 'CheckFilesSection upload/delete',
      op: 'insert/update/delete',
      reason: 'Metadata for S3 objects under check-scoped prefixes. INSERT keeps trg_mirror_check_file_to_homeowner_ledger (document_uploaded, no amount).',
    },
  },
  loss_draft_tracking: {
    tranche: 5,
    ops: new Set(['insert', 'update']),
    columns: new Set([
      'check_intake_item_id',
      'mortgage_servicer',
      'mortgage_company_id',
      'loan_number',
      'lender_website_url',
      'loss_draft_contact',
      'loss_draft_email',
      'loss_draft_phone',
      'loss_draft_fax',
      'notes',
      'monitoring_type',
      'escrow_status',
      'tracking_number_sent',
      'tracking_number_return',
      'shipping_method_sent',
      'shipping_method_return',
      'check_sent_date',
      'check_received_date',
      'check_received_back_date',
      'follow_up_date',
      'last_contact_at',
      'updated_at',
    ]),
    identityColumn: 'created_by',
    requiredForWrite: { insert: ['check_intake_item_id', 'mortgage_servicer'] },
    filterColumns: new Set(['id', 'check_intake_item_id']),
    resource: 'check',
    clientIgnored: new Set(['id', 'claim_id', 'created_at', 'total_escrowed', 'holdback_amount', 'draw_amount_released', 'draw_amount_requested']),
    frontend: {
      file: 'MortgageContactCard / NewLossDraftDialog / useLossDraft',
      op: 'insert/update',
      reason: 'Internal loss-draft metadata. Amount-released and external-send success stay denied.',
    },
  },
  mortgage_handling_requests: {
    tranche: 5,
    ops: new Set(['insert', 'update']),
    columns: new Set([
      'check_intake_item_id',
      'mortgage_company',
      'mortgage_servicer',
      'loan_number',
      'note',
      'work_notes',
      'property_address',
      'claim_number',
      'insurance_company',
      'homeowner_name',
      'homeowner_email',
      'homeowner_phone',
      'status',
      'updated_at',
    ]),
    identityColumn: 'requested_by',
    requiredForWrite: { insert: ['check_intake_item_id'] },
    filterColumns: new Set(['id', 'check_intake_item_id']),
    resource: 'check',
    clientIgnored: new Set([
      'id',
      'tenant_id',
      'claim_id',
      'created_at',
      'billed_at',
      'billing_status',
      'billing_error',
      'flat_fee_cents',
      'stripe_invoice_id',
      'stripe_invoice_item_id',
      'invoice_sent_at',
      'invoice_url',
      'invoice_number',
      'completed_at',
      'accepted_at',
      'assigned_employee_id',
    ]),
    frontend: {
      file: 'CheckMortgageMonitoring / SendToMortgageDeskButton',
      op: 'insert/update',
      reason: 'Internal mortgage-desk request metadata. Notify/bill edge functions stay provider_disabled.',
    },
  },
  loss_draft_audit_log: {
    tranche: 5,
    ops: new Set(['insert']),
    columns: new Set(['loss_draft_id', 'action', 'notes']),
    identityColumn: 'actor_id',
    requiredForWrite: { insert: ['loss_draft_id', 'action'] },
    filterColumns: new Set(['loss_draft_id']),
    resource: 'check',
    clientIgnored: new Set(['id', 'created_at', 'amount']),
    frontend: {
      file: 'loss-draft audit notes',
      op: 'insert',
      reason: 'Internal notes only. Amount column is ignored.',
    },
  },
  claim_checks: {
    tranche: 3,
    ops: new Set(['update']),
    columns: new Set([
      'carrier_name',
      'check_number',
      'payee_line',
      'notes',
      'check_date',
      'received_date',
      'ocr_needs_verification',
      'updated_at',
    ]),
    identityColumn: null,
    requiredForWrite: { update: [] },
    filterColumns: new Set(['id', 'check_intake_item_id']),
    resource: 'check',
    clientIgnored: new Set(['id', 'claim_id', 'created_by']),
    frontend: {
      file: 'CheckAdminEditDialog descriptive OCR mirror',
      op: 'update',
      reason: 'Descriptive mirrors only. Amount, deposit, mortgage, stage, and endorsement_status stay denied.',
    },
  },
  audit_logs: {
    tranche: 1,
    ops: new Set(['insert']),
    columns: new Set(['action', 'record_type', 'record_id', 'old_values', 'new_values', 'metadata']),
    identityColumn: 'user_id',
    requiredForWrite: { insert: ['action', 'record_type'] },
    filterColumns: new Set([]),
    clientIgnored: new Set(['id', 'created_at', 'ip_address', 'user_agent']),
    frontend: {
      file: 'useAuditLog / masked-field / usePIIMasking',
      op: 'insert (via log_audit RPC bridge preferred)',
      reason: 'Append-only audit metadata. user_id is server-derived.',
    },
  },
  user_sessions: {
    tranche: 1,
    ops: new Set(['insert', 'update']),
    columns: new Set([
      'session_token',
      'device_info',
      'ip_address',
      'is_active',
      'last_activity_at',
      'expires_at',
      'role_version',
    ]),
    identityColumn: 'user_id',
    requiredForWrite: { insert: ['session_token'] },
    filterColumns: new Set(['id', 'session_token']),
    clientIgnored: new Set(['id', 'created_at']),
    frontend: {
      file: 'useSessionSecurity',
      op: 'insert/update (via session RPC bridges preferred)',
      reason: 'Own-session bookkeeping only. user_id is server-derived.',
    },
  },
  homeowner_intro_requests: {
    tranche: 5,
    ops: new Set(['insert', 'update']),
    columns: new Set([
      'contractor_profile_id',
      'homeowner_name',
      'homeowner_email',
      'homeowner_phone',
      'property_zip',
      'loss_type',
      'message',
      'status',
      'contacted_at',
      'accepted_at',
      'updated_at',
    ]),
    identityColumn: null,
    requiredForWrite: { insert: ['contractor_profile_id', 'homeowner_name', 'homeowner_email'] },
    filterColumns: new Set(['id', 'contractor_profile_id', 'contractor_user_id', 'access_token']),
    clientIgnored: new Set([
      'id',
      'created_at',
      'access_token',
      'contractor_user_id',
      'ip_hash',
      'source',
      'dtp_claim_number',
      'dtp_insurance_carrier',
      'dtp_policy_number',
      'dtp_property_address',
      'dtp_signature_ip',
      'dtp_signature_name',
      'dtp_signature_user_agent',
      'dtp_signed_at',
    ]),
    frontend: {
      file: 'HomeownerIntroRequestModal / ContractorLeadsCard',
      op: 'insert/update',
      reason: 'Lead intake + contractor workflow status. Email notify stays provider_disabled.',
    },
  },
  check_cases: {
    tranche: 5,
    ops: new Set(['insert', 'update']),
    columns: new Set([
      'tenant_id',
      'external_system',
      'external_claim_id',
      'external_reference',
      'claim_number',
      'insured_name',
      'insured_email',
      'insured_phone',
      'property_address',
      'carrier_name',
      'policy_number',
      'mortgage_company_id',
      'loan_number',
      'loss_date',
      'status',
      'updated_at',
    ]),
    identityColumn: null,
    requiredForWrite: { insert: ['tenant_id'] },
    filterColumns: new Set(['id', 'tenant_id', 'external_claim_id', 'claim_number']),
    resource: 'tenant',
    clientIgnored: new Set(['id', 'created_at']),
    frontend: {
      file: 'checkCases.resolveCheckCase / case metadata editors',
      op: 'insert/update',
      reason: 'Non-financial case identity metadata only.',
    },
  },
  contractor_profiles: {
    tranche: 5,
    ops: new Set(['update']),
    columns: new Set([
      'display_name',
      'bio',
      'phone',
      'website',
      'service_areas',
      'directory_opt_in',
      'is_directory_listed',
      'updated_at',
    ]),
    identityColumn: null,
    requiredForWrite: { update: [] },
    filterColumns: new Set(['id', 'user_id']),
    clientIgnored: new Set([
      'id',
      'user_id',
      'tier',
      'pro_approved_at',
      'pro_approved_by',
      'verified_at',
      'moov_account_id',
      'created_at',
    ]),
    frontend: {
      file: 'Settings contractor profile / directory listing',
      op: 'update',
      reason: 'Directory/profile metadata only. Pro approval goes through admin_set_contractor_pro bridge. Moov IDs denied.',
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
