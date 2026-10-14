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
]);

export const JUSTIFIED_PUBLIC_TRIGGER_COUNT = 173;

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
