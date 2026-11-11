import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PUBLIC_TRIGGER_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const PUBLIC_TRIGGER_ENABLED = new Set(['O', 'D', 'R', 'A']);
export const PUBLIC_TRIGGER_DEFINITION_RE = /^CREATE (CONSTRAINT )?TRIGGER /;
export const PUBLIC_TRIGGER_DEFINITION_MAX = 2048;

export const sanitizePublicTriggerRow = (row = {}) => {
  const table = String(row.table_name || '');
  const trigger = String(row.trigger_name || '');
  const enabled = String(row.enabled || '');
  const functionName = String(row.function_name || '');
  if (!PUBLIC_TRIGGER_IDENT_RE.test(table)
      || !PUBLIC_TRIGGER_IDENT_RE.test(trigger)
      || !PUBLIC_TRIGGER_ENABLED.has(enabled)
      || !PUBLIC_TRIGGER_IDENT_RE.test(functionName)) {
    return null;
  }
  const result = { table, trigger, enabled, functionName };
  const definition = String(row.definition || '');
  if (definition
      && definition.length <= PUBLIC_TRIGGER_DEFINITION_MAX
      && PUBLIC_TRIGGER_DEFINITION_RE.test(definition)) {
    result.definition = definition;
  }
  return result;
};

const CLASSIFIED_PATH = fileURLToPath(new URL(
  '../../aws/db-copy/analysis/triggers_classified.json',
  import.meta.url,
));

export const RESTORE_PUBLIC_TRIGGER_COUNT = 164;

export const STEPUP_TRIGGER = Object.freeze({
  table: 'financial_stepup_log',
  trigger: 'trg_financial_stepup_log_updated_at',
  functionName: 'set_updated_at_generic',
});

export const SUPERSEDED_PUBLIC_TRIGGERS = Object.freeze([
  Object.freeze({
    table: 'check_endorsements',
    trigger: 'trg_advance_on_endorsement_complete',
    functionName: 'advance_check_on_endorsement_complete',
  }),
  // SQL 95 (95_remove_freedom_claims_bridge.sql) drops the Freedom bridge trigger.
  Object.freeze({
    table: 'check_intake_items',
    trigger: 'trg_notify_freedom_status_change',
    functionName: 'notify_freedom_status_change',
  }),
]);

