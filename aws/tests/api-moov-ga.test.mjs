import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { executionAllowed, providerEnabled } from '../functions/api/provider-flags.mjs';
import { loadTenantMoovEnv, requireParityEnabled } from '../functions/api/providers/parity/caller.mjs';
import { evaluateReadiness } from '../functions/api/providers/readiness.mjs';
import {
  shouldPromoteExistingTenantToProduction,
  tenantMoovDefaults,
} from '../functions/api/tenant-moov-defaults.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';

const withEnv = async (vars, fn) => {
  const prev = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('AWS_MOOV_ENABLED is a money-movement safety hold, not a tenant allowlist', async () => {
  await withEnv({
    AWS_MOOV_ENABLED: 'false',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  }, () => {
    assert.equal(providerEnabled('moov'), false);
    assert.equal(executionAllowed('moov'), false);
  });
  await withEnv({
    AWS_MOOV_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  }, async () => {
    assert.equal(providerEnabled('moov'), true);
    assert.equal(executionAllowed('moov'), true);
    const blocked = await requireParityEnabled('moov');
    assert.equal(blocked.error, 'production_execution_blocked');
    assert.equal(blocked.statusCode, 403);
  });
});

test('C1C and any other tenant resolve Moov env without moov_allowlisted', async () => {
  const client = {
    query: async (sql, params) => {
      assert.match(sql, /SELECT moov_environment FROM public.tenants/);
      assert.equal(params[0], C1C);
      return { rows: [{ moov_environment: 'production' }] };
    },
  };
  assert.equal(await loadTenantMoovEnv(client, C1C), 'production');
});

test('new live tenants receive production Moov defaults; test tenants stay sandbox', () => {
  assert.deepEqual(tenantMoovDefaults(), {
    payment_provider: 'moov',
    moov_allowlisted: true,
    moov_environment: 'production',
  });
  assert.deepEqual(tenantMoovDefaults({ isTestAccount: true }), {
    payment_provider: 'moov',
    moov_allowlisted: true,
    moov_environment: 'sandbox',
  });
});

test('existing live tenants without a Moov account are promoted; mid-onboarding is preserved', () => {
  assert.equal(shouldPromoteExistingTenantToProduction({
    is_test_account: false,
    moov_environment: 'sandbox',
    has_moov_account: false,
  }), true);
  assert.equal(shouldPromoteExistingTenantToProduction({
    is_test_account: false,
    moov_environment: 'sandbox',
    has_moov_account: true,
  }), false);
  assert.equal(shouldPromoteExistingTenantToProduction({
    is_test_account: true,
    moov_environment: 'sandbox',
    has_moov_account: false,
  }), false);
});

test('readiness still blocks money movement without ToS, KYB, bank, or send-funds', () => {
  const ready = {
    environment: 'production',
    accountId: 'acct_existing',
    capabilities: [
      { capability: 'send-funds.ach', status: 'enabled' },
      { capability: 'collect-funds.ach', status: 'enabled' },
      { capability: 'wallet.balance', status: 'enabled' },
      { capability: 'transfers', status: 'enabled' },
    ],
    banks: [{ status: 'verified' }],
    verificationStatus: 'verified',
    termsAccepted: true,
    feePlanCode: 'standard',
  };
  assert.equal(evaluateReadiness({ ...ready, termsAccepted: false }).canMoveMoney, false);
  assert.equal(evaluateReadiness({ ...ready, verificationStatus: 'pending' }).canMoveMoney, false);
  assert.equal(evaluateReadiness({ ...ready, banks: [{ status: 'pending' }] }).canMoveMoney, false);
  assert.equal(evaluateReadiness({
    ...ready,
    capabilities: [{ capability: 'wallet.balance', status: 'enabled' }],
  }).canMoveMoney, false);
  const ok = evaluateReadiness(ready);
  assert.equal(ok.canMoveMoney, true);
  assert.equal(ok.checks.find((c) => c.id === 'terms_of_service')?.state, 'ready');
  assert.equal(ok.checks.find((c) => c.id === 'identity_verification')?.state, 'ready');
  assert.equal(ok.checks.find((c) => c.id === 'bank_verified')?.state, 'ready');
  assert.equal(ok.checks.find((c) => c.id === 'send_funds_ach')?.state, 'ready');
});

test('AWS SQL backfill and insert trigger do not consult Freedom or CheckAlt', () => {
  const sql = readFileSync(path.join(ROOT, 'rls/sql/42_moov_generally_available.sql'), 'utf8');
  assert.match(sql, /SET moov_allowlisted = true/);
  assert.match(sql, /payment_provider = 'moov'/);
  assert.match(sql, /moov_environment SET DEFAULT 'production'/);
  assert.match(sql, /apply_tenant_moov_ga_defaults/);
  assert.match(sql, /BEFORE INSERT ON public\.tenants/);
  assert.match(sql, /payment_provider_accounts/);
  assert.doesNotMatch(sql, /slug = 'freedom'/);
  assert.doesNotMatch(sql, /UPDATE public\.checkalt/i);
  assert.doesNotMatch(sql, /ALTER TABLE public\.checkalt/i);
});

test('AWS Moov caller and ingest paths no longer consult moov_allowlisted', () => {
  const files = [
    'functions/api/providers/parity/caller.mjs',
    'functions/api/providers/parity/moov-functions.mjs',
    'functions/api/tenant-moov-defaults.mjs',
    'functions/api/ingest-shared-check.mjs',
  ];
  for (const rel of files) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    if (rel.endsWith('tenant-moov-defaults.mjs') || rel.endsWith('ingest-shared-check.mjs')) {
      assert.match(src, /payment_provider/);
      continue;
    }
    assert.doesNotMatch(src, /moov_allowlisted/, rel);
    assert.doesNotMatch(src, /not enabled for this payment provider/, rel);
  }
});
