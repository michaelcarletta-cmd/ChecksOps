import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { productionCheckAltExecutionAllowed } from '../functions/api/providers/production/checkalt-holds.mjs';
import {
  LEGACY_CHECKALT_PROVIDER_DISABLED_ERROR,
  legacyCheckAltMoneyShutdownResponse,
} from '../../supabase/functions/_shared/legacy-checkalt-money-shutdown.ts';
import {
  CHECKALT_PROVIDER_UNAVAILABLE,
  awsCheckAltProviderPathReady,
  awsCheckAltProviderRequestUrl,
  checkAltProviderUserMessage,
  invokeAwsCheckAltProviderFunction,
  isLegacyCheckAltProviderFunction,
  LEGACY_CHECKALT_PROVIDER_BLOCKED,
  LEGACY_CHECKALT_PROVIDER_FUNCTIONS,
  requireAwsCheckAltProviderPath,
  runCheckAltOneClickSubmit,
} from '../../src/lib/awsCheckAltMoneyPath.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceOf = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const NEUTRALIZED = [
  'checkalt-submit-deposit',
  'checkalt-approve-deposit',
  'checkalt-poll-status',
  'checkalt-test-connection',
  'checkalt-register-account',
  'checkalt-verify-account',
  'checkalt-account-status',
  'checkalt-deposit-history',
];

