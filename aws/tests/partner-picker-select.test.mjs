import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('choosing a partner in the check picker calls no disabled RPC and writes nothing', () => {
  const manager = read('src/components/disbursement/CheckStakeholdersManager.tsx');
  // add_partner_stakeholder_to_check stays disabled on AWS (provider_dependent).
  assert.doesNotMatch(manager, /add_partner_stakeholder_to_check/);
  assert.match(manager, /useSelectedPartners\(checkIntakeItemId\)/);
  assert.match(manager, /onClick=\{\(\) => choosePartner\(p\)\}/);
  // The partner list is still the read-only RPC.
  assert.match(manager, /rpc\("list_partner_payout_options"/);
});

test('chosen partners join the payment list and are sent as partner recipients', () => {
  const consoleSrc = read('src/components/disbursement/DisbursementConsole.tsx');
  assert.match(consoleSrc, /useSelectedPartners\(checkIntakeItemId\)/);
  assert.match(consoleSrc, /added_via: "partner_selected"/);
  // Partner rows are sent as { kind: "partner", partner_tenant_id }.
  assert.match(consoleSrc, /kind: "partner", partner_tenant_id: acct\.partner_tenant_id/);
  const store = read('src/lib/payments/selectedPartners.ts');
  // Browser storage only, guarded; no network write.
  assert.match(store, /window\.sessionStorage/);
  assert.doesNotMatch(store, /supabase|fetch\(/);
  assert.equal((store.match(/try \{/g) || []).length, 2);
});
