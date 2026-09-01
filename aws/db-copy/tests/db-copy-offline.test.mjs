import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allCriticalTables, EXCLUDED_SCHEMAS, TARGET_RDS } from '../lib/catalog.mjs';
import { buildRepoInventory } from '../lib/inventory.mjs';
import {
  buildDumpPlan,
  isExecuteAuthorized,
  refuseExecuteMessage,
} from '../lib/plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbCopyRoot = path.resolve(here, '..');
const repoRoot = path.resolve(dbCopyRoot, '../..');
const cli = path.join(dbCopyRoot, 'cli.mjs');

const runCli = (args, env = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });

test('offline inventory classifies generated schema without connecting', () => {
  const inventory = buildRepoInventory(repoRoot);
  assert.ok(inventory.generatedSchema.tableCount >= 160);
  assert.ok(inventory.generatedSchema.viewCount >= 15);
  assert.ok(inventory.generatedSchema.functionCount >= 300);
  assert.ok(inventory.generatedSchema.enumCount >= 10);
  assert.equal(inventory.missingCriticalFromGeneratedTypes.length, 0);
  assert.equal(inventory.safety.preparationOnly, true);
  assert.equal(inventory.target.engineVersion, '18.3');
  assert.equal(inventory.target.applicationRole, 'checksops');
  for (const table of allCriticalTables()) {
    assert.ok(inventory.generatedSchema.tables.includes(table), `missing critical table ${table}`);
  }
});

test('dump plan excludes Supabase schemas and does not apply restore steps', () => {
  const plan = buildDumpPlan();
  assert.equal(plan.preparationOnly, true);
  const joined = JSON.stringify(plan);
  for (const schema of EXCLUDED_SCHEMAS) {
    assert.match(joined, new RegExp(`--exclude-schema ${schema}|--exclude-schema","${schema}`));
  }
  assert.equal(plan.sequence.every((step) => step.apply === false), true);
  assert.ok(plan.neverInThisPhase.includes('Moov / CheckAlt / Plaid / Resend webhook destination changes'));
  assert.match(joined, /--no-owner/);
  assert.match(joined, /--schema=public/);
  assert.doesNotMatch(joined, /password=/i);
});

test('cli validate is offline and succeeds', () => {
  const result = runCli(['validate']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no database connection/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /postgresql:\/\//i);
});

test('cli dump and restore refuse without execute authorization', () => {
  const dump = runCli(['dump']);
  const restore = runCli(['restore', '--execute'], { CHECKSOPS_DB_COPY_EXECUTE: '' });
  assert.equal(dump.status, 2);
  assert.match(dump.stderr, /preparation-only/);
  assert.equal(restore.status, 2);
  assert.match(restore.stderr, /preparation-only/);
  assert.equal(isExecuteAuthorized({ CHECKSOPS_DB_COPY_EXECUTE: 'nope' }, ['--execute']), false);
  assert.match(refuseExecuteMessage(), /will not connect/);
});

test('reconciliation SQL covers every critical table and does not contain credentials', () => {
  const counts = fs.readFileSync(path.join(dbCopyRoot, 'sql/reconciliation_counts.sql'), 'utf8');
  const financial = fs.readFileSync(path.join(dbCopyRoot, 'sql/reconciliation_financial.sql'), 'utf8');
  for (const table of allCriticalTables()) {
    assert.match(counts, new RegExp(`public\\.${table}\\b`), table);
  }
  assert.match(financial, /check_intake_items/);
  assert.match(financial, /payment_transfers/);
  assert.match(financial, /payment_wallet_ledger/);
  assert.doesNotMatch(`${counts}\n${financial}`, /password/i);
  assert.match(fs.readFileSync(path.join(dbCopyRoot, 'sql/01_auth_compatibility_stubs.sql'), 'utf8'), /Identity map only/);
  assert.match(
    fs.readFileSync(path.join(dbCopyRoot, 'sql/02_grant_readonly_application_role.sql'), 'utf8'),
    /GRANT SELECT ON ALL TABLES/,
  );
  const grants = fs.readFileSync(path.join(dbCopyRoot, 'sql/02_grant_readonly_application_role.sql'), 'utf8');
  assert.doesNotMatch(grants, /^\s*GRANT\s+BYPASSRLS/m);
  assert.match(grants, /Do not grant SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, or BYPASSRLS/);
});

test('repo files do not embed RDS or Supabase database passwords', () => {
  const files = [
    'cli.mjs',
    'lib/catalog.mjs',
    'lib/plan.mjs',
    'lib/inventory.mjs',
    'sql/00_rds_supported_extensions.sql',
    'sql/01_auth_compatibility_stubs.sql',
  ];
  for (const relative of files) {
    const text = fs.readFileSync(path.join(dbCopyRoot, relative), 'utf8');
    assert.doesNotMatch(text, /postgresql:\/\/[^:]+:[^@]+@/);
    assert.doesNotMatch(text, /Password:\s*\S+/);
  }
  assert.equal(TARGET_RDS.identifier, 'checksops-staging');
});
