import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { productionCheckAltExecutionAllowed } from '../functions/api/providers/production/checkalt-holds.mjs';
import {
  LEGACY_CHECKALT_MONEY_DISABLED_ERROR,
  legacyCheckAltMoneyShutdownResponse,
} from '../../supabase/functions/_shared/legacy-checkalt-money-shutdown.ts';
import {
  awsCheckAltMoneyPathReady,
  awsCheckAltMoneyRequestUrl,
  invokeAwsCheckAltMoneyFunction,
  isLegacyCheckAltMoneyFunction,
  LEGACY_CHECKALT_MONEY_BLOCKED,
  requireAwsCheckAltMoneyPath,
} from '../../src/lib/awsCheckAltMoneyPath.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceOf = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const FORBIDDEN_PROVIDER = [
  'checkAltFetch',
  'getUserAccountInfo',
  'CHECKALT_USERNAME',
  'CHECKALT_PASSWORD',
  'cached_jwt',
  '/fincapture/deposit/process',
  '/fincapture/deposit/approve',
  'fincapture/authenticate',
];

const jwtEvent = (pathName, body) => ({
  rawPath: pathName,
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: pathName },
    authorizer: {
      jwt: { claims: { sub: 'c4386408-60e1-70e2-abb6-e6194e8e635f', email: 'owner@freedomadj.com', token_use: 'id' } },
    },
  },
});

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('legacy submit and approve fail closed before any CheckAlt HTTP', () => {
  for (const name of ['checkalt-submit-deposit', 'checkalt-approve-deposit']) {
    const out = legacyCheckAltMoneyShutdownResponse({ method: 'POST' });
    assert.equal(out.status, 403);
    assert.equal(out.providerHttp, false);
    assert.equal(out.authenticatedToCheckAlt, false);
    const body = JSON.parse(out.body);
    assert.equal(body.error, LEGACY_CHECKALT_MONEY_DISABLED_ERROR);
    assert.equal(body.provider_http, false);
    assert.equal(body.authenticated_to_checkalt, false);
    assert.equal(isLegacyCheckAltMoneyFunction(name), true);
  }
  const preflight = legacyCheckAltMoneyShutdownResponse({ method: 'OPTIONS' });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.providerHttp, false);
});

