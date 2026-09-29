import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(p, 'utf8');

test('combined SPA source keeps Moov GA frontend behavior', () => {
  const flags = read('src/lib/payments/featureFlags.ts');
  assert.match(flags, /generally available/);
  assert.match(flags, /export function isMoovAllowedForTenant\(_tenantAllowlisted\?: boolean \| null\): boolean/);
  assert.match(flags, /return PAYMENT_FLAGS\.USE_MOOV;/);
  assert.doesNotMatch(flags, /USE_MOOV && !!tenantAllowlisted/);

  const defaults = read('src/lib/payments/tenantMoovDefaults.ts');
  assert.match(defaults, /export function tenantMoovDefaults/);
  assert.match(defaults, /moov_environment: opts\?\.isTestAccount \? "sandbox" : "production"/);

  const eligibility = read('src/hooks/usePaymentProviderEligibility.ts');
  assert.match(eligibility, /\.select\("moov_environment"\)/);
  assert.match(eligibility, /allowlisted: true/);
  assert.match(eligibility, /isMoovAllowedForTenant\(\) && !!tenantId/);
  assert.doesNotMatch(eligibility, /moov_allowlisted, moov_environment/);

  const panel = read('src/components/settings/TenantPaymentAccountPanel.tsx');
  assert.doesNotMatch(panel, /Payments enabled for this organization/);
  assert.doesNotMatch(panel, /toggleAllowlist/);

  const admin = read('src/pages/admin/AdminTenants.tsx');
  assert.match(admin, /tenantMoovDefaults\(\)/);

  const tenants = read('src/components/settings/TenantManagement.tsx');
  assert.match(tenants, /\.\.\.tenantMoovDefaults\(\)/);

  const stakeholders = read('src/components/disbursement/CheckStakeholdersManager.tsx');
  assert.match(stakeholders, /PAYMENT_FLAGS\.USE_MOOV/);
  assert.doesNotMatch(stakeholders, /isMoovAllowedForTenant\(\(tenant as any\)\?\.moov_allowlisted\)/);
});

test('combined SPA source keeps Claim Ledger find/link/create and update-only save', () => {
  const card = read('src/components/payments/ClaimLedgerCard.tsx');
  assert.match(card, /Find Existing Claim/);
  assert.match(card, /Link Existing Ledger/);
  assert.match(card, /Start New Claim Ledger/);
  assert.match(card, /Existing claim found/);
  assert.match(card, /claim_ledger_link_or_create|CLAIM_LEDGER_LINK_RPC/);
  assert.match(card, /handleLedgerAction\("inspect"\)/);
  assert.match(card, /handleLedgerAction\("link_existing"\)/);
  assert.match(card, /handleLedgerAction\("create_new"\)/);
  assert.match(card, /mode === "update_existing"/);
  assert.match(card, /\.from\("claims"\)[\s\S]*\.update\(\{ claim_number: plan\.claimNumber \}\)/);
  assert.equal(/\.from\("claims"\)[\s\S]*\.insert\(/.test(card), false);
  assert.equal(/\.from\("check_intake_items"\)[\s\S]{0,80}\.update\(/.test(card), false);

  const guard = read('src/lib/checkClaimLinkGuard.ts');
  assert.match(guard, /export const CLAIM_LEDGER_LINK_RPC = "claim_ledger_link_or_create"/);
  assert.match(guard, /Claim Ledger Save only writes an in-place claim_number update/);

  const ccc = read('src/pages/CheckCommandCenter.tsx');
  assert.match(ccc, /ClaimLedgerCard/);
  assert.match(ccc, /lg:flex-row/);
  assert.match(ccc, /selectedCheck \? "58%" : "80%"/);
});

test('combined SPA source keeps #533 Send for Homeowner Signature', () => {
  const files = read('src/components/check-review/CheckFilesSection.tsx');
  assert.match(files, /Send for Homeowner Signature/);
  const sig = read('src/components/claim-detail/SignatureRequests.tsx');
  assert.match(sig, /Send for Signature/);
  const src = read('src/lib/signature-source-files.ts');
  assert.match(src, /mergeClaimAndCheckSignatureFiles/);
});
