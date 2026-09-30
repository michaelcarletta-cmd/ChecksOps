import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIVE = '82460c8c2ebbc8c7996b9cc233058015933120df';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const live = (rel) => execFileSync('git', ['show', `${LIVE}:${rel}`], { encoding: 'utf8' });

test('Default payout speed: live inline save is the same sweep write as candidate Manage sweeps', () => {
  const liveWallet = live('src/pages/WalletOps.tsx');
  const candWallet = read('src/pages/WalletOps.tsx');
  const livePanel = live('src/components/payments/MoovTreasuryPanel.tsx');
  const candPanel = read('src/components/payments/MoovTreasuryPanel.tsx');
  const hook = read('src/hooks/useSweepConfig.ts');

  assert.match(liveWallet, /htmlFor="walletops-rail"/);
  assert.match(liveWallet, /Default payout speed/);
  assert.match(liveWallet, /Save payout preference/);
  assert.match(liveWallet, /async function handleSavePayoutSpeed/);
  assert.match(liveWallet, /pushRail: effectiveRail/);
  assert.match(liveWallet, /<MoovTreasuryPanel \/>/);
  assert.match(liveWallet, /Manage sweeps/);

  assert.equal(/Default payout speed/.test(candWallet), false);
  assert.equal(/Save payout preference/.test(candWallet), false);
  assert.match(candWallet, /large box in place of the old payout-preference slot/);
  assert.match(candWallet, /Manage sweeps/);
  assert.match(candWallet, /<MoovTreasuryPanel \/>/);
  assert.match(candWallet, /config\?\.push_rail/);

  assert.equal(candPanel, livePanel, 'MoovTreasuryPanel must stay the live DSb treasury editor');
  assert.match(candPanel, /Choose a payout speed first/);
  assert.match(candPanel, /htmlFor="sweep-rail"|id="sweep-rail"/);
  assert.match(candPanel, /pushRail: rail/);
  assert.match(hook, /updateSweep|createSweep/);
  assert.match(hook, /pushRail/);
});

test('Invoice letterhead: candidate still writes and renders invoice_letterhead_url', () => {
  const liveBrand = live('src/components/settings/CompanyBrandingSettings.tsx');
  const candBrand = read('src/components/settings/CompanyBrandingSettings.tsx');
  const invoice = read('src/pages/PublicInvoicePage.tsx');
  const tab = read('src/pages/payments/InvoicesTab.tsx');

  assert.match(liveBrand, /invoice-letterhead-upload/);
  assert.match(liveBrand, /Click to upload invoice letterhead/);
  assert.match(liveBrand, /invoice_letterhead_url/);

  assert.equal(/invoice-letterhead-upload/.test(candBrand), false);
  assert.match(candBrand, /Click to upload an independent invoice logo/);
  assert.match(candBrand, /handleInvoiceLogoUpload/);
  assert.match(candBrand, /uploadTenantAsset\(tenantId, file, "invoice-logo", "company-branding"\)/);
  assert.match(candBrand, /persistInvoice \? \{ invoice_letterhead_url: persistInvoice \}/);
  assert.match(candBrand, /persistableLogoField/);
  assert.match(candBrand, /Leave blank to keep the existing invoice logo/);

  assert.match(invoice, /invoice_letterhead_url/);
  assert.match(invoice, /assetBucket="company-branding"/);
  assert.match(tab, /invoice_letterhead_url \|\| branding\?\.logo_url/);
});

test('DKIM/sending-subdomain: live UI is feature-disabled; candidate keeps platform-sender branding', () => {
  const liveEmail = live('src/components/settings/EmailSenderSettings.tsx');
  const candEmail = read('src/components/settings/EmailSenderSettings.tsx');
  const yaml = read('aws/template.yaml');
  const handlers = read('aws/functions/api/tenant-email-domain-handlers.mjs');
  const domain = read('aws/functions/api/tenant-email-domain.mjs');

  assert.match(liveEmail, /Sending subdomain/);
  assert.match(liveEmail, /DKIM DNS records/);
  assert.match(liveEmail, /tenant-domain-verify/);
  assert.match(liveEmail, /SES domain APIs are not enabled in this environment/);
  assert.match(liveEmail, /domainFeatureEnabled === false/);

  assert.equal(/Sending subdomain/.test(candEmail), false);
  assert.equal(/DKIM DNS records/.test(candEmail), false);
  assert.equal(/tenant-domain-verify/.test(candEmail), false);
  assert.match(candEmail, /Platform sender \(active\)/);
  assert.match(candEmail, /noreply@checksops\.com/);
  assert.match(candEmail, /persistLogo \? \{ logoUrl: persistLogo \}/);
  assert.match(candEmail, /tenant-email-branding-save/);
  assert.match(candEmail, /Reply-To address/);

  assert.match(yaml, /AWS_TENANT_EMAIL_DOMAIN_ENABLED:\s*"false"/);
  assert.match(domain, /Live SESv2 is never constructed unless AWS_TENANT_EMAIL_DOMAIN_ENABLED=true/);
  assert.match(handlers, /error: 'tenant_email_domain_disabled'/);
  assert.match(handlers, /if \(!tenantEmailDomainEnabled\(\) && !sesv2\)/);
  assert.match(handlers, /return featureDisabled\(spoof\)/);
});
