import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  FINANCIAL_TOTP_ONLY_COPY,
  FINANCIAL_TOTP_ONLY_FORBIDDEN,
  FINANCIAL_TOTP_ONLY_OPERATION,
  canShowFinancialTotpOnlyTestCard,
  collectFinancialTotpOnlyRoles,
  isExistingCheckId,
  roleMayRunFinancialTotpOnlyTest,
  runFinancialTotpOnlyVerification,
} from '../../src/lib/financialTotpOnlyTest.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = '623442f0-a408-4db5-85be-14bae231a722';
const OTHER_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const FREEDOM_ADMIN = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FREEDOM_TESTER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';

const sourceOf = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const assertStopped = (value) => {
  assert.equal(value.continued, false);
  assert.deepEqual([...value.invoked], []);
  assert.equal(value.providerHttp, false);
  assert.equal(value.mutated.check, false);
  assert.equal(value.mutated.stage, false);
  assert.equal(value.mutated.checkalt_deposits, false);
};

test('copy makes the non-financial stop obvious', () => {
  assert.equal(
    FINANCIAL_TOTP_ONLY_COPY,
    'Verify financial TOTP only — no deposit will be submitted.',
  );
  assert.equal(FINANCIAL_TOTP_ONLY_OPERATION, 'deposit.submit');
});

test('only owner/admin/manager may start the TOTP-only path', () => {
  assert.equal(roleMayRunFinancialTotpOnlyTest('admin'), true);
  assert.equal(roleMayRunFinancialTotpOnlyTest(['owner']), true);
  assert.equal(roleMayRunFinancialTotpOnlyTest(['staff', 'manager']), true);
  assert.equal(roleMayRunFinancialTotpOnlyTest('staff'), false);
  assert.equal(roleMayRunFinancialTotpOnlyTest('operator'), false);
  assert.equal(roleMayRunFinancialTotpOnlyTest(['operator', 'staff']), false);
  assert.equal(roleMayRunFinancialTotpOnlyTest(null), false);
  assert.equal(roleMayRunFinancialTotpOnlyTest([{ role: 'admin' }]), true);
  assert.deepEqual(
    collectFinancialTotpOnlyRoles('staff', { roles: ['admin'], tenant_roles: ['admin'] }),
    ['staff', 'admin'],
  );
});

test('Freedom admin sees the Financial TOTP test card from user_roles or tenant membership', () => {
  assert.equal(
    canShowFinancialTotpOnlyTestCard({
      awsMfaAvailable: true,
      userId: FREEDOM_ADMIN,
      roles: 'admin',
    }),
    true,
  );
  assert.equal(
    canShowFinancialTotpOnlyTestCard({
      awsMfaAvailable: true,
      userId: FREEDOM_ADMIN,
      roles: [{ role: 'admin', tenant_id: FREEDOM_TENANT }],
    }),
    true,
  );
  assert.equal(
    canShowFinancialTotpOnlyTestCard({
      awsMfaAvailable: true,
      userId: FREEDOM_ADMIN,
      roles: { roles: [], tenant_roles: ['admin'] },
    }),
    true,
  );
});

test('operator/staff do not see the Financial TOTP test card', () => {
  assert.equal(
    canShowFinancialTotpOnlyTestCard({
      awsMfaAvailable: true,
      userId: FREEDOM_TESTER,
      roles: ['operator', 'staff'],
    }),
    false,
  );
  assert.equal(
    canShowFinancialTotpOnlyTestCard({
      awsMfaAvailable: true,
      userId: FREEDOM_TESTER,
      roles: [{ role: 'operator' }, { role: 'staff' }],
    }),
    false,
  );
  assert.equal(
    canShowFinancialTotpOnlyTestCard({
      awsMfaAvailable: true,
      userId: FREEDOM_ADMIN,
      roles: null,
    }),
    false,
  );
  assert.equal(
    canShowFinancialTotpOnlyTestCard({
      awsMfaAvailable: false,
      userId: FREEDOM_ADMIN,
      roles: 'admin',
    }),
    false,
  );
});

