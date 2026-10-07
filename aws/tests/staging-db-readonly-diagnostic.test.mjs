import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import {
  createStagingVerifier, diagnose, main, summarizeValidation,
} from '../../scripts/staging-db-readonly-diagnostic.mjs';

const TOKEN = 'offline-test-session';
const SENSITIVE = 'sensitive-fixture-must-not-appear';
const validation = (overrides = {}) => ({
  service: 'checksops-api', environment: 'staging',
  ok: false, readOnly: true, writesAttempted: false,
  tables: [], issues: [], ...overrides,
});
const response = (body, status = 503) => ({ status, json: async () => body });
const offlineOptions = (overrides = {}) => ({
  token: TOKEN, verifyToken: async () => {},
  fetchImpl: async () => response(validation({
    issues: [{ kind: 'trigger', severity: 'error', message: SENSITIVE }],
    catalog: { publicTriggers: 164 },
  })),
  ...overrides,
});

test('real JWT verifier accepts only signed, unexpired staging ID tokens (offline JWKS)', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const verifier = createStagingVerifier();
  verifier.cacheJwks({
    keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'offline', alg: 'RS256', use: 'sig' }],
  });
  const jwt = (overrides = {}, signingKey = privateKey) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'offline' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_vPmQ7cL1F',
      aud: '71bb7a192cbl6o6s8m259tl589', token_use: 'id', sub: 'offline-sub',
      exp: Math.floor(Date.now() / 1000) + 300, ...overrides,
    })).toString('base64url');
    const data = `${header}.${payload}`;
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), signingKey).toString('base64url')}`;
  };
  assert.equal((await verifier.verify(jwt())).sub, 'offline-sub');
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  for (const token of [
    jwt({ exp: 1 }),
    jwt({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_other' }),
    jwt({ aud: 'other-client' }),
    jwt({ token_use: 'access' }),
    jwt({}, otherKey),
  ]) {
    let output;
    assert.equal(await main(offlineOptions({
      token, verifyToken: (value) => verifier.verify(value),
      fetchImpl: async () => assert.fail('must not call API'),
      writeOutput: (text) => { output = text; },
    })), 2);
    assert.equal(output, '{"status":"diagnostic_failed","classification":"staging_identity_rejected"}');
  }
});

test('verifies identity before exactly one GET to the immutable staging target', async () => {
  const calls = [];
  const result = await diagnose(offlineOptions({
    verifyToken: async (token) => {
      assert.equal(token, TOKEN);
      calls.push('verify');
    },
    fetchImpl: async (url, options) => {
      calls.push('fetch');
      assert.equal(url, 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging/db-readonly-validate');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, ['Bearer', TOKEN].join(' '));
      assert.equal(options.body, undefined);
      assert.ok(options.signal instanceof AbortSignal);
      return response(validation({
        issues: [{ kind: 'trigger', severity: 'error' }],
      }));
    },
  }));
  assert.deepEqual(calls, ['verify', 'fetch']);
  assert.equal(result.status, 'unhealthy');
});

test('missing or rejected staging identity fails before any API call without leaking errors', async () => {
  for (const token of [undefined, '', 'bad\nheader', 'x'.repeat(16385), TOKEN]) {
    let output;
    const code = await main(offlineOptions({
      token,
      verifyToken: async () => { throw new Error(SENSITIVE); },
      fetchImpl: async () => assert.fail('must not call API'),
      writeOutput: (text) => { output = text; },
    }));
    assert.equal(code, 2);
    assert.doesNotMatch(output, new RegExp(SENSITIVE));
    assert.doesNotMatch(output, /offline-test-session/);
    assert.match(output, /staging_identity_(unavailable|rejected)/);
  }
});

test('allowlists classifications and assertion counts, never copies raw payload fields', () => {
  const result = summarizeValidation(validation({
    currentDatabase: SENSITIVE, currentUser: SENSITIVE, secretDatabase: SENSITIVE,
    rlsAudit: { matrix: SENSITIVE }, password: SENSITIVE, idToken: TOKEN,
    catalog: { publicTriggers: 164, authUidResult: SENSITIVE },
    issues: [
      { kind: 'count_mismatch', severity: 'error', table: 'claims', rowCount: 179, expectedCount: 180, message: SENSITIVE },
      { kind: 'permission', severity: 'error', table: 'profiles', rowCount: 8, expectedCount: 8, message: SENSITIVE },
      { kind: 'trigger', severity: 'error', message: SENSITIVE },
      { kind: 'missing_fk', severity: 'error', restored: 1, skipped: SENSITIVE },
      { kind: 'query', severity: 'error', probe: 'privileges', code: SENSITIVE },
      { kind: SENSITIVE, severity: 'error', table: SENSITIVE, probe: SENSITIVE, message: SENSITIVE },
      { kind: 'supabase_dependency', severity: 'expected', message: SENSITIVE },
    ],
  }), 503);
  assert.deepEqual(result.issues, [
    { kind: 'count_mismatch', severity: 'error', probe: 'row_count', table: 'claims', expectedCount: 180, actualCount: 179 },
    { kind: 'permission', severity: 'error', probe: 'rls_visibility', table: 'profiles', expectedCount: 0, actualCount: 8 },
    { kind: 'trigger', severity: 'error', probe: 'triggers', expectedCount: 165, actualCount: 164 },
    { kind: 'missing_fk', severity: 'error', probe: 'auth_users_fks', expectedCount: 47, actualCount: 1 },
    { kind: 'query', severity: 'error', probe: 'privileges' },
    { kind: 'unclassified', severity: 'error', probe: 'unclassified' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${SENSITIVE}|${TOKEN}`));
});