export const POST_RESTORE_PUBLIC_TRIGGERS = Object.freeze([
  Object.freeze({
    table: 'check_intake_items',
    trigger: 'trg_guard_check_claim_link',
    functionName: 'trg_guard_check_claim_link',
  }),
  Object.freeze({
    table: 'identity_accounts',
    trigger: 'identity_protect_production_cognito',
    functionName: 'identity_protect_production_cognito',
  }),
  Object.freeze({
    table: 'identity_production_cognito_locks',
    trigger: 'identity_protect_production_cognito_locks',
    functionName: 'identity_protect_production_cognito_locks',
  }),
  Object.freeze({
    table: 'mortgage_agent_compensation_entries',
    trigger: 'tr_protect_mortgage_agent_compensation_facts',
    functionName: 'tg_protect_mortgage_agent_compensation_facts',
  }),
  Object.freeze({
    table: 'mortgage_handling_requests',
    trigger: 'tr_accrue_mortgage_ops_billing',
    functionName: 'tg_accrue_mortgage_ops_billing',
  }),
  Object.freeze({
    table: 'mortgage_handling_requests',
    trigger: 'tr_earn_mortgage_agent_compensation',
    functionName: 'tg_earn_mortgage_agent_compensation',
  }),
  Object.freeze({
    table: 'mortgage_handling_requests',
    trigger: 'tr_reject_inactive_mortgage_agent_accept',
    functionName: 'tg_reject_inactive_mortgage_agent_accept',
  }),
  Object.freeze({
    table: 'tenants',
    trigger: 'trg_apply_tenant_moov_ga_defaults',
    functionName: 'apply_tenant_moov_ga_defaults',
  }),
  // SQL 76 (aws/workflows/sql/76_tenant_partnership_invitee_consent.sql): only the
  // invitee side or Partner Code redemption can make a partnership live.
  Object.freeze({
    table: 'tenant_partnerships',
    trigger: 'aws_tenant_partnership_consent_guard',
    functionName: 'aws_tenant_partnership_consent_guard',
  }),
  // Release migrations 94-102 (aws/workflows/sql/), applied to staging.
  Object.freeze({
    table: 'financial_stepup_log',
    trigger: 'aws_financial_stepup_log_writer_guard',
    functionName: 'aws_financial_stepup_log_writer_guard',
  }),
  Object.freeze({
    table: 'homeowner_shared_documents',
    trigger: 'homeowner_shared_documents_guard',
    functionName: 'aws_homeowner_shared_documents_guard',
  }),
  Object.freeze({
    table: 'mortgage_handling_requests',
    trigger: 'tr_mortgage_desk_completion_messages',
    functionName: 'aws_mortgage_desk_completion_messages',
  }),
  Object.freeze({
    table: 'platform_billing_destination',
    trigger: 'aws_platform_billing_destination_audit',
    functionName: 'aws_platform_billing_destination_audit_row',
  }),
  Object.freeze({
    table: 'tenants',
    trigger: 'aws_tenant_deposits_enabled_audit',
    functionName: 'aws_tenant_deposits_enabled_audit_row',
  }),
  Object.freeze({
    table: 'tenants',
    trigger: 'aws_tenant_pricing_audit',
    functionName: 'aws_tenant_pricing_audit_row',
  }),
  Object.freeze({
    table: 'tenants',
    trigger: 'aws_tenant_profile_audit',
    functionName: 'aws_tenant_profile_audit_row',
  }),
  Object.freeze({
    table: 'tenants',
    trigger: 'aws_tenants_member_column_guard',
    functionName: 'aws_tenants_member_column_guard',
  }),
  // SQL 120 (120_usage_events_at_approval_and_send.sql), applied to staging 2026-10-27
  // (run 40547527832) and production (#1304): usage events at Check Alt approval and send time.
  Object.freeze({
    table: 'checkalt_deposits',
    trigger: 'aws_checkalt_deposit_billing_event',
    functionName: 'aws_record_checkalt_billing_event',
  }),
  Object.freeze({
    table: 'payment_transfers',
    trigger: 'aws_payment_transfer_send_speed_fee',
    functionName: 'aws_record_send_speed_fee',
  }),  // SQL 121 (121_cash_jobs_production_grants.sql), applied to staging 2026-10-27 (run 40591140684):
  // the cash-job payment recorded when a Check Alt deposit is approved or accepted.
  Object.freeze({
    table: 'checkalt_deposits',
    trigger: 'aws_checkalt_deposit_cash_job_payment',
    functionName: 'aws_record_cash_job_checkalt_payment',
  }),  // SQL 123 (123_checkalt_deposit_check_status.sql), applied to staging 2026-10-28 (run 40721665524)
  // and production (#1336): the check's status follows its Check Alt deposit's status.
  Object.freeze({
    table: 'checkalt_deposits',
    trigger: 'aws_checkalt_deposit_apply_check_status',
    functionName: 'aws_apply_checkalt_check_status',
  }),  // SQL 143 (143_mortgage_companies_member_delete_unused.sql), applied to staging 2026-11-05 (run 42023495275):
  // a mortgage company a claim, loss draft or check case uses is not deleted.
  Object.freeze({
    table: 'mortgage_companies',
    trigger: 'aws_mortgage_company_in_use_guard',
    functionName: 'aws_mortgage_company_in_use_guard',
  }),  // SQL 152 (152_invoice_and_failed_deposit_fees.sql), applied to staging 2026-11-11 (run 43005316840)
  // and production (SSM cae61362, #1764): the $0.30 invoice fee once an invoice is sent and the $2.00
  // failed deposit fee once a Check Alt deposit fails.
  Object.freeze({
    table: 'moov_invoices',
    trigger: 'aws_moov_invoice_fee',
    functionName: 'aws_record_invoice_fee',
  }),
  Object.freeze({
    table: 'checkalt_deposits',
    trigger: 'aws_checkalt_deposit_failed_fee',
    functionName: 'aws_record_failed_deposit_fee',
  }),  // SQL 154 (154_tenant_starter_package.sql), applied to staging 2026-11-11 (run 43063499920; production
  // pending): a check fee or failed deposit fee uses one of the Starter Package's included Checks, and a
  // change to a tenant's Starter Package columns is written to tenant_pricing_audit.
  Object.freeze({
    table: 'check_billing_events',
    trigger: 'aws_check_billing_event_starter_package',
    functionName: 'aws_apply_starter_package_to_event',
  }),
  Object.freeze({
    table: 'tenants',
    trigger: 'aws_tenant_starter_package_audit',
    functionName: 'aws_tenant_starter_package_audit_row',
  }),
  // SQL 155 (155_claim_owner_org_stamp.sql), applied to staging 2026-11-11 (run 43082131132, wave 47); production
  // already had it (applied directly on 2026-09-22; verified live as intended, SSM 373a7d5c, nothing applied): a
  // claim's org_id is stamped from its owning tenant.
  Object.freeze({
    table: 'claims',
    trigger: 'trg_aws_stamp_claim_org_id',
    functionName: 'aws_stamp_claim_org_id',
  }),
]);

