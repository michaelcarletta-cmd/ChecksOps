import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { MOOV_ENVIRONMENT_CHANGE_WARNING, SANDBOX_SETUP_REQUIRED } from '../../src/lib/moovEnvironment.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceOf = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('Tenant Management requires confirmation before changing Moov environment', () => {
  assert.match(MOOV_ENVIRONMENT_CHANGE_WARNING, /No money or provider objects are migrated/);
  const control = sourceOf('src/components/payments/MoovEnvironmentControl.tsx');
  const tenants = sourceOf('src/components/settings/TenantManagement.tsx');
  const admin = sourceOf('src/pages/admin/AdminTenants.tsx');
  assert.match(control, /Change Moov environment/);
  assert.match(control, /Sandbox/);
  assert.match(control, /Production/);
  assert.match(tenants, /MoovEnvironmentBadge/);
  assert.match(admin, /MoovEnvironmentControl/);
  assert.doesNotMatch(admin, /moov_environment: isTest/);
});

test('WalletOps and payments surface SANDBOX vs Production without mixing ledgers', () => {
  assert.equal(SANDBOX_SETUP_REQUIRED, 'Sandbox Moov setup required');
  const wallet = sourceOf('src/pages/WalletOps.tsx');
  const funds = sourceOf('src/components/payments/FundsTab.tsx');
  const account = sourceOf('src/components/payments/PaymentAccountPanel.tsx');
  const ops = sourceOf('src/hooks/useWalletOps.ts');
  assert.match(wallet, /MoovEnvironmentBadge/);
  assert.match(funds, /MoovEnvironmentBadge/);
  assert.match(account, /MoovEnvironmentBadge/);
  assert.match(ops, /\.eq\("environment", environment/);
  assert.match(sourceOf('src/lib/payments/wallets.ts'), /\.eq\("environment", environment/);
});