test('requires an existing check UUID and ignores browser tenant/amount', async () => {
  assert.equal(isExistingCheckId(CHECK), true);
  assert.equal(isExistingCheckId('not-a-check'), false);

  const missing = await runFinancialTotpOnlyVerification({
    roles: 'admin',
    checkId: '',
    requireStepUp: async () => {
      throw new Error('step-up must not run without a check');
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'existing_check_required');
  assertStopped(missing);

  const calls = [];
  const built = await runFinancialTotpOnlyVerification({
    roles: 'admin',
    checkId: CHECK,
    browserTenantId: OTHER_TENANT,
    browserAmount: 1.23,
    browserAmountCents: 1,
    requireStepUp: async (request) => {
      calls.push(request);
      return true;
    },
  });
  assert.equal(built.ok, true);
  assert.equal(built.outcome.authorized, true);
  assert.equal(built.outcome.operation, 'deposit.submit');
  assert.equal(built.outcome.checkId, CHECK);
  assert.equal(built.outcome.ignored.browserAmount, true);
  assert.equal(built.outcome.ignored.browserAmountCents, true);
  assert.equal(built.outcome.ignored.browserTenantNotAuthoritative, true);
  assert.equal(built.outcome.stepUpBody.action_key, 'deposit.submit');
  assert.equal(built.outcome.stepUpBody.check_intake_item_id, CHECK);
  assert.equal(Object.prototype.hasOwnProperty.call(built.outcome.stepUpBody, 'amount'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(built.outcome.stepUpBody, 'amount_cents'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actionKey, 'deposit.submit');
  assert.equal(calls[0].checkId, CHECK);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0], 'amount'), false);
  assertStopped(built.outcome);
});

test('successful step-up does not continue into any provider or deposit workflow', async () => {
  const invoked = [];
  const requireStepUp = async () => {
    invoked.push('auth/mfa/step-up');
    return true;
  };
  const result = await runFinancialTotpOnlyVerification({
    roles: 'owner',
    checkId: CHECK,
    requireStepUp,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome.authorized, true);
  assertStopped(result.outcome);
  assert.deepEqual(invoked, ['auth/mfa/step-up']);
  for (const name of FINANCIAL_TOTP_ONLY_FORBIDDEN) {
    assert.equal(invoked.includes(name), false, `must not invoke ${name}`);
  }
});

test('failed or cancelled step-up also stays stopped', async () => {
  const result = await runFinancialTotpOnlyVerification({
    roles: 'admin',
    checkId: CHECK,
    requireStepUp: async () => false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome.authorized, false);
  assertStopped(result.outcome);
});

test('staff cannot use the runner even if step-up would succeed', async () => {
  const result = await runFinancialTotpOnlyVerification({
    roles: 'staff',
    checkId: CHECK,
    requireStepUp: async () => {
      throw new Error('staff must not reach step-up');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'financial_role_required');
  assertStopped(result);
});

test('TOTP-only UI and runner sources never invoke deposit or provider workflows', () => {
  const runner = sourceOf('src/lib/financialTotpOnlyTest.ts');
  const card = sourceOf('src/components/auth/FinancialTotpOnlyTestCard.tsx');
  const page = sourceOf('src/pages/AccountSecurity.tsx');
  const settings = sourceOf('src/components/white-label/WhiteLabelSettings.tsx');

  for (const [name, source] of [
    ['runner', runner],
    ['card', card],
    ['page', page],
    ['settings', settings],
  ]) {
    assert.equal(source.includes('supabase.functions.invoke'), false, `${name} must not invoke edge functions`);
    assert.doesNotMatch(source, /functions\.invoke\(/);
    assert.doesNotMatch(source, /deposit_action/);
    assert.doesNotMatch(source, /checkAltFetch/);
    assert.doesNotMatch(source, /from\("check_intake_items"\)/);
    assert.doesNotMatch(source, /from\("checkalt_deposits"\)/);
  }

  assert.match(runner, /requireStepUp/);
  assert.doesNotMatch(runner, /fetch\(/);
  for (const name of FINANCIAL_TOTP_ONLY_FORBIDDEN) {
    assert.match(runner, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(runner, /Verify financial TOTP only — no deposit will be submitted\./);
  assert.match(card, /FINANCIAL_TOTP_ONLY_COPY/);
  assert.match(card, /runFinancialTotpOnlyVerification/);
  assert.match(card, /canShowFinancialTotpOnlyTestCard/);
  assert.match(card, /from\("tenant_users"\)/);
});

test('FinancialTotpOnlyTestCard is actually mounted on Account Security and Settings', () => {
  const page = sourceOf('src/pages/AccountSecurity.tsx');
  const settings = sourceOf('src/components/white-label/WhiteLabelSettings.tsx');
  const client = sourceOf('src/integrations/aws/client.ts');

  assert.match(page, /<TotpManagerCard \/>\s*<FinancialTotpOnlyTestCard \/>/);
  assert.match(settings, /<TotpManagerCard \/>\s*<FinancialTotpOnlyTestCard \/>/);
  assert.match(page, /<FinancialTotpOnlyTestCard\s*\/>/);
  assert.match(settings, /<FinancialTotpOnlyTestCard\s*\/>/);
  assert.match(client, /tenant_roles/);
  assert.match(client, /identity\.roles/);
});
