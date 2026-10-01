import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  patchMoovClient,
  patchMoovFunctions,
  patchMoovOnboard,
} from '../../scripts/deployment-guard/build-moov-granular-capabilities-overlay.mjs';

const LEGACY = "['transfers', 'send-funds', 'wallet', 'send-funds.ach']";
const GRANULAR = "['transfers', 'collect-funds.ach', 'send-funds.ach', 'wallet.balance']";

test('functions patch replaces merchant IDs and requests missing granular caps', () => {
  const src = `
    const created = await moovFetch('/accounts', {
      method: 'POST',
      scopes: scopes.accountsWrite(),
      idempotencyKey,
      fetchImpl,
      body: {
        capabilities: ${LEGACY},
      },
    });
    const flags = capabilityFlags(caps);
    const verification = remote?.profile?.business?.verification?.status ?? remote?.verification?.status ?? null;
    const onboarding = normalizeOnboardingStatus({ verificationStatus: verification });
  `;
  const next = patchMoovFunctions(src);
  assert.match(next, new RegExp(GRANULAR.replace(/[[\]]/g, '\\$&')));
  assert.doesNotMatch(next, /'send-funds', 'wallet'/);
  assert.match(next, /apiVersion: 'v2025\.07\.00'/);
  assert.match(next, /body: \{ capabilities: missing \}/);
});

test('onboard patch requests granular IDs on capability POST and hosted invite', () => {
  const src = `
    await moovFetch(\`/accounts/\${accountId}/capabilities\`, {
      method: 'POST', scopes: scopes.capabilitiesWrite(accountId),
      body: { capabilities: ${LEGACY} }, fetchImpl,
    }).catch(() => {});
    const invite = await moovFetch(\`/accounts/\${accountId}/onboarding-invites\`, {
      method: 'POST', scopes: scopes.accountWrite(accountId), fetchImpl,
      body: {
        returnURL: redirect,
        ...(feePlanCodes.length ? { feePlanCodes } : {}),
      },
    }).catch(async (e) => {
      const alt = await moovFetch(\`/accounts/\${platformId}/onboarding-invites\`, {
        method: 'POST', scopes: scopes.accountWrite(platformId), fetchImpl,
        body: { accountID: accountId, returnURL: redirect, ...(feePlanCodes.length ? { feePlanCodes } : {}) },
      }).catch(() => { throw e; });
      return alt;
    });
  `;
  const next = patchMoovOnboard(src);
  assert.match(next, /collect-funds\.ach/);
  assert.doesNotMatch(next, /'send-funds', 'wallet'/);
  assert.match(next, /capabilities: \['transfers', 'collect-funds\.ach'/);
});

test('client flags treat send-funds.ach as ACH credit', () => {
  const src = `export function capabilityFlags(caps) {
  const byName = new Map((caps ?? []).map((c) => [c.capability, c.status]));
  const on = (name) => byName.get(name) === 'enabled';
  return {
    can_receive_payments: on('transfers') || on('collect-funds'),
    can_send_payments: on('transfers') || on('send-funds'),
    can_ach_debit: on('collect-funds'),
    can_ach_credit: on('send-funds'),
    restricted: false,
  };
}`;
  const next = patchMoovClient(src);
  assert.match(next, /name.startsWith\(target \+ '\.'\)/);
  assert.doesNotMatch(next, /byName.get\(name\) === 'enabled'/);
});
