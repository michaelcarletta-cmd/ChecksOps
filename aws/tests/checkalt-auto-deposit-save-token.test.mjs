import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const KEY = 'checksops.aws.staging.auth';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const ACTION = 'checkalt.auto_deposit.configure';

const readIdTokenFrom = (storage, sessionKey = KEY) => {
  try {
    if (typeof storage === 'undefined' || !storage) return null;
    const raw = storage.getItem(sessionKey);
    if (!raw) return null;
    const idToken = JSON.parse(raw)?.tokens?.idToken;
    return typeof idToken === 'string' && idToken ? idToken : null;
  } catch {
    return null;
  }
};

const saveSettings = async ({ storage, base = '/prep', enabled = true, maxCents = 200000, fetchImpl }) => {
  const token = readIdTokenFrom(storage);
  if (!base || !token) {
    return { ok: false, status: 401, json: { error: 'not_authenticated' }, fetched: false };
  }
  const response = await fetchImpl('/functions/v1/checkalt-auto-deposit-settings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      tenant_id: FREEDOM,
      auto_deposit_enabled: enabled,
      auto_deposit_max_cents: maxCents,
    }),
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok && json?.ok !== false, status: response.status, json, fetched: true };
};

test('Auto-Deposit settings client reads the same localStorage Cognito session as TOTP', () => {
  const client = read('src/lib/checkaltAutoDeposit.ts');
  const mfa = read('src/lib/awsMfa.ts');
  const orch = read('src/lib/checkaltDepositOrchestrator.ts');
  const staging = read('src/lib/awsStaging.ts');

  assert.match(staging, /export const AWS_STAGING_AUTH_SESSION_KEY = "checksops\.aws\.staging\.auth"/);
  assert.match(mfa, /localStorage\.getItem\(sessionKey\)/);
  assert.match(orch, /localStorage\.getItem\(sessionKey\)/);
  assert.match(orch, /const AWS_SESSION_KEY = "checksops\.aws\.staging\.auth"/);
  assert.match(client, /AWS_STAGING_AUTH_SESSION_KEY/);
  assert.match(client, /if \(typeof localStorage === "undefined"\) return null;/);
  assert.match(client, /const raw = localStorage\.getItem\(AWS_STAGING_AUTH_SESSION_KEY\);/);
  assert.doesNotMatch(client, /sessionStorage/);
});

test('authenticated localStorage session can POST integer-cent settings; missing session fails closed', async () => {
  const client = read('src/lib/checkaltAutoDeposit.ts');
  assert.match(client, /auto_deposit_enabled: input\.enabled/);
  assert.match(client, /auto_deposit_max_cents: input\.maxCents/);

  const memory = new Map();
  const localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, value),
  };
  const sessionOnly = {
    getItem: () => JSON.stringify({ tokens: { idToken: 'session-token-must-not-be-used' } }),
  };

  const missing = await saveSettings({
    storage: localStorage,
    fetchImpl: async () => {
      throw new Error('settings POST must not run without a localStorage session');
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 401);
  assert.equal(missing.json.error, 'not_authenticated');
  assert.equal(missing.fetched, false);

  const sessionStorageIgnored = await saveSettings({
    storage: { getItem: (key) => (key === KEY ? null : sessionOnly.getItem(key)) },
    fetchImpl: async () => {
      throw new Error('sessionStorage-only session must fail closed');
    },
  });
  assert.equal(sessionStorageIgnored.ok, false);
  assert.equal(sessionStorageIgnored.status, 401);
  assert.equal(sessionStorageIgnored.fetched, false);

  localStorage.setItem(KEY, JSON.stringify({
    tokens: { idToken: 'admin-id-token' },
    user: { id: '7dbb3009-f059-4767-b5dc-1c5c72379330' },
  }));

  let posted = null;
  const postedOk = await saveSettings({
    storage: localStorage,
    enabled: true,
    maxCents: 200000,
    fetchImpl: async (path, init) => {
      posted = { path, ...init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          auto_deposit_enabled: true,
          auto_deposit_max_cents: 200000,
          swept: false,
        }),
      };
    },
  });
  assert.equal(postedOk.ok, true);
  assert.equal(postedOk.fetched, true);
  assert.equal(posted.path, '/functions/v1/checkalt-auto-deposit-settings');
  assert.equal(posted.method, 'POST');
  assert.equal(posted.headers.authorization, 'Bearer admin-id-token');
  assert.equal(posted.body.tenant_id, FREEDOM);
  assert.equal(posted.body.auto_deposit_enabled, true);
  assert.equal(posted.body.auto_deposit_max_cents, 200000);
  assert.equal(Number.isInteger(posted.body.auto_deposit_max_cents), true);
  assert.equal(postedOk.json.swept, false);
});

test('staff/operator stay locked; TOTP configure remains required before settings POST; Ready is not swept', () => {
  const settings = read('src/components/settings/CheckAltAutoDepositSettings.tsx');
  const stepUp = read('src/lib/financialStepUp.ts');
  const guard = read('src/hooks/useFinancialGuard.ts');
  const dialog = read('src/components/auth/StepUpDialog.tsx');
  const policy = read('aws/functions/api/providers/production/checkalt-auto-deposit.mjs');

  assert.match(settings, /const canEdit = isTenantOwnerOrAdmin;/);
  assert.match(settings, /Staff and operators\s+cannot edit these settings/);
  assert.match(settings, /await guardFinancial\("checkalt\.auto_deposit\.configure"/);
  assert.match(settings, /saveCheckAltAutoDepositSettings\(/);
  assert.ok(
    settings.indexOf('await guardFinancial("checkalt.auto_deposit.configure"')
      < settings.indexOf('saveCheckAltAutoDepositSettings('),
    'settings POST must run only after financial TOTP',
  );
  assert.match(settings, /if \(result\.json\?\.swept === true\)/);
  assert.match(settings, /must not sweep Ready checks/);

  assert.match(stepUp, /"checkalt\.auto_deposit\.configure"/);
  assert.match(stepUp, /auto_deposit_enabled: request\.autoDepositEnabled === true/);
  assert.match(stepUp, /auto_deposit_max_cents: Number\.isInteger\(request\.autoDepositMaxCents\)/);
  assert.match(guard, /actionKey === "checkalt\.auto_deposit\.configure"/);
  assert.match(dialog, /stepUpAwsTotp\(/);
  assert.match(dialog, /autoDepositMaxCents: request\?\.autoDepositMaxCents/);

  assert.match(policy, /CHECKALT_AUTO_DEPOSIT_CONFIGURE_ACTION = 'checkalt\.auto_deposit\.configure'/);
  assert.match(policy, /AUTO_DEPOSIT_CONFIG_ROLES = new Set\(\['owner', 'admin'\]\)/);
  assert.match(policy, /swept: false/);
  assert.match(policy, /SETTINGS_CHANGE/);
  assert.match(policy, /PREEXISTING_READY/);
  const settingsChange = policy.indexOf('if (trigger === AUTO_DEPOSIT_TRIGGERS.SETTINGS_CHANGE)');
  const readyReturn = policy.indexOf("reason: AUTO_DEPOSIT_REASONS.PREEXISTING_READY");
  assert.ok(settingsChange > 0 && readyReturn > settingsChange, 'settings change must not sweep Ready checks');
});
