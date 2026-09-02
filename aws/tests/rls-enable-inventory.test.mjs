import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventory = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'rls/classification/rls_enable_inventory.json'), 'utf8'),
);
const enableSql = fs.readFileSync(path.join(ROOT, 'rls/sql/26_enable_rls.sql'), 'utf8');
const disableSql = fs.readFileSync(path.join(ROOT, 'rls/sql/27_disable_rls.sql'), 'utf8');

test('enable inventory matches the approved 165-table RLS set', () => {
  assert.equal(inventory.restored_application_tables, 166);
  assert.equal(inventory.rls_tables_in_approved_backup, 165);
  assert.equal(inventory.enable_tables.length, 165);
  assert.equal(new Set(inventory.enable_tables).size, 165);
  assert.equal(inventory.dump_public_rls_tables.length, 165);
  assert.deepEqual([...inventory.enable_tables].sort(), [...inventory.dump_public_rls_tables].sort());
  assert.deepEqual(inventory.do_not_enable, ['spatial_ref_sys']);
  assert.equal(inventory.server_side_api_no_write_policy.length, 13);
  assert.equal(inventory.obsolete_no_write_policy.length, 2);
  assert.equal(inventory.platform_owner_only_write_tables.length, 7);
  assert.equal(inventory.aws_select_policies, 165);
  assert.equal(inventory.aws_write_policies, 127);
  assert.equal(inventory.freedom_claims, 83);
  assert.equal(inventory.null_org_claims, 97);
});

test('enable and disable SQL cover exactly the 165 inventory tables and never FORCE', () => {
  const enableAlters = [...enableSql.matchAll(/^ALTER TABLE public\.(\w+) ENABLE ROW LEVEL SECURITY;$/gm)].map((m) => m[1]);
  const disableAlters = [...disableSql.matchAll(/^ALTER TABLE public\.(\w+) DISABLE ROW LEVEL SECURITY;$/gm)].map((m) => m[1]);
  assert.equal(enableAlters.length, 165);
  assert.equal(disableAlters.length, 165);
  assert.deepEqual(enableAlters, inventory.enable_tables);
  assert.deepEqual(disableAlters, inventory.enable_tables);
  assert.equal(/FORCE ROW LEVEL SECURITY/i.test(enableSql.replace(/^--.*$/gm, '')), false);
  assert.equal(/ALTER TABLE public\.spatial_ref_sys/i.test(enableSql), false);
  assert.equal(/ALTER TABLE public\.identity_accounts/i.test(enableSql), false);
});