test('legacy function sources cannot authenticate or call CheckAlt', () => {
  const files = [
    'supabase/functions/checkalt-submit-deposit/index.ts',
    'supabase/functions/checkalt-approve-deposit/index.ts',
    'supabase/functions/_shared/legacy-checkalt-money-shutdown.ts',
  ];
  for (const rel of files) {
    const source = sourceOf(rel);
    for (const token of FORBIDDEN_PROVIDER) {
      assert.equal(source.includes(token), false, `${rel} must not contain ${token}`);
    }
    assert.doesNotMatch(source, /Deno\.env\.get\(/);
    assert.doesNotMatch(source, /from ["'].*checkalt\.ts["']/);
    assert.doesNotMatch(source, /auto_approve_enabled/);
  }
  assert.match(sourceOf('supabase/functions/checkalt-submit-deposit/index.ts'), /legacyCheckAltMoneyShutdownResponse/);
  assert.match(sourceOf('supabase/functions/checkalt-approve-deposit/index.ts'), /legacyCheckAltMoneyShutdownResponse/);
});

test('production SPA cannot reach legacy Lovable money movement', async () => {
  assert.equal(
    awsCheckAltMoneyRequestUrl('https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1', 'checkalt-submit-deposit'),
    null,
  );
  assert.equal(
    awsCheckAltMoneyRequestUrl('https://example.lovable.app', 'checkalt-approve-deposit'),
    null,
  );
  assert.equal(awsCheckAltMoneyRequestUrl('/prep', 'checkalt-poll-status'), null);
  assert.equal(
    awsCheckAltMoneyRequestUrl('/prep', 'checkalt-submit-deposit'),
    '/prep/functions/v1/checkalt-submit-deposit',
  );

  let fetches = 0;
  const blocked = await invokeAwsCheckAltMoneyFunction(
    'checkalt-submit-deposit',
    { body: { check_intake_item_id: '623442f0-a408-4db5-85be-14bae231a722' } },
    {
      authProvider: 'supabase',
      apiBaseUrl: 'https://nbcqwpysqgyxrrbgtmkw.supabase.co',
      idToken: 'test-token',
      fetchImpl: async () => {
        fetches += 1;
        throw new Error('must not fetch legacy');
      },
    },
  );
  assert.equal(blocked.error?.message, LEGACY_CHECKALT_MONEY_BLOCKED);
  assert.equal(blocked.providerHttp, false);
  assert.equal(fetches, 0);

  assert.throws(
    () => requireAwsCheckAltMoneyPath({
      authProvider: 'cognito',
      apiBaseUrl: 'https://nbcqwpysqgyxrrbgtmkw.supabase.co',
      functionName: 'checkalt-approve-deposit',
    }),
    /legacy_checkalt_money_path_blocked/,
  );

  const awsDenied = awsCheckAltMoneyPathReady({
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    functionName: 'checkalt-submit-deposit',
  });
  assert.equal(awsDenied.ok, true);

  const called = [];
  const awsResult = await invokeAwsCheckAltMoneyFunction(
    'checkalt-approve-deposit',
    { body: { deposit_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action: 'approve' } },
    {
      authProvider: 'cognito',
      apiBaseUrl: '/prep',
      idToken: 'test-token',
      fetchImpl: async (url) => {
        called.push(String(url));
        return {
          ok: false,
          json: async () => ({ error: 'provider_disabled' }),
        };
      },
    },
  );
  assert.deepEqual(called, ['/prep/functions/v1/checkalt-approve-deposit']);
  assert.equal(awsResult.error?.message, 'provider_disabled');
  assert.equal(awsResult.providerHttp, false);
});

test('production UI sources no longer invoke legacy CheckAlt money functions', () => {
  const files = [
    'src/pages/CheckCommandCenter.tsx',
    'src/components/deposit-ops/DepositOperationsConsole.tsx',
    'src/components/settings/CheckAltSettings.tsx',
    'src/integrations/aws/client.ts',
  ];
  for (const rel of files) {
    const source = sourceOf(rel);
    assert.doesNotMatch(source, /functions\.invoke\(\s*["']checkalt-submit-deposit["']/);
    assert.doesNotMatch(source, /functions\.invoke\(\s*["']checkalt-approve-deposit["']/);
    assert.match(source, /invokeAwsCheckAltMoneyFunction|isLegacyCheckAltMoneyFunction/);
  }
  assert.match(sourceOf('src/pages/CheckCommandCenter.tsx'), /requireAwsCheckAltMoneyPath/);
  assert.match(sourceOf('src/components/deposit-ops/DepositOperationsConsole.tsx'), /requireAwsCheckAltMoneyPath/);
  assert.match(sourceOf('src/components/settings/CheckAltSettings.tsx'), /requireAwsCheckAltMoneyPath/);
});

test('AWS disabled path remains 403 provider_disabled and financial auth stays server-side', async () => {
  await withEnv({
    AWS_CHECKALT_ENABLED: 'false',
    AWS_MOOV_ENABLED: 'false',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false',
    PROVIDER_SECRETS_ARN: undefined,
  }, async () => {
    assert.equal(productionCheckAltExecutionAllowed(), false);
    for (const pathName of [
      '/functions/v1/checkalt-submit-deposit',
      '/functions/v1/checkalt-approve-deposit',
    ]) {
      const result = await handler(jwtEvent(pathName, { check_intake_item_id: '44444444-4444-4444-8444-444444444444' }));
      const body = JSON.parse(result.body);
      assert.equal(result.statusCode, 403);
      assert.ok(['provider_disabled', 'production_execution_blocked'].includes(body.error), pathName);
      assert.notEqual(body.error, LEGACY_CHECKALT_MONEY_DISABLED_ERROR);
    }
  });

  const authz = sourceOf('aws/functions/api/providers/production/checkalt-authz.mjs');
  const mfa = sourceOf('aws/functions/api/auth-mfa.mjs');
  assert.match(authz, /financial_stepup_log/);
  assert.match(mfa, /INSERT INTO public\.financial_stepup_log/);
  assert.match(mfa, /factor_type, succeeded, metadata/);
  assert.doesNotMatch(mfa, /checkAltFetch/);
});

test('shutdown sources and runbook do not leak provider credentials', () => {
  const files = [
    'src/lib/awsCheckAltMoneyPath.ts',
    'supabase/functions/_shared/legacy-checkalt-money-shutdown.ts',
    'supabase/functions/checkalt-submit-deposit/index.ts',
    'supabase/functions/checkalt-approve-deposit/index.ts',
    'aws/financial/LEGACY_CHECKALT_MONEY_SHUTDOWN.md',
  ];
  for (const rel of files) {
    const source = sourceOf(rel);
    assert.doesNotMatch(source, /CHECKALT_PASSWORD\s*[:=]\s*['"][^'"]+['"]/);
    assert.doesNotMatch(source, /CHECKALT_USERNAME\s*[:=]\s*['"][^'"]+['"]/);
    assert.doesNotMatch(source, /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/);
    assert.doesNotMatch(source, /cached_jwt["']?\s*[:=]\s*['"]ey/);
  }
  const runbook = sourceOf('aws/financial/LEGACY_CHECKALT_MONEY_SHUTDOWN.md');
  assert.match(runbook, /CHECKALT_USERNAME/);
  assert.match(runbook, /CHECKALT_PASSWORD/);
  assert.match(runbook, /cached_jwt/);
  assert.match(runbook, /Do not create/);
});