test('distinguishes permission assertion failures using only fixed labels', () => {
  const cases = [
    ['connected as unexpected, expected checksops', 'application_role'],
    ['SELECT denied on public.claims', 'select_privilege'],
    ['write privilege present on public.claims', 'write_privilege'],
    ['FORCE ROW LEVEL SECURITY is set on public.claims', 'force_rls'],
    ['RLS enablement is incomplete on core tables (1/16)', 'rls_enablement'],
    ['USAGE denied on schema public', 'public_schema_usage'],
    ['USAGE unexpectedly granted on schema storage', 'storage_schema_usage'],
    [SENSITIVE, 'unclassified'],
  ];
  for (const [message, probe] of cases) {
    const result = summarizeValidation(validation({
      issues: [{ kind: 'permission', severity: 'error', message }],
    }), 503);
    assert.deepEqual(result.issues, [{ kind: 'permission', severity: 'error', probe }]);
  }
});

test('rejects public/redacted, non-staging, mutable, and inconsistent responses', () => {
  for (const body of [
    null,
    { service: 'checksops-api', status: 'unhealthy', readOnly: true },
    validation({ environment: 'production' }),
    validation({ readOnly: false }),
    validation({ writesAttempted: true }),
    validation({ issues: [{ kind: 'query', severity: SENSITIVE }] }),
    validation({ tables: [{ table: SENSITIVE }] }),
    validation({ ok: true, issues: [{ kind: 'query', severity: 'error' }] }),
  ]) {
    assert.throws(() => summarizeValidation(body, 503), /response_contract_mismatch/);
  }
  assert.throws(() => summarizeValidation(validation(), 200), /response_contract_mismatch/);
  assert.throws(() => summarizeValidation(validation(), 401), /response_contract_mismatch/);
});

test('omits invalid counts and reports table-only validation failures', () => {
  for (const count of [-1, 1.5, '180', SENSITIVE, Number.MAX_SAFE_INTEGER + 1]) {
    const result = summarizeValidation(validation({
      issues: [{ kind: 'count_mismatch', severity: 'error', table: 'claims', rowCount: count, expectedCount: 180 }],
    }), 503);
    assert.equal(Object.hasOwn(result.issues[0], 'actualCount'), false);
  }
  const result = summarizeValidation(validation({
    tables: [
      { table: 'claims', present: true, countMatches: false, error: SENSITIVE },
      { table: 'profiles', present: true, countMatches: false },
      { table: 'tenants', present: false },
    ],
  }), 503);
  assert.deepEqual(result.issues.map((item) => item.probe), ['table_query', 'row_count', 'table_presence']);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SENSITIVE));
});

test('transport/redirect and JSON failures emit only fixed classifications', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(SENSITIVE); },
    async () => ({ status: 503, json: async () => { throw new Error(SENSITIVE); } }),
    async () => response({ message: SENSITIVE }),
  ]) {
    let output;
    assert.equal(await main(offlineOptions({
      fetchImpl, writeOutput: (text) => { output = text; },
    })), 2);
    assert.doesNotMatch(output, new RegExp(SENSITIVE));
    assert.match(output, /diagnostic_request_failed|response_contract_mismatch/);
  }
});

test('exit codes distinguish healthy, unhealthy, and unavailable diagnostics', async () => {
  const writeOutput = () => {};
  assert.equal(await main(offlineOptions({ writeOutput })), 1);
  assert.equal(await main(offlineOptions({
    writeOutput, fetchImpl: async () => response(validation({ ok: true }), 200),
  })), 0);
  assert.equal(await main({ token: '', writeOutput }), 2);
  assert.equal(await main({ token: 'not-a-jwt', writeOutput }), 2);
});

test('workflow is manual, protected, main-only, without AWS access or configurable targets', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/staging-db-readonly-diagnostic.yml', import.meta.url), 'utf8');
  const script = fs.readFileSync(new URL('../../scripts/staging-db-readonly-diagnostic.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: staging/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /git rev-parse HEAD.*\$GITHUB_SHA/);
  assert.match(workflow, /secrets\.CHECKSOPS_STAGING_DIAGNOSTIC_ID_TOKEN/);
  assert.match(workflow, /npm ci .*--ignore-scripts/);
  assert.doesNotMatch(workflow, /id-token:|configure-aws-credentials|pull_request:|push:|inputs:|upload-artifact|continue-on-error|set -x/);
  assert.match(script, /userPoolId: 'us-east-1_vPmQ7cL1F'/);
  assert.match(script, /clientId: '71bb7a192cbl6o6s8m259tl589'/);
  assert.match(script, /tokenUse: 'id'/);
  assert.doesNotMatch(script, /process\.env\.(?:CHECKSOPS_API_URL|COGNITO_|AWS_)|\/auth\/|\/data\/|execSync|spawnSync/);
});
