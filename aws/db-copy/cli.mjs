#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRepoInventory, summarizeClassification } from './lib/inventory.mjs';
import {
  hasLiveCatalogAccess,
  liveInventoryBlockedMessage,
} from './lib/live-access.mjs';
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
  if (!hasLiveCatalogAccess()) {
    fail(liveInventoryBlockedMessage());
  }
  fail('Live catalog credentials are present, but this pass still stops before issuing SQL. Re-run live-inventory in a dedicated inventory turn.');
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
const errors = [];
if (inventory.generatedSchema.tableCount < 150) {
  errors.push(`expected at least 150 generated public tables, found ${inventory.generatedSchema.tableCount}`);
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

if (errors.length) {
  fail(`db-copy validate failed:\n- ${errors.join('\n- ')}`);
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ ok: true, connected: false, summary, target: inventory.target }, null, 2)}\n`);
} else {
  console.log('db-copy validate: ok (offline, no database connection)');
  console.log(`tables=${inventory.generatedSchema.tableCount} views=${inventory.generatedSchema.viewCount} functions=${inventory.generatedSchema.functionCount} edge_functions=${inventory.edgeFunctions.count}`);
  console.log(`migrate_directly=${summary.migrateDirectly} transform=${summary.transform} migrate_later=${summary.migrateLater}`);
  console.log(`target=${inventory.target.identifier} ${inventory.target.engine} ${inventory.target.engineVersion}`);
}