const FORBIDDEN_PROVIDER = [
  'checkAltFetch',
  'getUserAccountInfo',
  'getCheckAltJwt',
  'CHECKALT_USERNAME',
  'CHECKALT_PASSWORD',
  'cached_jwt',
  'cached_jwt_expires_at',
  '/fincapture/',
  'fincapture/authenticate',
  'useraccount/register',
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

test('all eight neutralized functions fail closed before any CheckAlt HTTP', () => {
  assert.deepEqual([...LEGACY_CHECKALT_PROVIDER_FUNCTIONS], NEUTRALIZED);
  for (const name of NEUTRALIZED) {
    const out = legacyCheckAltMoneyShutdownResponse({ method: 'POST' });
    assert.equal(out.status, 403);
    assert.equal(out.providerHttp, false);
    assert.equal(out.authenticatedToCheckAlt, false);
    const body = JSON.parse(out.body);
    assert.equal(body.error, LEGACY_CHECKALT_PROVIDER_DISABLED_ERROR);
    assert.equal(body.provider_http, false);
    assert.equal(isLegacyCheckAltProviderFunction(name), true);
  }
});

test('each neutralized function source cannot authenticate or call CheckAlt', () => {
  const files = [
    'supabase/functions/_shared/legacy-checkalt-money-shutdown.ts',
    ...NEUTRALIZED.map((name) => `supabase/functions/${name}/index.ts`),
  ];
  for (const rel of files) {
    const source = sourceOf(rel);
    for (const token of FORBIDDEN_PROVIDER) {
      assert.equal(source.includes(token), false, `${rel} must not contain ${token}`);
    }
    assert.doesNotMatch(source, /Deno\.env\.get\(/);
    assert.doesNotMatch(source, /from ["'].*checkalt\.ts["']/);
    assert.doesNotMatch(source, /auto_approve_enabled/);
    assert.doesNotMatch(source, /from\("checkalt_deposits"\)/);
    assert.doesNotMatch(source, /from\("check_intake_items"\)/);
  }
  for (const name of NEUTRALIZED) {
    assert.match(
      sourceOf(`supabase/functions/${name}/index.ts`),
      /legacyCheckAltMoneyShutdownResponse/,
    );
  }
});

test('register and poll/account-status cannot mutate provider or deposit state', () => {
  for (const name of ['checkalt-register-account', 'checkalt-poll-status', 'checkalt-account-status']) {
    const source = sourceOf(`supabase/functions/${name}/index.ts`);
    assert.doesNotMatch(source, /\.upsert\(/);
    assert.doesNotMatch(source, /\.update\(/);
    assert.doesNotMatch(source, /useraccount\/register/);
    assert.doesNotMatch(source, /record_check_return/);
    assert.doesNotMatch(source, /from\("checkalt_tenant_accounts"\)/);
    assert.doesNotMatch(source, /from\("checkalt_deposits"\)/);
  }
});

test('production SPA cannot reach Lovable/Supabase CheckAlt hosts', async () => {
  for (const name of NEUTRALIZED) {
    assert.equal(
      awsCheckAltProviderRequestUrl('https://nbcqwpysqgyxrrbgtmkw.supabase.co', name),
      null,
      name,
    );
    assert.equal(awsCheckAltProviderRequestUrl('https://example.lovable.app', name), null, name);
    assert.equal(
      awsCheckAltProviderRequestUrl('/prep', name),
      `/prep/functions/v1/${name}`,
      name,
    );
  }
  assert.equal(awsCheckAltProviderRequestUrl('/prep', 'checkalt-prepare-image'), null);

  let fetches = 0;
  const blocked = await invokeAwsCheckAltProviderFunction(
    'checkalt-poll-status',
    { body: {} },
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
  assert.equal(blocked.error?.message, LEGACY_CHECKALT_PROVIDER_BLOCKED);
  assert.equal(blocked.providerHttp, false);
  assert.equal(fetches, 0);

  assert.throws(
    () => requireAwsCheckAltProviderPath({
      authProvider: 'cognito',
      apiBaseUrl: 'https://nbcqwpysqgyxrrbgtmkw.supabase.co',
      functionName: 'checkalt-register-account',
    }),
    /legacy_checkalt_provider_path_blocked/,
  );

  const called = [];
  const awsResult = await invokeAwsCheckAltProviderFunction(
    'checkalt-deposit-history',
    { body: {} },
    {
      authProvider: 'cognito',
      apiBaseUrl: '/prep',
      idToken: 'test-token',
      fetchImpl: async (url) => {
        called.push(String(url));
        return { ok: false, json: async () => ({ error: 'provider_disabled' }) };
      },
    },
  );
  assert.deepEqual(called, ['/prep/functions/v1/checkalt-deposit-history']);
  assert.equal(awsResult.error?.message, 'provider_disabled');
  assert.equal(checkAltProviderUserMessage(awsResult.error), CHECKALT_PROVIDER_UNAVAILABLE);
});

test('production UI sources no longer invoke legacy CheckAlt provider functions', () => {
  const files = [
    'src/pages/CheckCommandCenter.tsx',
    'src/components/deposit-ops/DepositOperationsConsole.tsx',
    'src/components/settings/CheckAltSettings.tsx',
    'src/components/settings/CheckAltTenantAccountCard.tsx',
    'src/integrations/aws/client.ts',
  ];
  for (const rel of files) {
    const source = sourceOf(rel);
    for (const name of NEUTRALIZED) {
      assert.doesNotMatch(source, new RegExp(`functions\\.invoke\\(\\s*["']${name}["']`));
    }
  }
  const settings = sourceOf('src/components/settings/CheckAltSettings.tsx');
  assert.match(settings, /invokeAwsCheckAltProviderFunction/);
  assert.match(settings, /checkalt-poll-status/);
  assert.match(settings, /checkalt-test-connection/);
  assert.match(settings, /checkalt-deposit-history/);
  assert.match(settings, /CHECKALT_PROVIDER_UNAVAILABLE|checkAltProviderUserMessage/);
  const tenantAccount = sourceOf('src/components/settings/CheckAltTenantAccountCard.tsx');
  assert.match(tenantAccount, /invokeAwsCheckAltProviderFunction/);
  assert.match(tenantAccount, /checkalt-register-account/);
  assert.match(tenantAccount, /checkalt-verify-account/);
});

test('Command Center CheckAlt click performs zero prepare/assign when AWS is disabled', async () => {
  const ccc = sourceOf('src/pages/CheckCommandCenter.tsx');
  const start = ccc.indexOf('const handleDepositWithCheckAlt');
  assert.notEqual(start, -1);
  const end = ccc.indexOf('const ensureDepositReadyBackImage', start);
  const fn = end === -1 ? ccc.slice(start, start + 2500) : ccc.slice(start, end);
  assert.doesNotMatch(fn, /prepare_deposit/);
  assert.doesNotMatch(fn, /assign_provider/);
  assert.doesNotMatch(fn, /deposit_action/);
  assert.doesNotMatch(fn, /prepareCheckAltDeposit/);
  assert.doesNotMatch(fn, /from\("deposit_items"\)/);
  assert.match(fn, /runCheckAltDepositClick/);

  const orchestrator = sourceOf('src/lib/checkaltDepositOrchestrator.ts');
  assert.match(orchestrator, /runCheckAltDepositClick/);
  assert.doesNotMatch(orchestrator, /deposit_action/);
  assert.doesNotMatch(orchestrator, /supabase\.rpc/);
  assert.doesNotMatch(orchestrator, /p_action:\s*["']prepare_deposit["']/);
  assert.doesNotMatch(orchestrator, /p_action:\s*["']assign_provider["']/);

  const oneClick = sourceOf('src/lib/awsCheckAltMoneyPath.ts');
  assert.match(oneClick, /runCheckAltOneClickSubmit/);
  assert.doesNotMatch(oneClick, /deposit_action/);
  assert.doesNotMatch(oneClick, /supabase\.rpc/);
  assert.doesNotMatch(oneClick, /p_action:\s*["']prepare_deposit["']/);
  assert.doesNotMatch(oneClick, /p_action:\s*["']assign_provider["']/);
  assert.match(oneClick, /prepareCheckAltDeposit/);
  assert.match(oneClick, /checkalt\\.jpe\?g/);

  const result = await runCheckAltOneClickSubmit('623442f0-a408-4db5-85be-14bae231a722', {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    idToken: 'test-token',
    prepareCheckAltDeposit: async () => ({
      deposit_front_path: 'checks/x/front.checkalt.jpg',
      deposit_back_path: 'checks/x/back.checkalt.jpg',
    }),
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'provider_disabled' }) }),
  });
  assert.equal(result.error?.message, 'provider_disabled');
  assert.equal(result.providerHttp, false);
  assert.deepEqual(result.mutated, {
    deposit_items: false,
    deposit_batches: false,
    assign_provider: false,
    prepare_deposit: false,
    check_stage: false,
  });
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
    for (const name of NEUTRALIZED) {
      const result = await handler(jwtEvent(`/functions/v1/${name}`, { check_intake_item_id: '44444444-4444-4444-8444-444444444444' }));
      const body = JSON.parse(result.body);
      assert.equal(result.statusCode, 403, name);
      const allowed = name === 'checkalt-poll-status'
        ? ['provider_disabled', 'production_execution_blocked', 'checkalt_status_reconcile_disabled']
        : ['provider_disabled', 'production_execution_blocked'];
      assert.ok(allowed.includes(body.error), name);
      assert.notEqual(body.error, LEGACY_CHECKALT_PROVIDER_DISABLED_ERROR, name);
    }
  });

  const authz = sourceOf('aws/functions/api/providers/production/checkalt-authz.mjs');
  const mfa = sourceOf('aws/functions/api/auth-financial-totp.mjs');
  assert.match(authz, /financial_stepup_log/);
  assert.match(mfa, /INSERT INTO public\.financial_stepup_log/);
  assert.doesNotMatch(mfa, /checkAltFetch/);
});

test('checkalt-prepare-image remains a provider-free image utility', () => {
  const source = sourceOf('supabase/functions/checkalt-prepare-image/index.ts');
  assert.doesNotMatch(source, /checkAltFetch/);
  assert.doesNotMatch(source, /getCheckAltJwt/);
  assert.doesNotMatch(source, /CHECKALT_USERNAME/);
  assert.doesNotMatch(source, /CHECKALT_PASSWORD/);
  assert.doesNotMatch(source, /cached_jwt/);
  assert.doesNotMatch(source, /\/fincapture\//);
  assert.doesNotMatch(source, /from\("checkalt_deposits"\)/);
  assert.doesNotMatch(source, /from\("check_intake_items"\)\.update/);
  assert.match(source, /prepared_path/);
  assert.equal(isLegacyCheckAltProviderFunction('checkalt-prepare-image'), false);
  assert.equal(awsCheckAltProviderPathReady({
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    functionName: 'checkalt-prepare-image',
  }).ok, false);
});

test('legacy poll cron is unscheduled and no other jobs are touched', () => {
  const cron = sourceOf('supabase/migrations/20260909213600_unschedule_checkalt_poll_status.sql');
  assert.match(cron, /cron\.unschedule\('checkalt-poll-status'\)/);
  assert.doesNotMatch(cron, /cron\.schedule/);
  assert.doesNotMatch(cron, /process-email-queue/);
  assert.match(cron, /to_regclass\('cron\.job'\)/);
});

test('shutdown sources and runbook do not leak provider credentials', () => {
  const files = [
    'src/lib/awsCheckAltMoneyPath.ts',
    'supabase/functions/_shared/legacy-checkalt-money-shutdown.ts',
    ...NEUTRALIZED.map((name) => `supabase/functions/${name}/index.ts`),
    'aws/financial/LEGACY_CHECKALT_MONEY_SHUTDOWN.md',
    'supabase/migrations/20260909213600_unschedule_checkalt_poll_status.sql',
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
  assert.match(runbook, /INERT LEGACY CONFIG/);
  assert.match(runbook, /Do not create/);
});
