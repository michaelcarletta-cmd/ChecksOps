/**
 * SPA side of the per-tenant deposits switch (SQL 98 tenants.deposits_enabled):
 * the platform owner's switch in Tenant Management, and the tenant-side notice
 * plus disabled deposit actions. The server refuses regardless
 * (tenant-deposits-gate.test.mjs); these keep the UI honest.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the deposits lib: owner message, help text, platform-owner save, absent = on', () => {
  const lib = read('src/lib/tenantDeposits.ts');
  assert.match(lib, /DEPOSITS_DISABLED_MESSAGE = "Deposits are turned off for this account\. Contact ChecksOps\."/);
  assert.match(lib, /DEPOSITS_SWITCH_HELP = "When off, this tenant cannot submit or record check deposits\."/);
  assert.match(lib, /depositsEnabledValue = \(value: unknown\): boolean => value !== false/);
  const save = lib.slice(lib.indexOf('export async function saveTenantDepositsEnabled'));
  assert.match(save, /functions\.invoke\("tenant-billing-admin"/);
  assert.match(save, /action: "update", tenant_id: tenantId, deposits_enabled: enabled/);
  // Never the generic tenants update.
  assert.doesNotMatch(save, /from\("tenants"\)\.update/);
  // The server message matches the API's.
  const gate = read('aws/functions/api/tenant-deposits-gate.mjs');
  assert.match(gate, /DEPOSITS_DISABLED_MESSAGE = 'Deposits are turned off for this account\. Contact ChecksOps\.'/);
});

test('Tenant Management: a "Deposits enabled" switch with the help text, platform owner page only', () => {
  const card = read('src/components/admin/TenantDepositsSwitch.tsx');
  assert.match(card, /<Label htmlFor="tenant-deposits-enabled">Deposits enabled<\/Label>/);
  assert.match(card, /\{DEPOSITS_SWITCH_HELP\}/);
  assert.match(card, /saveTenantDepositsEnabled\(tenantId, next\)/);
  const page = read('src/pages/admin/AdminTenants.tsx');
  assert.match(page, /<TenantDepositsSwitch\s+tenantId=\{tenant\.id\}[\s\S]*?depositsEnabled=\{tenant\.deposits_enabled\}/);
  // AdminTenants is the platform owner's page.
  assert.match(page, /setAuthorized\(isPlatformOwner\(email, userId\)\)/);
});

test('tenant side: Deposit Ops shows the notice and disables prepare, route, record-deposit and Check Alt submit', () => {
  const ops = read('src/components/deposit-ops/DepositOperationsConsole.tsx');
  assert.match(ops, /const \{ depositsEnabled \} = useTenantDepositsEnabled\(tenantId\);/);
  assert.match(ops, /\{!depositsEnabled && <DepositsDisabledNotice \/>\}/);
  assert.match(ops, /disabled=\{!depositsEnabled\} onClick=\{\(\) => setActionDialog\(\{ action: "prepare_deposit"/);
  assert.match(ops, /disabled=\{!depositsEnabled\}\s+onClick=\{\(e\) => \{ e\.stopPropagation\(\); setActionDialog\(\{ action: "assign_provider"/);
  assert.match(ops, /disabled=\{!depositsEnabled\}\s+onClick=\{\(e\) => \{ e\.stopPropagation\(\); setActionDialog\(\{ action: "mark_manual_deposit"/);
  assert.equal((ops.match(/disabled=\{checkaltSubmitMutation\.isPending \|\| !depositsEnabled\}/g) || []).length, 2, 'Submit and Resubmit Deposit');
  assert.doesNotMatch(ops, /disabled=\{checkaltSubmitMutation\.isPending\}\n/);
});

test('tenant side: Check Alt approve-to-deposit is disabled per row for a tenant whose deposits are off; reject stays', () => {
  const ca = read('src/components/settings/CheckAltSettings.tsx');
  assert.match(ca, /const depositsEnabledFor = useTenantsDepositsEnabled\(/);
  assert.match(ca, /const depositsOn = depositsEnabledFor\(row\.tenant_id\);/);
  assert.match(ca, /action: "approve",[\s\S]*?disabled=\{decide\.isPending \|\| !depositsOn\}/);
  assert.match(ca, /\{!depositsOn && <DepositsDisabledNotice/);
  // Reject is not a deposit.
  assert.match(ca, /onClick=\{\(\) => setRejectingId\(row\.id\)\}\s+disabled=\{decide\.isPending\}/);
  const notice = read('src/components/deposit-ops/DepositsDisabledNotice.tsx');
  assert.match(notice, /role="alert"/);
  assert.match(notice, /\{DEPOSITS_DISABLED_MESSAGE\}/);
});
