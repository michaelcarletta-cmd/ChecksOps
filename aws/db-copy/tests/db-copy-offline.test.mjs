import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  allCriticalTables,
  EXCLUDED_SCHEMAS,
  LIVE_SOURCE_COUNTS,
  TARGET_RDS,
} from '../lib/catalog.mjs';
import { buildRepoInventory, loadCommittedLiveInventory } from '../lib/inventory.mjs';
import { parseLiveSourceInventory } from '../lib/parse-live-inventory.mjs';
import { parseGeneratedDatabaseTypes } from '../lib/parse-types.mjs';
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

const listReconciliationTables = (sql) =>
  [...sql.matchAll(/(?:FROM|from) public\.([a-z0-9_]+)/g)].map((match) => match[1]);

test('committed live inventory is 166 tables, 20 views, and related catalog counts', () => {
  const live = parseLiveSourceInventory(path.join(dbCopyRoot, 'LIVE_SOURCE_INVENTORY.md'));
  assert.equal(live.public.baseTables, 166);
  assert.equal(live.public.views, 20);
  assert.equal(live.public.functions, 960);
  assert.equal(live.public.triggers, 211);
  assert.equal(live.public.rlsPolicies, 380);
  assert.equal(live.authUsers, 9);
  assert.equal(live.storageObjects, 1335);
  assert.equal(live.publicForeignKeysToAuthUsers, 0);
  assert.equal(live.supabaseFunctionDependencies.authUid, 40);
  assert.equal(live.supabaseFunctionDependencies.net, 4);
  assert.equal(live.supabaseFunctionDependencies.cron, 2);
  assert.equal(live.supabaseFunctionDependencies.vault, 5);
  assert.equal(live.supabaseFunctionDependencies.pgmq, 5);
  assert.equal(live.noTableGapVsViews, true);
  assert.equal(LIVE_SOURCE_COUNTS.publicBaseTables, 166);
  assert.equal(LIVE_SOURCE_COUNTS.twentyTableDiscrepancy, undefined);
});

test('generated types match the live 166 tables and 20 views', () => {
  const types = parseGeneratedDatabaseTypes(path.join(repoRoot, 'src/integrations/supabase/types.ts'));
  const live = loadCommittedLiveInventory(repoRoot);
  assert.equal(types.tables.length, 166);
  assert.equal(types.views.length, 20);
  assert.equal(live.alignment.tableCountMatch, true);
  assert.equal(live.alignment.viewCountMatch, true);
  assert.equal(live.alignment.noTwentyTableDiscrepancy, true);
  assert.equal(live.access.requestToken, false);
  assert.equal(live.access.requestPassword, false);
});

test('offline inventory classifies generated schema without connecting', () => {
  const inventory = buildRepoInventory(repoRoot);
  assert.equal(inventory.generatedSchema.tableCount, 166);
  assert.equal(inventory.generatedSchema.viewCount, 20);
  assert.ok(inventory.generatedSchema.functionCount >= 300);
  assert.ok(inventory.generatedSchema.enumCount >= 10);
  assert.equal(inventory.missingCriticalFromGeneratedTypes.length, 0);
  assert.equal(inventory.safety.preparationOnly, true);
  assert.equal(inventory.safety.doNotRequestSupabaseToken, true);
  assert.equal(inventory.target.engineVersion, '18.3');
  assert.equal(inventory.target.applicationRole, 'checksops');
  assert.equal(inventory.target.recommendedRestoreDatabase, 'checksops');
  for (const table of allCriticalTables()) {
    assert.ok(inventory.generatedSchema.tables.includes(table), `missing critical table ${table}`);
  }
});

