import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CORE_TABLES,
  EXPECTED_PUBLIC_TRIGGERS,
  EXPECTED_ROW_COUNTS,
  POST_RESTORE_PUBLIC_TRIGGERS,
  PUBLIC_TRIGGER_INVENTORY_LIMIT,
  PUBLIC_TRIGGER_INVENTORY_SQL,
  REQUIRED_PUBLIC_TRIGGERS,
  SUPERSEDED_PUBLIC_TRIGGERS,
  evaluatePublicTriggerMembership,
  projectPublicTriggerInventory,
  sanitizePublicTriggerRow,
  validateReadonlyCoreTables,
} from '../functions/api/db-readonly-validate.mjs';
import { IDENTITY_PROBE } from '../functions/api/db-health.mjs';
import {
  JUSTIFIED_PUBLIC_TRIGGER_COUNT,
  POST_RESTORE_PUBLIC_TRIGGERS as SCRIPT_POST_RESTORE_PUBLIC_TRIGGERS,
  RESTORE_PUBLIC_TRIGGER_COUNT,
  SUPERSEDED_PUBLIC_TRIGGERS as SCRIPT_SUPERSEDED_PUBLIC_TRIGGERS,
  comparePublicTriggerInventory,
  loadJustifiedPublicTriggers,
  loadRestorePublicTriggers,
  sanitizePublicTriggerRow as scriptSanitize,
  STEPUP_TRIGGER,
} from '../../scripts/lib/justified-public-triggers.mjs';
import { summarizeValidation } from '../../scripts/staging-db-readonly-diagnostic.mjs';

const SENSITIVE = 'sensitive-trigger-inventory-must-not-appear';
const validRow = (overrides = {}) => ({
  table_name: 'financial_stepup_log',
  trigger_name: 'trg_financial_stepup_log_updated_at',
  enabled: 'O',
  function_name: 'set_updated_at_generic',
  definition: 'CREATE TRIGGER trg_financial_stepup_log_updated_at BEFORE UPDATE ON public.financial_stepup_log FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_generic()',
  ...overrides,
});

const triggerKey = (row) => `${row.table}\0${row.trigger}`;

test('restore snapshot stays 164 names and still records the superseded Ready trigger', () => {
  const restore = loadRestorePublicTriggers();
  assert.equal(restore.length, RESTORE_PUBLIC_TRIGGER_COUNT);
  assert.equal(restore.length, 164);
  assert.ok(restore.some((row) => (
    row.table === 'check_endorsements'
    && row.trigger === 'trg_advance_on_endorsement_complete'
  )));
  assert.equal(new Set(restore.map(triggerKey)).size, 164);
});

test('justified baseline is the named 184-set, not a count-only allowance', () => {
  const justified = loadJustifiedPublicTriggers();
  assert.equal(EXPECTED_PUBLIC_TRIGGERS, 184);
  assert.equal(JUSTIFIED_PUBLIC_TRIGGER_COUNT, 184);
  assert.equal(justified.length, 184);
  assert.deepEqual(SUPERSEDED_PUBLIC_TRIGGERS, SCRIPT_SUPERSEDED_PUBLIC_TRIGGERS);
  assert.deepEqual(POST_RESTORE_PUBLIC_TRIGGERS, SCRIPT_POST_RESTORE_PUBLIC_TRIGGERS);
  assert.equal(REQUIRED_PUBLIC_TRIGGERS.length, 22);
  assert.ok(!justified.some((row) => (
    row.table === 'check_endorsements'
    && row.trigger === 'trg_advance_on_endorsement_complete'
  )));
  for (const row of REQUIRED_PUBLIC_TRIGGERS) {
    assert.ok(justified.some((item) => triggerKey(item) === triggerKey(row)), `${row.table}.${row.trigger}`);
  }
  assert.ok(justified.some((row) => (
    row.table === STEPUP_TRIGGER.table && row.trigger === STEPUP_TRIGGER.trigger
  )));
  assert.equal(new Set(justified.map(triggerKey)).size, 184);
});

test('same-count inventory with a swapped name fails membership comparison', () => {
  const justified = loadJustifiedPublicTriggers();
  const swapped = justified.map((row, index) => (
    index === 0
      ? { table: 'user_passkeys', trigger: 'trg_user_passkeys_updated_at', functionName: 'set_updated_at_generic' }
      : row
  ));
  const comparison = comparePublicTriggerInventory(swapped, justified);
  assert.equal(comparison.expectedCount, 184);
  assert.equal(comparison.actualCount, 184);
  assert.equal(comparison.added.length, 1);
  assert.equal(comparison.missing.length, 1);
  assert.equal(comparison.changed.length, 0);
});

