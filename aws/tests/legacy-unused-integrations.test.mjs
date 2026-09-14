import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const walkSrc = (dir, acc = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'integrations') {
        // generated types.ts keeps historical stripe_*/telnyx_*/zapier_* columns
        walkSrc(full, acc);
        continue;
      }
      walkSrc(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
};

test('Zapier / Stripe invoke UI and unused billing panels are removed from the SPA', () => {
  const gone = [
    'src/components/settings/ZapierIntegrationSettings.tsx',
    'src/components/billing/BillingConfigPanel.tsx',
    'src/components/white-label/TenantCreditManager.tsx',
  ];
  for (const rel of gone) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, rel);
  }

  const settings = fs.readFileSync(path.join(ROOT, 'src/components/white-label/WhiteLabelSettings.tsx'), 'utf8');
  assert.doesNotMatch(settings, /CheckUsageCard|BillingConfigPanel|TenantCreditManager|ZapierIntegrationSettings/);

  const usage = fs.readFileSync(path.join(ROOT, 'src/components/billing/CheckUsageCard.tsx'), 'utf8');
  assert.doesNotMatch(usage, /report-check-usage-to-stripe/);
  assert.doesNotMatch(usage, /functions\.invoke/);
});

test('SPA source does not invoke retired Stripe/Zapier/Telnyx/Make.com providers', () => {
  const files = walkSrc(path.join(ROOT, 'src'));
  const forbidden = [
    /report-check-usage-to-stripe/,
    /tenant-credit-topup/,
    /tenant-maintenance-subscription/,
    /tenant-checkout/,
    /tenant-billing-webhook/,
    /hooks\.zapier\.com/,
    /api\.telnyx\.com/,
    /make\.com\/webhook/i,
    /integromat/i,
  ];
  const hits = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (rel === 'src/integrations/supabase/types.ts') continue;
    if (rel === 'src/components/settings/MaintenancePaymentsTracker.tsx') continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(text)) hits.push(`${rel} ${pattern}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('retired Stripe billing functions stay fail-closed and off Class A', () => {
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-credit-topup'), false);
  assert.equal(CLASS_A_FUNCTIONS.has('report-check-usage-to-stripe'), false);
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-checkout'), false);
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-billing-webhook'), false);
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-maintenance-subscription'), false);
});

test('Telnyx remains a Class A name only as a sink/status ack, not a live provider', () => {
  assert.equal(CLASS_A_FUNCTIONS.has('send-sms'), true);
  assert.equal(CLASS_A_FUNCTIONS.has('telnyx-sms-status'), true);
  const sms = fs.readFileSync(path.join(ROOT, 'aws/functions/api/sms.mjs'), 'utf8');
  assert.doesNotMatch(sms, /api\.telnyx\.com/);
  assert.match(sms, /LEGACY_UNUSED/);
});