export const JUSTIFIED_PUBLIC_TRIGGER_COUNT = 190;

const unqualified = (value) => {
  const text = String(value || '');
  const parts = text.split('.');
  return parts[parts.length - 1] || '';
};

const triggerKey = (row) => `${row.table}\0${row.trigger}`;

export const loadRestorePublicTriggers = () => {
  const classified = JSON.parse(readFileSync(CLASSIFIED_PATH, 'utf8'));
  return (classified.public || []).map((row) => ({
    table: row.table,
    trigger: row.trigger,
    functionName: unqualified(row.function),
  }));
};

export const loadJustifiedPublicTriggers = () => {
  const restore = loadRestorePublicTriggers();
  const removed = new Set(SUPERSEDED_PUBLIC_TRIGGERS.map(triggerKey));
  const justified = restore.filter((row) => !removed.has(triggerKey(row)));
  const keys = new Set(justified.map(triggerKey));
  for (const row of [...POST_RESTORE_PUBLIC_TRIGGERS, STEPUP_TRIGGER]) {
    const key = triggerKey(row);
    if (keys.has(key)) continue;
    justified.push({ ...row });
    keys.add(key);
  }
  justified.sort((a, b) => triggerKey(a).localeCompare(triggerKey(b)));
  if (justified.length !== JUSTIFIED_PUBLIC_TRIGGER_COUNT
    || new Set(justified.map(triggerKey)).size !== JUSTIFIED_PUBLIC_TRIGGER_COUNT) {
    throw new Error(`justified public trigger catalog ${justified.length} != ${JUSTIFIED_PUBLIC_TRIGGER_COUNT}`);
  }
  return justified;
};

export const comparePublicTriggerInventory = (inventory, justified = loadJustifiedPublicTriggers()) => {
  const expected = new Map(justified.map((row) => [triggerKey(row), row]));
  const actual = new Map();
  for (const row of Array.isArray(inventory) ? inventory : []) {
    if (!row?.table || !row?.trigger) continue;
    actual.set(triggerKey(row), row);
  }
  const added = [];
  const missing = [];
  const changed = [];
  for (const [key, row] of actual) {
    const baseline = expected.get(key);
    if (!baseline) {
      added.push({ table: row.table, trigger: row.trigger, functionName: row.functionName || null });
      continue;
    }
    if (row.functionName && baseline.functionName && row.functionName !== baseline.functionName) {
      changed.push({
        table: row.table,
        trigger: row.trigger,
        expectedFunction: baseline.functionName,
        actualFunction: row.functionName,
      });
    }
  }
  for (const [key, row] of expected) {
    if (!actual.has(key)) {
      missing.push({ table: row.table, trigger: row.trigger, functionName: row.functionName });
    }
  }
  added.sort((a, b) => triggerKey(a).localeCompare(triggerKey(b)));
  missing.sort((a, b) => triggerKey(a).localeCompare(triggerKey(b)));
  changed.sort((a, b) => triggerKey(a).localeCompare(triggerKey(b)));
  return {
    expectedCount: justified.length,
    actualCount: actual.size,
    added,
    missing,
    changed,
  };
};
