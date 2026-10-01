import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const settings = read('src/components/white-label/WhiteLabelSettings.tsx');
const partnerManager = read('src/components/white-label/TenantPartnerManager.tsx');
const usageTracker = read('src/components/billing/TenantUsageTracker.tsx');
const billingPanel = read('src/components/settings/TenantBillingAccountPanel.tsx');
const notificationPrefs = read('src/components/settings/NotificationPreferencesSettings.tsx');

const profileTab = settings.slice(
  settings.indexOf('<TabsContent value="profile"'),
  settings.indexOf('<TabsContent value="usage"'),
);
const usageTab = settings.slice(
  settings.indexOf('<TabsContent value="usage"'),
  settings.indexOf('<TabsContent value="users"'),
);
const partnersTab = settings.slice(
  settings.indexOf('<TabsContent value="partners"'),
  settings.indexOf('<TabsContent value="banking"'),
);

test('Profile tab no longer mounts Partner Code, Plan, or Notification Preferences', () => {
  assert.match(profileTab, /<ProfileSettings/);
  assert.match(profileTab, /<PasskeyManagerCard/);
  assert.match(profileTab, /<TotpManagerCard/);
  assert.doesNotMatch(profileTab, /NotificationPreferencesSettings/);
  assert.doesNotMatch(profileTab, /Partner Code/);
  assert.doesNotMatch(profileTab, /plan_tier/);
  assert.doesNotMatch(settings, /title="Partner Code & Plan"/);
  assert.doesNotMatch(settings, /from "@\/components\/settings\/NotificationPreferencesSettings"/);
});

test('remaining Profile company fields still save the tenant name', () => {
  assert.match(settings, /title="Company Profile"/);
  assert.match(settings, /Company Name/);
  assert.match(settings, /Slug \(URL path\)/);
  assert.match(settings, /\.from\("tenants"\)[\s\S]*\.update\(\{ name \}\)/);
  assert.match(settings, /Save Changes/);
});

test('dedicated Partner Code settings tab is unchanged', () => {
  assert.match(partnersTab, /<TenantPartnerManager/);
  assert.match(partnerManager, /title="Your Partner Code"/);
  assert.match(partnerManager, /from\("tenants"\)[\s\S]*select\("partner_code, name"\)/);
  assert.match(partnerManager, /aws_connect_partner_by_code|lookup_tenant_by_partner_code|normalizedCode/);
});

test('dedicated Plan/Usage settings tab is unchanged', () => {
  assert.match(usageTab, /<TenantUsageTracker/);
  assert.match(usageTab, /<TenantBillingAccountPanel/);
  assert.match(usageTracker, /export function TenantUsageTracker/);
  assert.match(usageTracker, /get_tenant_check_usage/);
  assert.match(billingPanel, /export function TenantBillingAccountPanel/);
  assert.match(billingPanel, /save-tenant-billing-account/);
  assert.doesNotMatch(billingPanel, /writes_disabled/);
});

test('notification preference component and persistence remain available', () => {
  assert.match(notificationPrefs, /get_or_create_notification_preferences/);
  assert.match(notificationPrefs, /from\("notification_preferences"\)/);
  assert.match(notificationPrefs, /in_app_enabled/);
  assert.match(notificationPrefs, /email_enabled/);
  assert.match(notificationPrefs, /sms_enabled/);
});
