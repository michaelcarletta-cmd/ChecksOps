#!/usr/bin/env node
/**
 * Verify the composed production SPA candidate is a fresh build
 * of live WalletOps (Item #4) plus settings/branding/deposits.
 * Does not upload or write AWS.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const FORBIDDEN_ENTRIES = [
  'index-DvVldu_B.js',
  'index-BPbQUNFr.js',
  'index-C9QrEEkl.js',
  'index-C_fh5VBD.js',
  'index-BhNaw7aH.js',
];

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha256Text = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const entryMatch = html.match(/\/assets\/(index-[^"'\\s]+\.js)/);
const entryName = entryMatch ? entryMatch[1] : null;
const entryRel = entryMatch ? entryMatch[0] : null;
const checks = [];
const check = (id, ok, extra = {}) => checks.push({ id, ok, ...extra });

check('fresh_entry', Boolean(entryName) && !FORBIDDEN_ENTRIES.includes(entryName), {
  entry: entryRel,
  forbidden: FORBIDDEN_ENTRIES,
});

const entryPath = entryName ? path.join(DIST, 'assets', entryName) : null;
const walletChunk = fs.readdirSync(path.join(DIST, 'assets')).find((name) => name.startsWith('WalletOps-') && name.endsWith('.js'));
const depositChunk = fs.readdirSync(path.join(DIST, 'assets')).find((name) => name.startsWith('BankDepositReconciliation-') && name.endsWith('.js'));
const indexJs = entryPath && fs.existsSync(entryPath) ? fs.readFileSync(entryPath, 'utf8') : '';
const walletJs = walletChunk ? fs.readFileSync(path.join(DIST, 'assets', walletChunk), 'utf8') : '';
const depositJs = depositChunk ? fs.readFileSync(path.join(DIST, 'assets', depositChunk), 'utf8') : '';
const combined = `${indexJs}\n${walletJs}\n${depositJs}`;

check('walletops_item4_hides_payment_account_card', !/title:"Payment Account"/.test(walletJs) && !/title:"Payout Preferences"/.test(walletJs));
check('walletops_keeps_go_to_payment_account', walletJs.includes('Go to Payment Account'));
check('walletops_keeps_settlement_and_payout', walletJs.includes('Settlement bank') && walletJs.includes('Payout speed'));
check('deposits_exclusion', depositJs.includes('rejected,returned,error,declined') || combined.includes('rejected,returned,error,declined'));
check('stakeholder_bank_vs_provider', combined.includes('Bank verified') && combined.includes('Provider linked'));
check('branding_invoice_accent', combined.includes('invoice_accent_color') || combined.includes('invoiceAccentColor'));
check('email_sender_identity', combined.includes('Sender identity'));
check('not_wholesale_staging_spa', entryName !== 'index-DvVldu_B.js');

const failed = checks.filter((row) => row.ok !== true);
const report = {
  ok: failed.length === 0,
  entry: entryRel,
  entry_sha256: entryPath && fs.existsSync(entryPath) ? sha256File(entryPath) : null,
  index_html_sha256: sha256Text(html),
  wallet_chunk: walletChunk || null,
  deposit_chunk: depositChunk || null,
  checks,
};
fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
fs.writeFileSync('/opt/cursor/artifacts/composed-spa-bundle-verify.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
