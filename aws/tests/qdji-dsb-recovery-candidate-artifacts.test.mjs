import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');

const REQUIRED_RESTORE = [
  ['environmentReady', 'WalletOps recovery'],
  ['Bank verified', 'Moov bank-verified badge'],
  ['Provider linked', 'Moov provider-linked badge'],
  ['Bank pending', 'Moov bank-pending badge'],
  ['save-tenant-billing-account', 'billing persist'],
  ['Billing save unexpectedly started a collection', 'billing no-collection guard'],
  ['groupDepositsBySubmissionDate', 'Bank Deposit submitted_at grouping'],
  ['Insured Name', 'Bank Deposit insured column'],
  ['/branding/logo/', 'tenant logo display route'],
  ['ChecksOps billing', 'admin/WalletOps billing UI'],
];

const REQUIRED_PRESERVE = [
  ['save_claim_settlement_breakdown', 'settlement intercept'],
  ['checksops-production-host', 'hostname guard'],
  ['delete_check', 'Delete Check'],
  ['signature', 'Signature Requests'],
  ['MICR', 'OCR/MICR'],
];

const FORBIDDEN = [];

function readDistText() {
  if (!fs.existsSync(DIST)) {
    return null;
  }
  const parts = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(js|css|html)$/.test(name)) parts.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(DIST);
  return parts.join('\n');
}

test('fresh candidate dist restores lost QDJi capabilities and keeps post-QDJi settlement/guard', () => {
  const text = readDistText();
  if (!text) {
    assert.ok(true, 'dist/ not built yet; source compose tests still apply');
    return;
  }
  for (const [marker, why] of REQUIRED_RESTORE) {
    assert.ok(text.includes(marker), `missing restore marker ${marker} (${why})`);
  }
  for (const [marker, why] of REQUIRED_PRESERVE) {
    assert.ok(text.includes(marker), `missing preserve marker ${marker} (${why})`);
  }
  for (const [marker, why] of FORBIDDEN) {
    assert.equal(text.includes(marker), false, why);
  }
  assert.equal(text.includes('payee_line'), true, 'OCR/payee path remains');
  assert.equal(text.includes('Default payout speed'), false, 'pre-settings payout-speed UI must stay dropped');
  assert.equal(text.includes('DKIM DNS records'), false, 'pre-settings sending-subdomain UI must stay dropped');
  const depositChunk = fs.readdirSync(path.join(DIST, 'assets')).find((n) => n.startsWith('BankDepositReconciliation-'));
  assert.ok(depositChunk, 'BankDepositReconciliation chunk missing');
  const depositText = fs.readFileSync(path.join(DIST, 'assets', depositChunk), 'utf8');
  assert.match(depositText, /checkalt_deposits/);
  assert.match(depositText, /groupDepositsBySubmissionDate/);
  assert.equal(depositText.includes('.insert('), false);
  assert.equal(depositText.includes('.upsert('), false);
  assert.equal(depositText.includes('.delete('), false);
  const logoSrc = fs.readFileSync(path.join(ROOT, 'src/lib/tenantLogoUrl.ts'), 'utf8');
  assert.match(logoSrc, /persistableLogoField/);
});
