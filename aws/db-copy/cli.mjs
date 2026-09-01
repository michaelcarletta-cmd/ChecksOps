#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_SOURCE_COUNTS } from './lib/catalog.mjs';
import {
  buildRepoInventory,
  loadCommittedLiveInventory,
  summarizeClassification,
} from './lib/inventory.mjs';
import { describeLiveAccess } from './lib/live-access.mjs';
import {
  buildDumpPlan,
  isExecuteAuthorized,
  refuseExecuteMessage,
  renderPlanText,
} from './lib/plan.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const command = process.argv[2] || 'validate';
const asJson = process.argv.includes('--json');

const fail = (message, code = 2) => {
  console.error(message);
  process.exit(code);
};

if (['dump', 'restore', 'export', 'import'].includes(command)) {
  if (!isExecuteAuthorized()) {
    fail(refuseExecuteMessage());
  }
  fail('Execute authorization is present, but this checkout still stops before any database copy. Remove this guard only in a later approved phase.');
}

if (command === 'live-inventory') {
  const live = loadCommittedLiveInventory(repoRoot);
  const access = describeLiveAccess();
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ...live, access }, null, 2)}\n`);
  } else {
    console.log('db-copy live-inventory: committed file (no token requested, no database connection)');
    console.log(`file=${live.inventoryPath}`);
    console.log(`tables=${live.live.public.baseTables} views=${live.live.public.views} functions=${live.live.public.functions} triggers=${live.live.public.triggers} rls=${live.live.public.rlsPolicies}`);
    console.log(`auth_users=${live.live.authUsers} (Cognito later) storage_objects=${live.live.storageObjects} (S3 later)`);
    console.log(`public_fks_to_auth_users=${live.live.publicForeignKeysToAuthUsers}`);
    console.log(`generated_types tables=${live.generatedTypes.tables} views=${live.generatedTypes.views} functions=${live.generatedTypes.functions}`);
    console.log(`alignment tables=${live.alignment.tableCountMatch} views=${live.alignment.viewCountMatch} no_twenty_table_gap=${live.alignment.noTwentyTableDiscrepancy}`);
    console.log(access.message);
  }
  process.exit(0);
}

if (!['validate', 'plan', 'inventory'].includes(command)) {
  fail(`Unknown command "${command}". Use validate, plan, inventory, or live-inventory. dump/restore are disabled.`);
}

const inventory = buildRepoInventory(repoRoot);

if (command === 'inventory') {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  } else {
    const summary = summarizeClassification(inventory);
    const live = inventory.liveInventory.live;
    console.log(`Live public base tables: ${live.public.baseTables}`);
    console.log(`Live public views: ${live.public.views}`);
    console.log(`Live public functions: ${live.public.functions}`);
    console.log(`Live public triggers: ${live.public.triggers}`);
    console.log(`Live public RLS policies: ${live.public.rlsPolicies} (not applied on first copy)`);
    console.log(`Generated public tables: ${inventory.generatedSchema.tableCount}`);
    console.log(`Generated public views: ${inventory.generatedSchema.viewCount}`);
    console.log(`Generated public functions: ${inventory.generatedSchema.functionCount}`);
    console.log(`Edge functions: ${inventory.edgeFunctions.count}`);
    console.log(`Migration files: ${inventory.migrations.migrationFileCount}`);
    console.log(`Migrate directly: ${summary.migrateDirectly}`);
    console.log(`Transform: ${summary.transform}`);
    console.log(`Migrate later: ${summary.migrateLater}`);
    console.log(`Missing critical tables from generated types: ${inventory.missingCriticalFromGeneratedTypes.join(',') || 'none'}`);
  }
  process.exit(0);
}

if (command === 'plan') {
  const plan = buildDumpPlan();
  if (asJson) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  else process.stdout.write(renderPlanText(plan));
  process.exit(0);
}

const summary = summarizeClassification(inventory);
const live = inventory.liveInventory;
const errors = [];
if (inventory.generatedSchema.tableCount !== LIVE_SOURCE_COUNTS.publicBaseTables) {
  errors.push(`expected ${LIVE_SOURCE_COUNTS.publicBaseTables} generated public tables, found ${inventory.generatedSchema.tableCount}`);
}
if (inventory.generatedSchema.viewCount !== LIVE_SOURCE_COUNTS.publicViews) {
  errors.push(`expected ${LIVE_SOURCE_COUNTS.publicViews} generated public views, found ${inventory.generatedSchema.viewCount}`);
}
if (live.live.public.baseTables !== LIVE_SOURCE_COUNTS.publicBaseTables) {
  errors.push(`live inventory base tables ${live.live.public.baseTables} != ${LIVE_SOURCE_COUNTS.publicBaseTables}`);
}
if (live.live.public.views !== LIVE_SOURCE_COUNTS.publicViews) {
  errors.push(`live inventory views ${live.live.public.views} != ${LIVE_SOURCE_COUNTS.publicViews}`);
}
if (live.live.public.functions !== LIVE_SOURCE_COUNTS.publicFunctions) {
  errors.push(`live inventory functions ${live.live.public.functions} != ${LIVE_SOURCE_COUNTS.publicFunctions}`);
}
if (live.live.public.triggers !== LIVE_SOURCE_COUNTS.publicTriggers) {
  errors.push(`live inventory triggers ${live.live.public.triggers} != ${LIVE_SOURCE_COUNTS.publicTriggers}`);
}
if (live.live.public.rlsPolicies !== LIVE_SOURCE_COUNTS.publicRlsPolicies) {
  errors.push(`live inventory RLS ${live.live.public.rlsPolicies} != ${LIVE_SOURCE_COUNTS.publicRlsPolicies}`);
}
if (!live.alignment.tableCountMatch || !live.alignment.viewCountMatch) {
  errors.push('generated types do not match live table/view counts');
}
if (live.alignment.noTwentyTableDiscrepancy !== true) {
  errors.push('live inventory must document that 186 = 166 tables + 20 views');
}
if (inventory.missingCriticalFromGeneratedTypes.length) {
  errors.push(`critical tables missing from generated types: ${inventory.missingCriticalFromGeneratedTypes.join(', ')}`);
}
if (inventory.edgeFunctions.count < 100) {
  errors.push(`expected a large Edge Function inventory, found ${inventory.edgeFunctions.count}`);
}
if (!inventory.safety.preparationOnly) {
  errors.push('inventory safety.preparationOnly must remain true');
}
if (live.access.requestToken || live.access.requestPassword) {
  errors.push('live access must not request a token or password');
}

if (errors.length) {
  fail(`db-copy validate failed:\n- ${errors.join('\n- ')}`);
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ ok: true, connected: false, summary, target: inventory.target, live: live.live.public }, null, 2)}\n`);
} else {
  console.log('db-copy validate: ok (offline, no database connection)');
  console.log(`live_tables=${live.live.public.baseTables} live_views=${live.live.public.views} live_functions=${live.live.public.functions} live_triggers=${live.live.public.triggers} live_rls=${live.live.public.rlsPolicies}`);
  console.log(`generated_tables=${inventory.generatedSchema.tableCount} generated_views=${inventory.generatedSchema.viewCount} generated_functions=${inventory.generatedSchema.functionCount} edge_functions=${inventory.edgeFunctions.count}`);
  console.log(`migrate_directly=${summary.migrateDirectly} transform=${summary.transform} migrate_later=${summary.migrateLater}`);
  console.log(`target=${inventory.target.identifier} restore_db=${inventory.target.recommendedRestoreDatabase} ${inventory.target.engine} ${inventory.target.engineVersion}`);
}
