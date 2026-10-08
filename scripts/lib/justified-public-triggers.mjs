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

export const STEPUP_TRIGGER = Object.freeze({
  table: 'financial_stepup_log',
  trigger: 'trg_financial_stepup_log_updated_at',
  functionName: 'set_updated_at_generic',
});

const unqualified = (value) => {
  const text = String(value || '');
  const parts = text.split('.');
  return parts[parts.length - 1] || '';
};

const triggerKey = (row) => `${row.table}\0${row.trigger}`;

export const loadJustifiedPublicTriggers = () => {
  const classified = JSON.parse(readFileSync(CLASSIFIED_PATH, 'utf8'));
  const restore = (classified.public || []).map((row) => ({
    table: row.table,
    trigger: row.trigger,
    functionName: unqualified(row.function),
  }));
  const keys = new Set(restore.map(triggerKey));
  const stepupKey = triggerKey(STEPUP_TRIGGER);
  const justified = keys.has(stepupKey) ? restore : [...restore, { ...STEPUP_TRIGGER }];
  justified.sort((a, b) => triggerKey(a).localeCompare(triggerKey(b)));
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
