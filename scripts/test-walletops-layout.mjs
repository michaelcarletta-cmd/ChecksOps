/**
 * WalletOps page layout/source contracts.
 *
 * Run: node scripts/test-walletops-layout.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(join(root, "src/pages/WalletOps.tsx"), "utf8");
const hooks = readFileSync(join(root, "src/hooks/useWalletOps.ts"), "utf8");
const useWallet = readFileSync(join(root, "src/hooks/useWallet.ts"), "utf8");
const loadSnapshot = readFileSync(join(root, "src/lib/payments/loadWalletSnapshot.ts"), "utf8");
const sweep = readFileSync(join(root, "supabase/functions/moov-sweep-config/index.ts"), "utf8");
const walletSync = readFileSync(join(root, "supabase/functions/moov-wallet-sync/index.ts"), "utf8");
const transferStatus = readFileSync(join(root, "supabase/functions/moov-transfer-status/index.ts"), "utf8");
const compliance = readFileSync(join(root, "src/components/settings/ComplianceSettings.tsx"), "utf8");
const whiteLabel = readFileSync(join(root, "src/components/white-label/WhiteLabelSettings.tsx"), "utf8");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("Recent Wallet Activity sits in the main grid as a large box", () => {
  const activity = page.indexOf('title="Recent Wallet Activity"');
  const gridClose = page.indexOf("Running Balance");
  assert.ok(activity > 0);
  assert.ok(activity < gridClose, "activity should be above running balance");
  assert.match(page, /lg:col-span-2/);
});

test("Balances by Organization is removed", () => {
  assert.doesNotMatch(page, /Balances by Organization/);
  assert.doesNotMatch(hooks, /useAllTenantWalletBalances/);
});

test("Refresh balances forces a provider sync", () => {
  assert.match(page, /handleRefreshBalances/);
  assert.match(page, /refreshWallet\.mutateAsync/);
  assert.match(page, /refreshSweeps\.mutateAsync/);
  assert.match(walletSync, /skipProviderFetch: !force && !isVerified/);
});

test("Sweep backend still resolves settlement bank and rails", () => {
  assert.match(sweep, /pickSettlementMethod/);
  assert.match(sweep, /resolveRails/);
  assert.doesNotMatch(page, /save\.mutateAsync/);
  assert.doesNotMatch(page, /handleSavePayoutSpeed/);
});

test("Check status does not fail the whole request when nothing is in flight", () => {
  assert.match(transferStatus, /if \(!rows\?\.length\)/);
  assert.match(hooks, /invokeErrorMessage/);
});

test("Pending In/Out are wallet-relative, not every tenant transfer", () => {
  assert.match(hooks, /summarizeWalletOps/);
  assert.match(hooks, /source_payment_method_id, destination_payment_method_id/);
  assert.doesNotMatch(hooks, /leg_role !== ["']funding["']/);
  assert.match(page, /Funding & Billing/);
  assert.match(page, /Wallet first, then connected bank for the remainder/);
});

test("Billing activity remains visible even when the bank leg is not Pending Out", () => {
  assert.match(page, /ChecksOps Billing/);
  assert.match(page, /Funding: Wallet/);
  assert.match(hooks, /tenant_maintenance_payments/);
});

test("Item #4 WalletOps does not render Payment Account management", () => {
  assert.doesNotMatch(page, /title="Payment Account"/);
  assert.doesNotMatch(page, /Open Payment Account/);
  assert.doesNotMatch(page, /PaymentAccountPanel/);
  assert.doesNotMatch(page, /PaymentReadinessPanel/);
});

test("Item #4 WalletOps does not render Payout Preferences", () => {
  assert.doesNotMatch(page, /title="Payout Preferences"/);
  assert.doesNotMatch(page, /walletops-rail/);
  assert.doesNotMatch(page, /Save payout preference/);
});

test("Item #4 Compliance and Documents still provides Payment Account", () => {
  assert.match(whiteLabel, /Compliance & Docs/);
  assert.match(whiteLabel, /<ComplianceSettings \/>/);
  assert.match(compliance, /title="Payment Account Setup"/);
  assert.match(compliance, /PaymentAccountPanel/);
  assert.match(compliance, /PaymentReadinessPanel/);
});

test("Item #4 Funding & Billing and pending cards remain", () => {
  assert.match(page, /Funding & Billing/);
  assert.match(page, /Pending in/);
  assert.match(page, /Pending out/);
  assert.match(page, /Recent Wallet Activity/);
  assert.match(page, /Available operating balance/);
});

test("Automatic payouts are explained and listed in activity", () => {
  assert.match(page, /leftover wallet money is sent to your bank every day/);
  assert.match(page, /summarizeSweepActivity/);
  assert.match(page, /Automatic payout/);
});

test("WalletOps wallet reads are environment-aware and never maybeSingle all operating rows", () => {
  assert.match(hooks, /selectPaymentWallet/);
  assert.match(hooks, /resolveWalletOpsEnvironment/);
  assert.match(hooks, /\.eq\("environment", walletEnvironment\)/);
  assert.doesNotMatch(hooks, /\.eq\("wallet_type", "operating"\)[\s\S]{0,80}\.maybeSingle\(\)/);
});

test("Existing production wallet is not Pending setup when sync 409/502s", () => {
  assert.match(useWallet, /loadWalletSnapshot/);
  assert.match(useWallet, /readWallet/);
  assert.match(useWallet, /tenantMoovEnvironment/);
  assert.match(loadSnapshot, /setup_required:\s*false/);
  assert.match(loadSnapshot, /isSetupError/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`fail  ${name}\n      ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
