import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  AWS_COMPAT_FILES,
  CLASS,
  DIRECT_BROWSER_SUPABASE_FETCH_FILES,
  PRODUCTION_SUPABASE_HOST,
  SDK_INIT_FILES,
  assertInventoryInvariants,
  scanSupabaseRuntimeInventory,
} from '../providers/lib/supabase-runtime-inventory.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT = 'aws/providers/results/supabase_remaining_live_inventory.md';
const SNAPSHOT = 'aws/providers/results/supabase_remaining_live_inventory.json';

test('scanner invariants: dual client, Cognito getSession, no adapter Supabase host', () => {
  const inventory = scanSupabaseRuntimeInventory(ROOT);
  assertInventoryInvariants(inventory, ROOT);
  assert.equal(inventory.compatibility_interface_must_remain, true);
  assert.equal(inventory.removal_authorized, false);
  assert.equal(inventory.summary.sdk_init_files, SDK_INIT_FILES.length);
  assert.deepEqual(inventory.sdk_init_files, [...SDK_INIT_FILES]);
  assert.deepEqual([...inventory.direct_browser_fetch_files].sort(), [...DIRECT_BROWSER_SUPABASE_FETCH_FILES].sort());
});

test('AWS adapter getSession is Cognito-backed and never calls supabase.co', () => {
  const adapter = fs.readFileSync(path.join(ROOT, 'src/integrations/aws/client.ts'), 'utf8');
  assert.match(adapter, /getSession:\s*async\s*\(\)\s*=>\s*\{[\s\S]*restoreSession\(\)/);
  assert.match(adapter, /apiFetch\("\/auth\/refresh"/);
  assert.match(adapter, /apiFetch\("\/identity\/me"/);
  assert.doesNotMatch(adapter, /supabase\.co/);
  assert.doesNotMatch(adapter, /\/auth\/v1\//);
  assert.doesNotMatch(adapter, /VITE_SUPABASE_URL/);
  assert.match(adapter, /apiFetch\(`\/functions\/v1\/\$\{encodeURIComponent\(name\)\}`/);
  assert.match(adapter, /apiFetch\("\/data\/query"/);
  assert.match(adapter, /createAwsStorageAdapter/);
});

test('production env stays Supabase; aws example stays Cognito without Supabase URL', () => {
  const prod = fs.readFileSync(path.join(ROOT, '.env.production'), 'utf8');
  const aws = fs.readFileSync(path.join(ROOT, '.env.aws.example'), 'utf8');
  const awsProd = fs.readFileSync(path.join(ROOT, '.env.production.aws.example'), 'utf8');
  assert.match(prod, new RegExp(`VITE_SUPABASE_URL=https://${PRODUCTION_SUPABASE_HOST.replace(/\./g, '\\.')}`));
  assert.doesNotMatch(prod, /VITE_AUTH_PROVIDER=cognito/);
  assert.match(aws, /VITE_AUTH_PROVIDER=cognito/);
  assert.doesNotMatch(aws, /VITE_SUPABASE_URL=/);
  assert.match(awsProd, /DO NOT USE YET/);
  assert.match(awsProd, /Production `\.env\.production` remains the repo Supabase-only file/);
});

test('report forbids removal and does not overwrite prior workstream audits', () => {
  const report = fs.readFileSync(path.join(ROOT, REPORT), 'utf8');
  assert.match(report, /REMOVAL NOT AUTHORIZED/);
  assert.match(report, /Review-to-Endorsing/);
  assert.match(report, /staging 503/);
  assert.match(report, /compatibility interface/);
  assert.match(report, /cognito_via_aws_adapter/);
  assert.match(report, /supabase_auth/);
  assert.match(report, /issue-811|#811/);
  const prior = [
    'aws/providers/results/supabase_runtime_dependency_audit.md',
    'aws/providers/results/supabase_runtime_dependency_audit_final.md',
    'aws/frontend/SUPABASE_FRONTEND_INVENTORY.md',
  ];
  for (const rel of prior) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), true);
  }
  const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, SNAPSHOT), 'utf8'));
  assert.equal(snapshot.removal_authorized, false);
  assert.equal(snapshot.compatibility_interface_must_remain, true);
  const scanned = scanSupabaseRuntimeInventory(ROOT);
  assert.equal(snapshot.summary.files, scanned.summary.files);
  assert.deepEqual(snapshot.summary.production, scanned.summary.production);
  assert.deepEqual(snapshot.summary.staging, scanned.summary.staging);
  assert.deepEqual(snapshot.getSession_files, scanned.getSession_files);
  assert.deepEqual(snapshot.direct_browser_fetch_files, scanned.direct_browser_fetch_files);
});

test('UI getSession call sites import the shared client, not a second SDK', () => {
  const inventory = scanSupabaseRuntimeInventory(ROOT);
  const ui = inventory.files.filter((row) => row.rel.startsWith('src/') && row.signals.includes('getSession'));
  assert.ok(ui.length >= 8);
  for (const row of ui) {
    if (AWS_COMPAT_FILES.includes(row.rel)) {
      assert.equal(row.getSession_backend_staging, 'cognito_via_aws_adapter');
      continue;
    }
    assert.equal(row.getSession_backend_production, 'supabase_auth');
    assert.equal(row.getSession_backend_staging, 'cognito_via_aws_adapter');
    const source = fs.readFileSync(path.join(ROOT, row.rel), 'utf8');
    if (row.rel === 'src/integrations/supabase/client.ts') continue;
    assert.match(source, /from ['"]@\/integrations\/supabase\/(?:client|mortgageClient)['"]/);
  }
});

test('classifications keep the AWS compatibility layer and mark production SDK as live', () => {
  const inventory = scanSupabaseRuntimeInventory(ROOT);
  for (const rel of AWS_COMPAT_FILES) {
    const row = inventory.files.find((file) => file.rel === rel);
    if (!row && /awsApiBase|backendMode|awsStaging/.test(rel)) continue;
    assert.ok(row, rel);
    assert.equal(row.classification_staging, CLASS.COMPATIBILITY_ALIAS);
  }
  for (const rel of SDK_INIT_FILES) {
    const row = inventory.files.find((file) => file.rel === rel);
    assert.equal(row.classification_production, CLASS.LIVE_RUNTIME);
    assert.equal(row.classification_staging, CLASS.COMPATIBILITY_ALIAS);
  }
  const storagePath = inventory.files.find((file) => file.rel === 'src/lib/storagePath.ts');
  assert.equal(storagePath.classification_production, CLASS.DEAD_CODE);
});
