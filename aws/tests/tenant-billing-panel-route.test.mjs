/**
 * The "Monthly fee auto-billing" settings panel (TenantBillingAccountPanel) writes
 * tenant_billing_accounts only through the API route save-tenant-billing-account
 * (tenant-settings-handlers.mjs), never through a direct browser write:
 * tenant_billing_accounts is a money table that the generic /data/write path
 * refuses and that SQL 136 lets only flagged server handlers write.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const panel = read('src/components/settings/TenantBillingAccountPanel.tsx');
const appServices = read('aws/functions/api/app-services.mjs');
const handlers = read('aws/functions/api/tenant-settings-handlers.mjs');
const writeAllowlist = read('aws/functions/api/write-allowlist.mjs');

test('the panel never writes tenant_billing_accounts from the browser', () => {
  // The only direct access left is the read of the linked account.
  const direct = [...panel.matchAll(/\.from\("tenant_billing_accounts"\)([\s\S]{0,80})/g)].map((m) => m[1]);
  assert.equal(direct.length, 1);
  assert.match(direct[0], /^\s*\.select\(/);
  assert.doesNotMatch(panel, /\.(insert|update|upsert|delete)\(/);
  // The generic write path does not list the table either.
  assert.doesNotMatch(writeAllowlist, /tenant_billing_accounts/);
});

test('link and auto-debit go through save-tenant-billing-account with the fields the route reads', () => {
  assert.match(panel, /functions\.invoke\("save-tenant-billing-account"/);
  // Link: the chosen verified account, the ACH authorization and the tenant.
  assert.match(panel, /action: "save",[\s\S]{0,160}stakeholder_account_id: selectedId,[\s\S]{0,80}authorized: true/);
  // Toggle: the route's toggle action.
  assert.match(panel, /action: "toggle_auto_debit", tenant_id: tenantId, auto_debit_enabled: enabled/);
  // A refusal ({ ok: false }) is shown, not swallowed.
  assert.match(panel, /\(data as \{ ok\?: boolean \}\)\.ok === false/);
  assert.match(panel, /toast\.error\(e\?\.message \?\? "Failed to update auto-debit"\)/);
  // A change the database did not make is named, not shown as saved.
  assert.match(panel, /billing_update_not_applied: "The change was not saved\. Contact ChecksOps support\."/);
  // On success both actions write the row the server stored into the card's cache.
  assert.equal((panel.match(/qc\.setQueryData\(\["tenant-billing-account", tenantId\], stored\)/g) || []).length, 2);
  assert.match(panel, /function storedBilling\(data: unknown\)/);
  assert.match(panel, /return saveBillingAccount\(\{ action: "toggle_auto_debit"/);
  // The request bodies carry no server-owned field (the read and the stored-row cache still name some).
  const requests = [...panel.matchAll(/saveBillingAccount\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
  assert.equal(requests.length, 2);
  for (const body of requests) {
    for (const field of ['ach_authorized_at', 'verification_status', 'entity_type', 'account_holder_name']) {
      assert.doesNotMatch(body, new RegExp(`\\b${field}\\b`), field);
    }
  }
});

test('the route exists, is dispatched, and reads exactly what the panel sends', () => {
  assert.match(appServices, /'save-tenant-billing-account',/);
  assert.match(appServices, /case 'save-tenant-billing-account':\s*\n\s*return handleSaveTenantBillingAccount\(event\);/);
  assert.match(handlers, /const tenantId = body\.tenantId \|\| body\.tenant_id;/);
  assert.match(handlers, /action === 'toggle_auto_debit'/);
  assert.match(handlers, /stakeholderId: body\.stakeholder_account_id \|\| body\.stakeholderAccountId \|\| null/);
  assert.match(handlers, /authorized: body\.authorized === true \|\| body\.authorize_ach === true/);
  // The route sets the server-only money-write flag before each write.
  assert.equal((handlers.match(/await setMoneyWriteFlag\(client\);/g) || []).length, 2);
  // A write that changed no row is refused, never reported as saved.
  assert.equal((handlers.match(/error: 'billing_update_not_applied'/g) || []).length, 2);
});
