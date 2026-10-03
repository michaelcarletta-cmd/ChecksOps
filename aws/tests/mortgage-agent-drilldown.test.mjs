import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveAdminTenantTab } from '../../src/lib/adminTenantTab.ts';

const AWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(AWS, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('?tab=mortgage-agents selects Mortgage Agents and unknown tabs stay on tenants', () => {
  assert.equal(resolveAdminTenantTab('mortgage-agents'), 'mortgage-agents');
  assert.equal(resolveAdminTenantTab('tenants'), 'tenants');
  assert.equal(resolveAdminTenantTab('checkalt'), 'checkalt');
  assert.equal(resolveAdminTenantTab('platform-finance'), 'platform-finance');
  assert.equal(resolveAdminTenantTab('not-a-tab'), 'tenants');
  assert.equal(resolveAdminTenantTab(null), 'tenants');

  const tenants = read('src/pages/admin/AdminTenants.tsx');
  assert.match(tenants, /searchParams\.get\("tab"\)/);
  assert.match(tenants, /<TabsContent value="mortgage-agents">\s*<MortgageAgentsPanel \/>/);
  assert.match(tenants, /isPlatformOwner\(email, userId\)/);

  const alias = read('src/pages/admin/AdminMortgageOps.tsx');
  assert.match(alias, /\/admin\/tenants\?tab=mortgage-agents/);
  assert.match(alias, /<MortgageAgentsPanel \/>/);
  assert.match(alias, /isPlatformOwner\(user\.email, user\.id\)/);
});

test('files drilldown renders homeowner, claim, check, dates, class, pay bookkeeping', () => {
  const panel = read('src/components/admin/MortgageAgentsPanel.tsx');
  for (const needle of [
    'entry.homeowner_name',
    'entry.claim_number',
    'entry.claim_id',
    'entry.check_intake_item_id',
    'entry.mortgage_company',
    'entry.accepted_at',
    'entry.completed_at',
    'entry.payment_date',
    'entry.payment_reference',
    'entry.payment_note',
    'label="Homeowner"',
    'label="Claim number"',
    'label="Claim ID"',
    'label="Check ID"',
    'label="Mortgage company"',
    'label="Accepted date"',
    'label="Completed date"',
    'label="Classification"',
    'label="Compensation amount"',
    'label="Compensation status"',
    'label="Payment date"',
    'label="Payment reference"',
    'label="Bookkeeping / payment note"',
    'data-testid="compensation-entry-drilldown"',
  ]) {
    assert.ok(panel.includes(needle), `missing ${needle}`);
  }
  assert.match(panel, /label="Initial \$10"/);
  assert.match(panel, /label="Additional \$5"/);
  assert.match(panel, /label="Files Worked"/);
  assert.match(panel, /label="Gross Owed"/);
  assert.match(panel, /label="Paid"/);
  assert.match(panel, /label="Balance"/);
});

test('AWS hire dialog stays passwordless and does not create tenant_users', () => {
  const panel = read('src/components/admin/MortgageAgentsPanel.tsx');
  const hire = read('aws/functions/api/tenant-admin.mjs');
  const hireFn = hire.slice(
    hire.indexOf('export const runHireMortgageAgent'),
    hire.indexOf('export const handleHireMortgageAgent'),
  );

  assert.match(panel, /const passwordlessHire = isAwsStaging\(\)/);
  assert.match(panel, /passwordlessHire \? null : \(\s*<div><Label>Optional password<\/Label>/);
  assert.match(panel, /AWS staging hire is passwordless Cognito EMAIL_OTP/);
  assert.match(panel, /passwordlessHire\s*\?\s*\{\s*full_name: cleanName,\s*email: cleanEmail\s*\}/);

  assert.doesNotMatch(hireFn, /INSERT INTO public\.tenant_users/);
  assert.match(hireFn, /INSERT INTO public\.identity_accounts/);
  assert.match(hireFn, /INSERT INTO public\.user_roles/);
  assert.match(hireFn, /INSERT INTO public\.mortgage_agent_accounts/);
  assert.match(hireFn, /MessageAction: 'SUPPRESS'/);
  assert.doesNotMatch(hireFn, /temp_password:/);
});

test('entries SELECT adds homeowner_name without changing earn or pay math', () => {
  const api = read('aws/functions/api/mortgage-agent-compensation.mjs');
  const sql47 = read('aws/isolated/mortgage-agent-compensation/sql/47_mortgage_agent_compensation.sql');
  const handleEntries = api.slice(api.indexOf('async function handleEntries'), api.indexOf('async function handleReconciliation'));
  const handleMonthly = api.slice(api.indexOf('async function handleMonthly'), api.indexOf('async function handleEntries'));

  assert.match(handleEntries, /r\.homeowner_name/);
  assert.match(handleEntries, /r\.claim_number/);
  assert.doesNotMatch(handleEntries, /SUM\(e\.amount_cents\)/);
  assert.match(handleMonthly, /classification = 'initial'/);
  assert.match(handleMonthly, /classification = 'additional'/);
  assert.match(handleMonthly, /gross_owed_cents/);
  assert.doesNotMatch(handleMonthly, /homeowner_name/);

  assert.match(api, /approve_mortgage_agent_compensation/);
  assert.match(api, /mark_mortgage_agent_compensation_paid/);
  assert.doesNotMatch(api, /moov_|stripe_|bill-mortgage-handling/);
  assert.match(sql47, /earn_mortgage_agent_compensation/);
  assert.match(sql47, /5b20db20-13e1-4919-9528-06388d8661d2/);
});

test('Branding and Homeowner protected contracts remain in this source', () => {
  const tenants = read('src/pages/admin/AdminTenants.tsx');
  const emailSender = read('src/components/settings/EmailSenderSettings.tsx');
  const company = read('src/components/settings/CompanyBrandingSettings.tsx');
  const app = read('src/App.tsx');

  assert.match(tenants, /<EmailSenderSettings showSendingDomain=\{true\} \/>/);
  assert.match(tenants, /Branding & Email/);
  assert.match(emailSender, /showSendingDomain && <SectionCard\s+title="Sending subdomain"/);
  assert.match(emailSender, /Email Brand Color|email brand color|brandColor/i);
  assert.match(company, /Application Sidebar Logo/);
  assert.match(app, /path="\/h\/ledger\/:token"/);
  assert.match(app, /HomeownerLedger/);
});