test('inventory SQL is read-only catalog SELECT with a 256-row cap', () => {
  assert.equal(PUBLIC_TRIGGER_INVENTORY_LIMIT, 256);
  assert.match(PUBLIC_TRIGGER_INVENTORY_SQL, /BEGIN READ ONLY|pg_get_triggerdef/);
  assert.match(PUBLIC_TRIGGER_INVENTORY_SQL, /NOT t\.tgisinternal/);
  assert.match(PUBLIC_TRIGGER_INVENTORY_SQL, /nspname = 'public'/);
  assert.match(PUBLIC_TRIGGER_INVENTORY_SQL, /LIMIT 257/);
  assert.doesNotMatch(PUBLIC_TRIGGER_INVENTORY_SQL, /^\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/im);
  assert.doesNotMatch(PUBLIC_TRIGGER_INVENTORY_SQL, /pg_get_functiondef/);
});

test('validator and diagnostic sanitizers accept the same allowlisted metadata', () => {
  const row = validRow();
  assert.deepEqual(sanitizePublicTriggerRow(row), scriptSanitize(row));
  assert.equal(sanitizePublicTriggerRow(validRow({ table_name: SENSITIVE })), null);
  assert.equal(sanitizePublicTriggerRow(validRow({ trigger_name: 'bad-name' })), null);
  assert.equal(sanitizePublicTriggerRow(validRow({ enabled: 'X' })), null);
  assert.equal(sanitizePublicTriggerRow(validRow({ function_name: 'auth.uid' })), null);
  const dropped = sanitizePublicTriggerRow(validRow({
    definition: `SELECT ${SENSITIVE}`, extra: SENSITIVE,
  }));
  assert.equal(Object.hasOwn(dropped, 'definition'), false);
  assert.doesNotMatch(JSON.stringify(dropped), new RegExp(SENSITIVE));
});

test('inventory projection truncates at 256 and drops invalid rows', () => {
  const rows = Array.from({ length: 257 }, (_, index) => validRow({
    table_name: 'claims',
    trigger_name: `trg_extra_${index}`,
  }));
  rows[0] = validRow({ table_name: SENSITIVE, trigger_name: 'trg_bad' });
  const projected = projectPublicTriggerInventory(rows);
  assert.equal(projected.truncated, true);
  assert.equal(projected.inventory.length, 255);
  assert.doesNotMatch(JSON.stringify(projected), new RegExp(SENSITIVE));
});

test('diagnostic reports added, missing, and changed triggers without raw extras', () => {
  const justified = loadJustifiedPublicTriggers();
  const inventory = justified.slice(1).map((row) => ({
    table: row.table,
    trigger: row.trigger,
    enabled: 'O',
    functionName: row.functionName,
    definition: `CREATE TRIGGER ${row.trigger} BEFORE UPDATE ON public.${row.table} FOR EACH ROW EXECUTE FUNCTION public.${row.functionName}()`,
  }));
  inventory.push({
    table: 'user_passkeys',
    trigger: 'trg_user_passkeys_updated_at',
    enabled: 'O',
    functionName: 'set_updated_at_generic',
    definition: 'CREATE TRIGGER trg_user_passkeys_updated_at BEFORE UPDATE ON public.user_passkeys FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_generic()',
  });
  inventory[0] = {
    ...inventory[0],
    functionName: 'unexpected_function',
    definition: `CREATE TRIGGER ${inventory[0].trigger} BEFORE UPDATE ON public.${inventory[0].table} FOR EACH ROW EXECUTE FUNCTION public.unexpected_function()`,
  };
  const comparison = comparePublicTriggerInventory(inventory, justified);
  assert.equal(comparison.expectedCount, 184);
  assert.equal(comparison.added.length, 1);
  assert.deepEqual(comparison.added[0], {
    table: 'user_passkeys',
    trigger: 'trg_user_passkeys_updated_at',
    functionName: 'set_updated_at_generic',
  });
  assert.equal(comparison.missing.length, 1);
  assert.equal(comparison.changed.length, 1);

  const summary = summarizeValidation({
    service: 'checksops-api',
    environment: 'staging',
    ok: false,
    readOnly: true,
    writesAttempted: false,
    tables: [],
    issues: [{ kind: 'trigger', severity: 'error', message: SENSITIVE }],
    catalog: {
      publicTriggers: 184,
      publicTriggerInventory: inventory,
      publicTriggerInventoryTruncated: false,
      authUidResult: SENSITIVE,
    },
  }, 503);
  assert.equal(summary.triggerInventory.expectedCount, 184);
  assert.equal(summary.triggerInventory.actualCount, 184);
  assert.equal(summary.triggerInventory.added.length, 1);
  assert.equal(summary.triggerInventory.missing.length, 1);
  assert.equal(summary.triggerInventory.changed.length, 1);
  assert.equal(summary.triggerInventory.inventory.length, inventory.length);
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(SENSITIVE));
});