test('dump plan excludes Auth, Storage, RLS activation, realtime, cron/net/vault/pgmq, and webhooks', () => {
  const plan = buildDumpPlan();
  assert.equal(plan.preparationOnly, true);
  assert.equal(plan.apply, false);
  const joined = JSON.stringify(plan);
  for (const schema of EXCLUDED_SCHEMAS) {
    assert.match(joined, new RegExp(`--exclude-schema ${schema}|--exclude-schema","${schema}`));
  }
  assert.equal(plan.sequence.every((step) => step.apply === false), true);
  assert.ok(plan.neverInThisPhase.includes('auth.users dump or Cognito import'));
  assert.ok(plan.neverInThisPhase.includes('storage object copy to S3'));
  assert.ok(plan.neverInThisPhase.includes('RLS policy apply / ENABLE ROW LEVEL SECURITY'));
  assert.ok(plan.neverInThisPhase.includes('realtime publication restore'));
  assert.ok(plan.neverInThisPhase.includes('pg_cron / pg_net / supabase_vault / pgmq / pgsodium behavior'));
  assert.ok(plan.neverInThisPhase.includes('Moov / CheckAlt / Plaid / Resend webhook destination changes'));
  assert.ok(plan.neverInThisPhase.includes('restore into database postgres'));
  assert.match(joined, /--no-owner/);
  assert.match(joined, /--schema=public/);
  assert.match(joined, /POLICY\|ROW SECURITY/);
  assert.match(joined, /CREATE DATABASE checksops/);
  assert.match(joined, /DROP DATABASE checksops/);
  assert.doesNotMatch(joined, /copy \(select id, email/);
  assert.doesNotMatch(joined, /\\\\copy auth\.users/);
  assert.doesNotMatch(joined, /password=/i);
  assert.doesNotMatch(joined, /CHECKSOPS_LIVE_SUPABASE_ACCESS_TOKEN/);
});

test('cli validate is offline and succeeds against the live inventory', () => {
  const result = runCli(['validate']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no database connection/);
  assert.match(result.stdout, /live_tables=166/);
  assert.match(result.stdout, /live_views=20/);
  assert.match(result.stdout, /live_functions=960/);
  assert.match(result.stdout, /live_triggers=211/);
  assert.match(result.stdout, /live_rls=380/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /postgresql:\/\//i);
});

test('cli live-inventory reads the committed file and does not request a token', () => {
  const result = runCli(['live-inventory']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LIVE_SOURCE_INVENTORY\.md/);
  assert.match(result.stdout, /tables=166/);
  assert.match(result.stdout, /views=20/);
  assert.match(result.stdout, /functions=960/);
  assert.match(result.stdout, /Do not request another/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /CHECKSOPS_LIVE_SUPABASE_ACCESS_TOKEN/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /LIVE INVENTORY STOPPED/);
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

test('reconciliation SQL covers all 166 generated tables plus financial payment domains', () => {
  const counts = fs.readFileSync(path.join(dbCopyRoot, 'sql/reconciliation_counts.sql'), 'utf8');
  const financial = fs.readFileSync(path.join(dbCopyRoot, 'sql/reconciliation_financial.sql'), 'utf8');
  const types = parseGeneratedDatabaseTypes(path.join(repoRoot, 'src/integrations/supabase/types.ts'));
  const named = listReconciliationTables(counts);
  assert.equal(named.length, 166, `expected 166 count queries, found ${named.length}`);
  assert.deepEqual([...named].sort(), [...types.tables].sort());
  for (const table of allCriticalTables()) {
    assert.match(counts, new RegExp(`public\\.${table}\\b`), table);
  }
  assert.match(financial, /check_intake_items/);
  assert.match(financial, /deposit_items/);
  assert.match(financial, /deposit_batches/);
  assert.match(financial, /checkalt_deposits/);
  assert.match(financial, /check_endorsements/);
  assert.match(financial, /disbursement_splits/);
  assert.match(financial, /disbursement_batches/);
  assert.match(financial, /claim_check_payments/);
  assert.match(financial, /payment_transfers/);
  assert.match(financial, /payment_wallet_ledger/);
  assert.doesNotMatch(`${counts}\n${financial}`, /password/i);
  const stubs = fs.readFileSync(path.join(dbCopyRoot, 'sql/01_auth_compatibility_stubs.sql'), 'utf8');
  assert.match(stubs, /does NOT load Auth user rows/i);
  assert.match(
    fs.readFileSync(path.join(dbCopyRoot, 'sql/02_grant_readonly_application_role.sql'), 'utf8'),
    /GRANT SELECT ON ALL TABLES/,
  );
  const grants = fs.readFileSync(path.join(dbCopyRoot, 'sql/02_grant_readonly_application_role.sql'), 'utf8');
  assert.doesNotMatch(grants, /^\s*GRANT\s+BYPASSRLS/m);
  assert.match(grants, /Do not grant SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, or BYPASSRLS/);
});

test('first-copy procedure and rollback isolate database checksops', () => {
  const procedure = fs.readFileSync(path.join(dbCopyRoot, 'FIRST_COPY_PROCEDURE.md'), 'utf8');
  const rollback = fs.readFileSync(path.join(dbCopyRoot, 'sql/04_rollback_failed_staging_database.sql'), 'utf8');
  const extensions = fs.readFileSync(path.join(dbCopyRoot, 'sql/00_rds_supported_extensions.sql'), 'utf8');
  const inspect = fs.readFileSync(path.join(dbCopyRoot, 'sql/03_inspect_supabase_dependencies.sql'), 'utf8');
  assert.match(procedure, /166 public base tables/);
  assert.match(procedure, /20 public views/);
  assert.match(procedure, /CREATE DATABASE checksops/);
  assert.match(procedure, /DROP DATABASE checksops/);
  assert.match(procedure, /Do not copy password hashes/);
  assert.match(procedure, /1,335 objects/);
  assert.match(procedure, /RLS \*\*activation\*\*/);
  assert.match(procedure, /pg_cron/);
  assert.match(procedure, /pg_net/);
  assert.match(procedure, /pgmq/);
  assert.match(procedure, /Production webhooks/);
  assert.match(procedure, /operator-held \*\*read-only\*\* URI/);
  assert.doesNotMatch(procedure, /CHECKSOPS_LIVE_SUPABASE_ACCESS_TOKEN/);
  assert.match(rollback, /Never DROP DATABASE postgres/);
  assert.match(rollback, /DROP DATABASE checksops/);
  assert.match(extensions, /CREATE EXTENSION IF NOT EXISTS postgis/);
  assert.match(extensions, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.match(extensions, /Do not enable on first copy/);
  assert.match(inspect, /auth\.uid/);
  assert.match(inspect, /pgmq/);
});

test('repo files do not embed RDS or Supabase database passwords', () => {
  const files = [
    'cli.mjs',
    'lib/catalog.mjs',
    'lib/plan.mjs',
    'lib/inventory.mjs',
    'lib/live-access.mjs',
    'sql/00_rds_supported_extensions.sql',
    'sql/01_auth_compatibility_stubs.sql',
  ];
  for (const relative of files) {
    const text = fs.readFileSync(path.join(dbCopyRoot, relative), 'utf8');
    assert.doesNotMatch(text, /postgresql:\/\/[^:]+:[^@]+@/);
    assert.doesNotMatch(text, /(?:^|[\s"'`])Password:\s+\S+/m);
  }
  assert.equal(TARGET_RDS.identifier, 'checksops-staging');
});
