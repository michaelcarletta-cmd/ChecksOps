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
const sweep = readFileSync(join(root, "supabase/functions/moov-sweep-config/index.ts"), "utf8");
const walletSync = readFileSync(join(root, "supabase/functions/moov-wallet-sync/index.ts"), "utf8");
const transferStatus = readFileSync(join(root, "supabase/functions/moov-transfer-status/index.ts"), "utf8");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("Recent Wallet Activity sits in the main grid as a large box", () => {
  const activity = page.indexOf('title="Recent Wallet Activity"');
  const gridClose = page.indexOf("Running Balance");
  assert.ok(activity > 0);
  assert.ok(activity < gridClose, "activity should be above running balance");
  assert.match(page, /lg:col-span-2/);
});

test("production Item #4 hides Payment Account and Payout Preferences sections", () => {
  assert.doesNotMatch(page, /title="Payment Account"/);
  assert.doesNotMatch(page, /title="Payout Preferences"/);
  assert.match(page, /Go to Payment Account/);
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

test("Treasury card still reads settlement bank and payout speed", () => {
  assert.match(page, /Settlement bank/);
  assert.match(page, /Payout speed/);
  assert.match(sweep, /pickSettlementMethod/);
  assert.match(sweep, /resolveRails/);
});

test("Check status does not fail the whole request when nothing is in flight", () => {
  assert.match(transferStatus, /if \(!rows\?\.length\)/);
  assert.match(hooks, /invokeErrorMessage/);
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