test('validator stores allowlisted inventory from the read-only catalog probe', async () => {
  const queries = [];
  const inventoryRow = validRow();
  const identity = {
    current_database: 'checksops', current_user: 'checksops',
    transaction_read_only: 'on', default_transaction_read_only: 'on',
  };
  const result = await validateReadonlyCoreTables({
    loadCredentials: async () => ({
      username: 'checksops', password: SENSITIVE, host: 'db.example.internal',
      database: 'checksops', secretDatabase: 'checksops',
    }),
    createClient: () => ({
      connect: async () => {},
      query: async (sql, params) => {
        queries.push(sql);
        if (sql === IDENTITY_PROBE) return { rows: [identity] };
        if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK'
            || sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')
            || sql.startsWith('ROLLBACK TO SAVEPOINT ')) return { rows: [] };
        if (sql.startsWith('SELECT to_regclass($1)')) return { rows: [{ regclass: params[0] }] };
        if (sql.startsWith('SELECT count(*)::bigint AS row_count')) {
          const table = sql.match(/public\."([^"]+)"/)[1];
          return { rows: [{ row_count: EXPECTED_ROW_COUNTS[table] }] };
        }
        if (sql.includes('has_table_privilege')) return { rows: CORE_TABLES.map((table) => ({
          table_name: table, can_select: true, can_insert: false, can_update: false,
          can_delete: false, rls_enabled: false, rls_forced: false,
        })) };
        if (sql.includes('_checksops_restore_complete')) return { rows: [{ present: true }] };
        if (sql.includes('has_schema_privilege')) return { rows: [
          { schema_name: 'public', can_usage: true },
        ] };
        if (sql.includes("c.relname = 'users'")) return { rows: [{ present: false }] };
        if (sql.includes('pg_constraint')) return { rows: [{ fk_count: 0 }] };
        if (sql.includes('pg_get_triggerdef')) return { rows: [inventoryRow, { table_name: SENSITIVE }] };
        if (sql.includes('pg_trigger')) return { rows: [{ trigger_count: 184 }] };
        if (sql.includes('prokind')) return { rows: [{
          function_count: 0, auth_uid_functions: 0, net_functions: 0, cron_functions: 0,
          vault_functions: 0, pgmq_functions: 0,
        }] };
        if (sql.includes('has_function_privilege')) return { rows: [{ can_execute: false }] };
        if (sql.includes('SELECT auth.uid()')) throw Object.assign(new Error('permission denied'), { code: '42501' });
        if (sql.includes('FROM pg_roles') || sql.includes('relrowsecurity') || sql.includes('FROM pg_policies')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      end: async () => {},
    }),
  });
  assert.ok(queries.includes(PUBLIC_TRIGGER_INVENTORY_SQL));
  assert.equal(queries.some((sql) => /^\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/i.test(sql)), false);
  assert.equal(result.catalog.publicTriggers, 184);
  assert.deepEqual(result.catalog.publicTriggerInventory, [sanitizePublicTriggerRow(inventoryRow)]);
  assert.equal(result.catalog.publicTriggerInventoryTruncated, false);
  assert.equal(EXPECTED_PUBLIC_TRIGGERS, 184);
  assert.ok(result.issues.some((item) => item.kind === 'trigger' && item.severity === 'error'));
  assert.ok(result.issues.some((item) => (
    item.kind === 'trigger'
    && item.severity === 'error'
    && String(item.message || '').includes('required public trigger')
  )));
  assert.doesNotMatch(JSON.stringify(result.catalog.publicTriggerInventory), new RegExp(SENSITIVE));
});

test('diagnostic omits inventory when the live catalog has not been expanded yet', () => {
  const summary = summarizeValidation({
    service: 'checksops-api',
    environment: 'staging',
    ok: false,
    readOnly: true,
    writesAttempted: false,
    tables: [],
    issues: [{ kind: 'trigger', severity: 'error' }],
    catalog: { publicTriggers: 184 },
  }, 503);
  assert.equal(Object.hasOwn(summary, 'triggerInventory'), false);
  assert.deepEqual(summary.issues[0], {
    kind: 'trigger', severity: 'error', probe: 'triggers', expectedCount: 184, actualCount: 184,
  });
});

