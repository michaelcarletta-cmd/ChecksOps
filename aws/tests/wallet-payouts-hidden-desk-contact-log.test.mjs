/**
 * Owner decisions of 2026-11-12, held in place:
 *  - Wallet & Treasury: automatic payouts (Moov treasury sweeps) are hidden. Production refuses every
 *    sweep-config change (production_execution_blocked), so the on/off button, the sweep settings
 *    ("Manage sweeps" / MoovTreasuryPanel) and "Last automatic payout" stay behind
 *    PAYMENT_FLAGS.SHOW_AUTOMATIC_PAYOUTS, which is false and not an env flag.
 *  - Mortgage Desk request page: "Log update to homeowner timeline" and "Updates to tenant" sit side by
 *    side in one grid; the shipping card's "Internal notes (optional)" field is removed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('automatic payouts: the flag is false and not read from the environment', () => {
  const flags = read('src/lib/payments/featureFlags.ts');
  assert.match(flags, /^\s*SHOW_AUTOMATIC_PAYOUTS: false,$/m);
  assert.doesNotMatch(flags, /envFlag\("SHOW_AUTOMATIC_PAYOUTS"/);
});

test('Wallet & Treasury: every automatic-payout control is behind the flag', () => {
  const page = read('src/pages/WalletOps.tsx');
  assert.match(page, /const SHOW_AUTOMATIC_PAYOUTS = PAYMENT_FLAGS\.SHOW_AUTOMATIC_PAYOUTS;/);
  // The on/off button, the badge, the sweep tiles and the Manage sweeps dialog each sit behind it.
  assert.match(page, /\{SHOW_AUTOMATIC_PAYOUTS && payoutControl\.show && \(/);
  assert.match(page, /SHOW_AUTOMATIC_PAYOUTS \? \(\s*<Badge/);
  for (const text of ['Last automatic payout', 'Payout speed', '<MoovTreasuryPanel />']) {
    const at = page.indexOf(text, page.indexOf('title="Wallet & Treasury"'));
    assert.ok(at > 0, text);
    const gate = page.lastIndexOf('{SHOW_AUTOMATIC_PAYOUTS && (', at);
    assert.ok(gate > page.indexOf('title="Wallet & Treasury"'), `${text} is gated`);
  }
  const settings = read('src/pages/payments/PaymentSettingsTab.tsx');
  assert.match(settings, /\{PAYMENT_FLAGS\.SHOW_AUTOMATIC_PAYOUTS && <MoovTreasuryPanel \/>\}/);
  // Real sweep movements still show in the activity list, without the "automatic payout" wording.
  assert.match(page, /sweep: "Sweep to bank",/);
  assert.match(read('src/lib/payments/walletSweepActivity.ts'), /title: "Sweep to bank",/);
  assert.match(read('src/lib/payments/walletRelativeTransfers.ts'), /return "Sweep to bank";/);
});

test('Mortgage Desk: the homeowner and tenant updates sit together; Internal notes is removed', () => {
  const page = read('src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx');
  const grid = page.indexOf('<div className="grid grid-cols-1 gap-4 md:grid-cols-2 [&>*]:min-w-0">');
  assert.ok(grid > 0);
  const home = page.indexOf('Log update to homeowner timeline', grid);
  const tenant = page.indexOf('Updates to tenant', grid);
  const shipping = page.indexOf('{/* Shipping & mail-to', grid);
  assert.ok(home > grid && tenant > home && shipping > tenant, 'both cards are inside the grid, before Shipping');
  assert.equal(page.split('Updates to tenant').length - 1, 1, 'one tenant card');
  assert.doesNotMatch(page, />Internal notes \(optional\)</, "no visible Internal notes label");
  // Existing notes are kept: the saved value is still loaded and sent unchanged.
  assert.match(page, /setInvoiceNotes\(rr\.invoice_notes \|\| ""\)/);
  assert.match(page, /invoice_notes: invoiceNotes\.trim\(\) \|\| null,/);
});
