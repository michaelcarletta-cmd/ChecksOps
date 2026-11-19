/**
 * The Settings "ACH Debit Authorization" card (owner report 2026-11-19: "Sign & Authorize ACH" failed with
 * writes_disabled). It reads, signs and revokes through the API route save-ach-authorization; the browser
 * never writes ach_authorizations (a server-only money table) and shows the server's agreement text.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const FORM = read('src/components/disbursement/AchAuthorizationForm.tsx');

test('the card calls save-ach-authorization for get, authorize and revoke, and never writes the table', () => {
  assert.match(FORM, /supabase\.functions\.invoke\("save-ach-authorization", \{\s*body: \{ tenant_id: tenantId, stakeholder_account_id: stakeholderAccountId, action \}/);
  for (const action of ['get', 'authorize', 'revoke']) assert.match(FORM, new RegExp(`call\\("${action}"\\)`), action);
  assert.doesNotMatch(FORM, /\.from\("ach_authorizations"\)/);
  assert.doesNotMatch(FORM, /\.insert\(|\.update\(/);
  assert.doesNotMatch(FORM, /ip_address|user_agent|authorized_by/);
});

test('the signed text and the last four are the server\'s; nothing shows an empty account number', () => {
  assert.match(FORM, /const last4 = reply\?\.account_last4 \|\| accountLast4 \|\| null;/);
  assert.match(FORM, /const formText = reply\?\.form_text/);
  assert.match(FORM, /"\{formText\}"/);
  assert.match(FORM, /\{last4 \? ` \(••••\$\{last4\}\)` : ""\}/);
  assert.doesNotMatch(FORM, /••••\{accountLast4\}|ending in \{accountLast4\}/);
});

test('the AWS client still refuses the table in the browser', () => {
  const client = read('src/integrations/aws/client.ts');
  const allow = client.slice(client.indexOf('AWS_WRITE_TABLES'), client.indexOf(']', client.indexOf('AWS_WRITE_TABLES')));
  assert.doesNotMatch(allow, /ach_authorizations/);
});