test('membership rejects a 184-count inventory that still has the superseded Ready trigger', () => {
  const justified = loadJustifiedPublicTriggers();
  const dumpRow = justified.find((row) => (
    !REQUIRED_PUBLIC_TRIGGERS.some((required) => triggerKey(required) === triggerKey(row))
  ));
  const inventory = justified.map((row) => (
    triggerKey(row) === triggerKey(dumpRow)
      ? {
        table: 'check_endorsements',
        trigger: 'trg_advance_on_endorsement_complete',
        functionName: 'advance_check_on_endorsement_complete',
      }
      : row
  ));
  const superseded = evaluatePublicTriggerMembership({
    publicTriggers: 184,
    inventory,
    truncated: false,
  });
  assert.ok(superseded.some((item) => String(item.message || '').includes('trg_advance_on_endorsement_complete')));
  const missingRequired = evaluatePublicTriggerMembership({
    publicTriggers: 184,
    inventory: justified.filter((row) => row.trigger !== STEPUP_TRIGGER.trigger),
    truncated: false,
  });
  assert.ok(missingRequired.some((item) => String(item.message || '').includes('trg_financial_stepup_log_updated_at')));
});

test('validator accepts the exact 184-name justified inventory and no other 184-set', async () => {
  const justified = loadJustifiedPublicTriggers();
  const identity = {
    current_database: 'checksops', current_user: 'checksops',
    transaction_read_only: 'on', default_transaction_read_only: 'on',
  };
  const inventoryRows = justified.map((row) => ({
    table_name: row.table,
    trigger_name: row.trigger,
    enabled: 'O',
    function_name: row.functionName,
    definition: `CREATE TRIGGER ${row.trigger} BEFORE UPDATE ON public.${row.table} FOR EACH ROW EXECUTE FUNCTION public.${row.functionName}()`,
  }));
  const result = await validateReadonlyCoreTables({
    loadCredentials: async () => ({
      username: 'checksops', password: SENSITIVE, host: 'db.example.internal',
      database: 'checksops', secretDatabase: 'checksops',
    }),
    createClient: () => ({
      connect: async () => {},
      query: async (sql, params) => {
        if (sql === IDENTITY_PROBE) return { rows: [identity] };
        if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK'
            || sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')
            || sql.startsWith('ROLLBACK TO SAVEPOINT ')) return { rows: [] };
        if (sql.startsWith('SELECT to_regclass($1)')) return { rows: [{ regclass: params[0] }] };
        if (sql.startsWith('SELECT count(*)::bigint AS row_count')) {
          const table = sql.match(/public\."([^"]+)"/)[1];
          return { rows: [{ row_count: EXPECTED_ROW_COUNTS[table] }] };
        }
        if (sql.includes('has_table_privilege')) return { rows: CORE_TABLES.map((table) => ({
          table_name: table, can_select: true, can_insert: false, can_update: false,
          can_delete: false, rls_enabled: false, rls_forced: false,
        })) };
        if (sql.includes('_checksops_restore_complete')) return { rows: [{ present: true }] };
        if (sql.includes('has_schema_privilege')) return { rows: [
          { schema_name: 'public', can_usage: true },
        ] };
        if (sql.includes("c.relname = 'users'")) return { rows: [{ present: false }] };
        if (sql.includes('pg_constraint')) return { rows: [{ fk_count: 0 }] };
        if (sql.includes('pg_get_triggerdef')) return { rows: inventoryRows };
        if (sql.includes('pg_trigger')) return { rows: [{ trigger_count: 184 }] };
        if (sql.includes('prokind')) return { rows: [{
          function_count: 0, auth_uid_functions: 0, net_functions: 0, cron_functions: 0,
          vault_functions: 0, pgmq_functions: 0,
        }] };
        if (sql.includes('has_function_privilege')) return { rows: [{ can_execute: false }] };
        if (sql.includes('SELECT auth.uid()')) throw Object.assign(new Error('permission denied'), { code: '42501' });
        if (sql.includes('FROM pg_roles') || sql.includes('relrowsecurity') || sql.includes('FROM pg_policies')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      end: async () => {},
    }),
  });
  assert.equal(result.catalog.publicTriggers, 184);
  assert.equal(result.catalog.publicTriggerInventory.length, 184);
  assert.equal(result.issues.some((item) => item.kind === 'trigger'), false);
  const swapped = inventoryRows.map((row, index) => (
    index === 0
      ? { ...row, table_name: 'user_passkeys', trigger_name: 'trg_user_passkeys_updated_at' }
      : row
  ));
  const drifted = comparePublicTriggerInventory(
    projectPublicTriggerInventory(swapped).inventory,
    justified,
  );
  assert.equal(drifted.expectedCount, 184);
  assert.equal(drifted.actualCount, 184);
  assert.equal(drifted.added.length, 1);
  assert.equal(drifted.missing.length, 1);
});
