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
  // Endorsement adjuster + deposit artifact pointers (non-financial).
  // These must be writable on AWS staging so Adjust Endorsement can persist the
  // clean original and the deposit-ready image without overwriting it.
  'back_image_deposit_path',
  'endorsement_override',
  'endorsement_render_status',
  'endorsement_render_meta',
  'updated_at',
];

/**
 * Endorsement workflow writes (Adjust Endorsement).
 * These fields are required for:
 * - saving placement (`endorsement_override`, `endorsement_render_status`)
 * - saving generated endorsed deposit artifact (`back_image_deposit_path`, `endorsement_render_meta`)
 *
 * These remain tenant- and check-scoped via the check-workflow write executor.
 */
const INTAKE_ENDORSEMENT_COLUMNS = [
  'endorsement_override',
  'endorsement_render_status',
  'endorsement_render_meta',
  'back_image_deposit_path',
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
    columns: new Set([...INTAKE_SAFE_COLUMNS, ...INTAKE_ENDORSEMENT_COLUMNS, ...T5_INTAKE_COLUMNS]),
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
  notifications: {
    tranche: 6,
    ops: new Set(['update']),
    columns: new Set(['is_read']),
    identityColumn: 'user_id',
    requiredForWrite: { update: [] },
    filterColumns: new Set(['id', 'user_id', 'is_read']),
    frontend: { file: 'NotificationPopover', op: 'update is_read', reason: 'Mark own notifications read.' },
  },
  tenant_documents: {
    tranche: 6,
    ops: new Set(['insert', 'update', 'delete']),
    columns: new Set([
      'tenant_id', 'doc_type', 'file_path', 'file_name', 'mime_type', 'file_size',
      'auto_share_mortgage_ops', 'notes', 'updated_at',
    ]),
    identityColumn: 'uploaded_by',
    requiredForWrite: { insert: ['tenant_id', 'doc_type', 'file_path'] },
    filterColumns: new Set(['id', 'tenant_id']),
    clientIgnored: new Set(['id', 'created_at']),
    frontend: { file: 'TenantDocumentLibrary', op: 'insert/update/delete', reason: 'Tenant library metadata only.' },
  },
  mortgage_request_library_documents: {
    tranche: 6,
    ops: new Set(['insert', 'upsert']),
    columns: new Set([
      'request_id', 'tenant_id', 'tenant_document_id', 'doc_type',
      'file_name', 'file_path', 'mime_type', 'file_size', 'bucket',
    ]),
    identityColumn: null,
    requiredForWrite: { insert: ['request_id', 'tenant_document_id'], upsert: ['request_id', 'tenant_document_id'] },
    filterColumns: new Set(['request_id', 'tenant_id', 'tenant_document_id', 'file_path']),
    clientIgnored: new Set(['id', 'created_at', 'updated_at', 'bucket']),
    frontend: {
      file: 'TenantDocumentLibrary',
      op: 'insert/upsert',
      reason: 'Backfill qualifying library:mortgage:% docs onto open Mortgage Desk requests. Server re-reads document and request rows.',
    },
  },
  loss_draft_documents: {
    tranche: 6,
    ops: new Set(['update', 'delete']),
    columns: new Set(['file_path', 'file_name', 'document_label', 'is_submitted', 'submitted_at', 'notes']),
    identityColumn: null,
    requiredForWrite: { update: [] },
    filterColumns: new Set(['id', 'loss_draft_id']),
    clientIgnored: new Set(['id', 'created_at', 'signature_request_id', 'amount']),
    frontend: { file: 'LossDraftDocsManager', op: 'update/delete', reason: 'Document metadata; no escrow amounts.' },
  },
  mortgage_companies: {
    tranche: 6,
    ops: new Set(['insert', 'update']),
    columns: new Set([
      'name', 'is_active', 'website', 'phone', 'loss_draft_email', 'loss_draft_phone',
      'loss_draft_fax', 'loss_draft_contact',
    ]),
    identityColumn: null,
    requiredForWrite: { insert: ['name'] },
    filterColumns: new Set(['id']),
    frontend: { file: 'MortgageOpsDirectory', op: 'insert/update', reason: 'Directory contact metadata.' },
  },
  shared_check_messages: {
    tranche: 6,
    ops: new Set(['insert']),
    columns: new Set(['check_id', 'body']),
    identityColumn: 'sender_user_id',
    requiredForWrite: { insert: ['check_id', 'body'] },
    filterColumns: new Set(['check_id']),
    clientIgnored: new Set(['id', 'created_at', 'sender_tenant_id', 'sender_user_id']),
    frontend: { file: 'SharedCheckThread', op: 'insert', reason: 'Partner chat notes; sender_* server-derived.' },
  },
  tenant_users: {
    tranche: 6,
    ops: new Set(['update', 'delete']),
    columns: new Set(['role']),
    identityColumn: null,
    requiredForWrite: { update: ['role'] },
    filterColumns: new Set(['id', 'tenant_id', 'user_id']),
    clientIgnored: new Set(['id', 'created_at', 'updated_at', 'tenant_id', 'user_id']),
    frontend: {
      file: 'TenantUserManagement',
      op: 'update role / delete membership',
      reason: 'Tenant-scoped membership only. Does not touch user_roles or is_master_owner().',
    },
  },
  profiles: {
    tranche: 6,
    ops: new Set(['update']),
    columns: new Set(['full_name', 'phone']),
    identityColumn: null,
    requiredForWrite: { update: [] },
    filterColumns: new Set(['id']),
    clientIgnored: new Set(['id', 'email', 'approval_status', 'created_at', 'preferred_auth_method']),
    frontend: { file: 'AccountSecurity', op: 'update', reason: 'Self profile name/phone only (staging schema).' },
  },
  company_branding: {
    tranche: 6,
    ops: new Set(['insert', 'update', 'upsert']),
    columns: new Set([
      'company_name', 'company_address', 'company_email', 'company_phone',
      'letterhead_url', 'endorsement_email_subject', 'endorsement_email_body',
    ]),
    identityColumn: null,
    requiredForWrite: { insert: [], update: [] },
    filterColumns: new Set(['id']),
    clientIgnored: new Set(['id', 'created_at', 'zapier_webhook_url', 'online_check_writer_bank_account_id']),
    frontend: { file: 'CompanyBrandingSettings', op: 'upsert', reason: 'Branding text/URLs only.' },
  },
  referral_alerts: {
    tranche: 6,
    ops: new Set(['update']),
    columns: new Set(['is_dismissed', 'is_actioned', 'actioned_at']),
    identityColumn: null,
    requiredForWrite: { update: [] },
    filterColumns: new Set(['id', 'claim_id']),
    frontend: { file: 'useReferralAlerts', op: 'update', reason: 'Dismiss/action flags only.' },
  },
  tenants: {
    tranche: 6,
    ops: new Set(['insert', 'update']),
    columns: new Set([
      'name', 'slug', 'logo_url', 'invoice_letterhead_url', 'primary_color',
      'secondary_color', 'invoice_footer_note', 'invoice_default_terms',
      'custom_domain', 'subscription_status', 'plan_tier',
      'is_test_account', 'moov_environment', 'max_checks_per_month',
      'is_founding_partner', 'monthly_rate_cents', 'kyc_status',
      'kyc_notes', 'internal_notes',
    ]),
    identityColumn: null,
    requiredForWrite: { insert: ['name', 'slug'], update: [] },
    filterColumns: new Set(['id']),
    clientIgnored: new Set(['id', 'created_at']),
    frontend: {
      file: 'AdminTenants / TenantManagement',
      op: 'update',
      reason: 'Member branding plus platform-owner Tenant Management fields. Provider allowlist flags stay denied.',
    },
  },
  privacy_notice_acknowledgments: {
    tranche: 6,
    ops: new Set(['insert']),
    columns: new Set(['notice_version', 'version']),
    identityColumn: 'user_id',
    requiredForWrite: { insert: [] },
    filterColumns: new Set([]),
    clientIgnored: new Set(['id', 'acknowledged_at', 'created_at']),
    frontend: { file: 'Privacy notice UI', op: 'insert', reason: 'Ack own notice; user_id server-derived.' },
  },
  cash_jobs: {
    tranche: 6,
    ops: new Set(['insert', 'update', 'delete']),
    columns: new Set([
      'tenant_id',
      'job_name', 'work_type', 'customer_name', 'customer_phone', 'customer_email',
      'property_address', 'property_city', 'property_state', 'property_zip',
      'contract_amount', 'estimate_date', 'start_date', 'completion_date',
      'description', 'notes', 'status', 'updated_at',
    ]),
    identityColumn: 'created_by',
    requiredForWrite: { insert: ['job_name', 'customer_name', 'tenant_id'] },
    filterColumns: new Set(['id', 'tenant_id']),
    clientIgnored: new Set(['id', 'created_at', 'total_paid', 'balance_due', 'created_by']),
    frontend: {
      file: 'CashJobForm',
      op: 'insert/update/delete',
      reason: 'Job estimate CRUD. Denies total_paid/balance_due; cash_job_payments stays financial.',
    },
  },
  cash_job_line_items: {
    tranche: 6,
    ops: new Set(['insert', 'update', 'delete']),
    columns: new Set([
      'cash_job_id', 'tenant_id', 'description', 'quantity', 'unit_price', 'sort_order', 'total',
    ]),
    identityColumn: null,
    requiredForWrite: { insert: ['cash_job_id', 'tenant_id', 'description'] },
    filterColumns: new Set(['id', 'cash_job_id', 'tenant_id']),
    clientIgnored: new Set(['id', 'created_at']),
    frontend: { file: 'CashJobForm', op: 'insert/delete', reason: 'Line-item metadata for cash jobs.' },
  },
  cash_job_attachments: {
    tranche: 6,
    ops: new Set(['insert', 'delete']),
    columns: new Set([
      'cash_job_id', 'tenant_id', 'file_path', 'file_name', 'file_type', 'file_size', 'attachment_type',
    ]),
    identityColumn: 'uploaded_by',
    requiredForWrite: { insert: ['cash_job_id', 'tenant_id', 'file_path', 'file_name'] },
    filterColumns: new Set(['id', 'cash_job_id', 'tenant_id']),
    clientIgnored: new Set(['id', 'created_at', 'uploaded_by']),
    frontend: { file: 'CashJobDetail', op: 'insert/delete', reason: 'Attachment metadata only.' },
  },
  homeowner_ledger_events: {
    tranche: 6,
    ops: new Set(['insert']),
    columns: new Set([
      'tenant_id', 'claim_id', 'check_id', 'case_id', 'event_type',
      'occurred_at', 'actor_label', 'payload_json',
    ]),
    identityColumn: 'created_by',
    requiredForWrite: { insert: ['tenant_id', 'claim_id', 'event_type'] },
    filterColumns: new Set(['id', 'tenant_id', 'claim_id']),
    clientIgnored: new Set(['id', 'created_at', 'created_by', 'amount']),
    frontend: {
      file: 'PostHomeownerUpdateCard / MortgageOps',
      op: 'insert',
      reason: 'Timeline notes only. amount is ignored/denied; no payment movement.',
    },
  },
  financial_stepup_log: {
    tranche: 7,
    ops: new Set(['insert']),
    columns: new Set(['tenant_id', 'action_key', 'factor_type', 'succeeded', 'metadata']),
    identityColumn: 'user_id',
    requiredForWrite: { insert: ['action_key'] },
    filterColumns: new Set([]),
    clientIgnored: new Set(['id', 'created_at', 'updated_at']),
    frontend: {
      file: 'StepUpDialog',
      op: 'insert',
      reason: 'Append-only TOTP step-up audit. user_id is server-derived. Not a money-movement table.',
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
  'recipient_tax_profiles',
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
    // Always ignore server-owned identity column (e.g. created_by / uploaded_by).
    if (key === spec.identityColumn || extraIgnored.has(key)) {
      ignored.push(key);
      continue;
    }
    // Global identity keys are ignored unless this table explicitly allowlists them
    // (e.g. tenant_id on membership-scoped inserts — executor still verifies membership).
    if (IGNORED.has(key) && !spec.columns.has(key)) {
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
