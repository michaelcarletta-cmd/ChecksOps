/**
 * Tenant Management: the OPS badge is a switch in the Company tab, not its own tab.
 * On approves the badge for every contractor profile of the tenant, off revokes it,
 * through admin_set_contractor_pro (platform owner only on the API: workflow-rpc.mjs).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the tenant page has no OPS Badge tab; the Company tab carries the switch', () => {
  const page = read('src/pages/admin/AdminTenants.tsx');
  assert.doesNotMatch(page, /value="pro-badge"/);
  assert.doesNotMatch(page, /setProOpen|proOpen/);
  const company = page.slice(page.indexOf('<TabsContent value="company"'), page.indexOf('<TabsContent value="compliance"'));
  assert.match(company, /<CompanyTab tenant=\{tenant\} onUpdated=\{onUpdated\} \/>/);
  assert.match(company, /<TenantOpsBadgeSwitch tenantId=\{tenant\.id\} tenantName=\{tenant\.name\} \/>/);
  // AdminTenants is the platform owner's page.
  assert.match(page, /setAuthorized\(isPlatformOwner\(email, userId\)\)/);
});

test('the switch: on/off for every contractor profile of the tenant through admin_set_contractor_pro', () => {
  const card = read('src/components/admin/TenantOpsBadgeSwitch.tsx');
  assert.match(card, /<Label htmlFor="tenant-ops-badge">ChecksOps verified<\/Label>/);
  assert.match(card, /Find a Contractor/);
  assert.match(card, /\.from\("tenant_users"\)[\s\S]*?\.eq\("tenant_id", tenantId\)/);
  assert.match(card, /\.from\("contractor_profiles"\)[\s\S]*?\.in\("user_id", userIds\)/);
  assert.match(card, /for \(const profile of profiles\)[\s\S]*?rpc\("admin_set_contractor_pro", \{\s*p_contractor_id: profile\.id,\s*p_approve: approve,/);
  assert.match(card, /profiles\.length > 0 && profiles\.every\(\(p\) => p\.tier === "pro"\)/);
  assert.match(card, /disabled=\{noProfiles\}/);
  // Never a direct tier write from the browser.
  assert.doesNotMatch(card, /\.update\(/);
});

test('the API keeps the badge decision with the platform owner', () => {
  const rpc = read('aws/functions/api/workflow-rpc.mjs');
  const fn = rpc.slice(rpc.indexOf('const executeAdminSetContractorPro'), rpc.indexOf('const executeRecordCheckReturn'));
  assert.match(fn, /requirePlatformOwner\(client\)/);
});
