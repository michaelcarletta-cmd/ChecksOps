/**
 * Owner 2026-11-25: "Yes remove the old broken add account button".
 * TenantBankAccountSettings (Payments -> Settings and Settings -> Bank Account/Stakeholders) had an
 * "Add account" button that inserted a placeholder stakeholder_accounts row. The API write allowlist
 * permits only `update` on stakeholder_accounts, so it always failed with operation_not_allowlisted.
 * The org's own bank is linked through Moov in Settings -> Compliance & Docs -> Bank ("Add bank account").
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const src = readFileSync(new URL('../../src/components/settings/TenantBankAccountSettings.tsx', import.meta.url), 'utf8');
const allowlist = readFileSync(new URL('../functions/api/write-allowlist.mjs', import.meta.url), 'utf8');

test('the legacy Add account button and its stakeholder_accounts insert are gone', () => {
  assert.doesNotMatch(src, /\.insert\(/);
  assert.doesNotMatch(src, /addAccount/);
  assert.doesNotMatch(src, />\s*Add account\s*</);
});

test('the card points to the working Moov path in Compliance & Docs', () => {
  assert.match(src, /Compliance &amp; Docs → Bank/);
  assert.match(src, /Add bank account/);
});

test('stakeholder_accounts is still update-only, so no insert path can come back unnoticed', () => {
  const block = allowlist.slice(allowlist.indexOf('stakeholder_accounts'));
  assert.match(block.slice(0, 200), /ops:\s*new Set\(\['update'\]\)/);
});
