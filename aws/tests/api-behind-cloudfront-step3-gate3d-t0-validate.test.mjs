import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { LIFECYCLE_EMAILS } from '../identity/expected-mappings.mjs';
import {
  GATE3D_READONLY_QUERY,
  T0_TESTER_EMAIL,
  assertReadOnlyNonFinancialQuery,
  discardSecretRef,
  loadT0TesterPassword,
  mintT0IdTokenViaCloudFrontLogin,
  probeAuthenticatedReadOnlyQuery,
  publicLoginOutcome,
  redactAuthMaterial,
  t0TesterCredentialPresent,
  withInMemoryIdToken,
} from '../origin-verify/gate3d-lib.mjs';
import { executePrivilegedOperatorGate3dApply } from '../origin-verify/operator-apply-gate3d.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FAKE_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXN1YiIsInRva2VuX3VzZSI6ImlkIn0.signature';
const FAKE_PASSWORD = 'unit-test-only-not-a-real-secret';

function refuteSecrets(text) {
  assert.doesNotMatch(text, /SecretString|HeaderValue\s*[:=]\s*["'][^"']{4,}/);
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\./);
  assert.doesNotMatch(text, /Bearer [A-Za-z0-9._-]+/);
  assert.doesNotMatch(text, /unit-test-only-not-a-real-secret/);
}

test('T0 credential loader uses existing sources and never requires a manual ID token', () => {
  assert.equal(T0_TESTER_EMAIL, LIFECYCLE_EMAILS.freedom);
  assert.equal(t0TesterCredentialPresent({}), false);
  assert.equal(t0TesterCredentialPresent({ CHECKSOPS_GATE3D_ID_TOKEN: FAKE_JWT }), false);
  assert.equal(t0TesterCredentialPresent({ CHECKSOPS_T0_TESTER_PASSWORD: FAKE_PASSWORD }), true);
  assert.equal(t0TesterCredentialPresent({ COGNITO_PASSWORD_FILE: '/tmp/not-read-in-this-assert' }), true);

  const fromEnv = loadT0TesterPassword({ env: { CHECKSOPS_T0_TESTER_PASSWORD: FAKE_PASSWORD } });
  assert.equal(fromEnv, FAKE_PASSWORD);

  const fromFile = loadT0TesterPassword({
    env: { COGNITO_PASSWORD_FILE: 'in-memory.json' },
    readFile: () => JSON.stringify({ [T0_TESTER_EMAIL]: FAKE_PASSWORD }),
  });
  assert.equal(fromFile, FAKE_PASSWORD);

  assert.throws(
    () => loadT0TesterPassword({ env: {} }),
    /T0_TESTER_CREDENTIAL_required/,
  );

  const operatorApply = read('aws/origin-verify/operator-apply-gate3d.mjs');
  assert.doesNotMatch(operatorApply, /CHECKSOPS_GATE3D_ID_TOKEN_required/);
  assert.doesNotMatch(operatorApply, /requireLiveIdToken/);
  assert.match(operatorApply, /T0_TESTER_CREDENTIAL_required/);
  assert.match(operatorApply, /manualIdTokenRequired: false/);
});

test('auth material redaction never emits JWT, Bearer, or password values', () => {
  const leaked = redactAuthMaterial(
    `authorization: Bearer ${FAKE_JWT} password=${FAKE_PASSWORD} idToken:${FAKE_JWT}`,
  );
  refuteSecrets(leaked);
  assert.match(leaked, /REDACTED/);
});

test('in-memory mint uses CloudFront login once and discards the token reference', async () => {
  let seenAuthHeader = null;
  let fetchCalls = [];
  const fetchImpl = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), method: init.method, hasAuth: Boolean(init.headers?.authorization) });
    if (String(url).endsWith('/prep/auth/login')) {
      const body = JSON.parse(init.body);
      assert.equal(body.email, T0_TESTER_EMAIL);
      assert.equal(body.password, FAKE_PASSWORD);
      return {
        status: 200,
        headers: { get: (name) => (name === 'x-amz-cf-id' ? 'cf-test' : null) },
        text: async () => JSON.stringify({
          service: 'checksops-api',
          authentication: { idToken: FAKE_JWT, accessToken: 'access', refreshToken: 'refresh' },
        }),
      };
    }
    seenAuthHeader = init.headers?.authorization;
    return {
      status: 200,
      headers: { get: (name) => (name === 'x-amz-cf-id' ? 'cf-test' : null) },
      text: async () => JSON.stringify({ service: 'checksops-api', data: [{ role: 'staff' }] }),
    };
  };

  const holder = { leftover: FAKE_JWT };
  const publicReport = await withInMemoryIdToken(
    async () => mintT0IdTokenViaCloudFrontLogin({
      fetchImpl,
      loadPassword: () => FAKE_PASSWORD,
    }),
    async (idToken) => {
      assert.equal(idToken, FAKE_JWT);
      holder.used = Boolean(idToken);
      const query = await probeAuthenticatedReadOnlyQuery({ fetchImpl, idToken });
      assert.equal(query.status, 200);
      assert.equal(query.skipped, false);
      assert.equal(query.required, true);
      assert.equal(query.readOnly, true);
      assert.equal(query.table, 'user_roles');
      assert.equal(seenAuthHeader, `Bearer ${FAKE_JWT}`);
      return publicLoginOutcome({ ok: true, status: 200, cfId: true, reachedPrep: true, idToken });
    },
  );

  assert.equal(fetchCalls[0].url, 'https://checksops.com/prep/auth/login');
  assert.equal(fetchCalls[0].hasAuth, false);
  assert.equal(fetchCalls[1].url, 'https://checksops.com/prep/data/query');
  assert.deepEqual(publicReport, {
    ok: true,
    status: 200,
    cfId: true,
    reachedPrep: true,
    skipped: false,
    required: true,
  });
  assert.equal(Object.hasOwn(publicReport, 'idToken'), false);
  refuteSecrets(JSON.stringify(publicReport));
  refuteSecrets(JSON.stringify(fetchCalls));
});

test('read-only query refuses financial tables and write ops', () => {
  assert.equal(assertReadOnlyNonFinancialQuery(GATE3D_READONLY_QUERY), true);
  assert.equal(GATE3D_READONLY_QUERY.table, 'user_roles');
  assert.equal(GATE3D_READONLY_QUERY.op, 'select');
  assert.doesNotMatch(JSON.stringify(GATE3D_READONLY_QUERY), /check_intake|disbursement|financial|payment/);
  assert.throws(
    () => assertReadOnlyNonFinancialQuery({ table: 'check_intake_items', op: 'select', select: 'id' }),
    /refusing_financial_query_probe/,
  );
  assert.throws(
    () => assertReadOnlyNonFinancialQuery({ table: 'user_roles', op: 'insert' }),
    /refusing_non_select_query_probe/,
  );
});

test('authenticated success is mandatory; skipped login or query is never a pass', async () => {
  const skippedQuery = await probeAuthenticatedReadOnlyQuery({ idToken: '' });
  assert.equal(skippedQuery.skipped, false);
  assert.equal(skippedQuery.required, true);
  assert.equal(skippedQuery.status, null);

  const failedLogin = publicLoginOutcome({ ok: false, status: 401, idToken: FAKE_JWT });
  assert.equal(failedLogin.ok, false);
  assert.equal(failedLogin.skipped, false);
  assert.equal(Object.hasOwn(failedLogin, 'idToken'), false);
  refuteSecrets(JSON.stringify(failedLogin));
});

test('discardSecretRef and withInMemoryIdToken drop the token after use', async () => {
  const minted = { idToken: FAKE_JWT, status: 200 };
  discardSecretRef(minted, 'idToken');
  assert.equal(Object.hasOwn(minted, 'idToken'), false);

  let observed = 'unset';
  await withInMemoryIdToken(
    async () => ({ idToken: FAKE_JWT }),
    async (token) => {
      observed = token;
      assert.equal(token, FAKE_JWT);
    },
  );
  assert.equal(observed, FAKE_JWT);
});

test('operator apply rolls back when CloudFront login or authenticated query fails', async () => {
  let rollbackCalls = 0;
  const identity = {
    Account: '806168576068',
    Arn: 'arn:aws:sts::806168576068:assumed-role/Privileged/review',
  };
  const common = {
    identity,
    collectPreflightFn: () => ({}),
    collectObserveFn: async () => ({}),
    evaluatePreflightFn: () => ({ ok: true, checks: {} }),
    getLambdaConfig: () => ({ Environment: { Variables: {} }, RevisionId: '1' }),
    updateRequire: () => ({ requireFlag: 'true', envKeys: ['ORIGIN_VERIFY_REQUIRE'], revisionIdUsed: '1' }),
    waitReady: () => {},
    sleep: async () => {},
    credentialPresent: () => true,
    rollbackFn: async () => {
      rollbackCalls += 1;
      return { requireFlag: 'false', cfHealth: true, rawHealth: true, executeApiEnabled: true };
    },
  };

  const loginFail = await executePrivilegedOperatorGate3dApply({
    ...common,
    mintLogin: async () => ({ ok: false, status: 401, idToken: null, cfId: true, reachedPrep: true }),
    validateFn: async () => {
      throw new Error('validate_should_not_run_without_login');
    },
  });
  assert.equal(loginFail.mode, 'rolled_back');
  assert.equal(loginFail.login.ok, false);
  assert.equal(loginFail.validation.loginOk, false);
  assert.equal(rollbackCalls, 1);
  refuteSecrets(JSON.stringify(loginFail));

  const queryFail = await executePrivilegedOperatorGate3dApply({
    ...common,
    mintLogin: async () => ({ ok: true, status: 200, idToken: FAKE_JWT, cfId: true, reachedPrep: true }),
    validateFn: async ({ idToken }) => {
      assert.equal(idToken, FAKE_JWT);
      return {
        ok: false,
        checks: { authenticatedOk: false },
        executeApiEnabled: true,
      };
    },
  });
  assert.equal(queryFail.mode, 'rolled_back');
  assert.equal(queryFail.login.ok, true);
  assert.equal(queryFail.validation.authenticatedOk, false);
  assert.equal(rollbackCalls, 2);
  refuteSecrets(JSON.stringify(queryFail));

  const healthFail = await executePrivilegedOperatorGate3dApply({
    ...common,
    mintLogin: async () => ({ ok: true, status: 200, idToken: FAKE_JWT, cfId: true, reachedPrep: true }),
    validateFn: async () => ({
      ok: false,
      checks: { cfHealthOk: false, authenticatedOk: true, loginOk: true },
      executeApiEnabled: true,
    }),
  });
  assert.equal(healthFail.mode, 'rolled_back');
  assert.equal(rollbackCalls, 3);
  refuteSecrets(JSON.stringify(healthFail));
});

test('successful mocked operator apply never persists or reports the token', async () => {
  const result = await executePrivilegedOperatorGate3dApply({
    identity: {
      Account: '806168576068',
      Arn: 'arn:aws:sts::806168576068:assumed-role/Privileged/review',
    },
    collectPreflightFn: () => ({}),
    collectObserveFn: async () => ({}),
    evaluatePreflightFn: () => ({ ok: true, checks: {} }),
    getLambdaConfig: () => ({ Environment: { Variables: { KEEP: '1' } }, RevisionId: '9' }),
    updateRequire: () => ({
      requireFlag: 'true',
      envKeys: ['KEEP', 'ORIGIN_VERIFY_REQUIRE'],
      revisionIdUsed: '9',
    }),
    waitReady: () => {},
    sleep: async () => {},
    credentialPresent: () => true,
    mintLogin: async () => ({ ok: true, status: 200, idToken: FAKE_JWT, cfId: true, reachedPrep: true }),
    validateFn: async ({ requireMode, idToken }) => {
      assert.equal(requireMode, true);
      assert.equal(idToken, FAKE_JWT);
      return {
        ok: true,
        checks: { authenticatedOk: true, cfHealthOk: true },
        executeApiEnabled: true,
      };
    },
    rollbackFn: async () => {
      throw new Error('rollback_should_not_run');
    },
  });
  assert.equal(result.mode, 'executed');
  assert.equal(result.ok, true);
  assert.equal(result.login.ok, true);
  assert.equal(result.validation.authenticatedOk, true);
  assert.equal(result.validation.loginOk, true);
  assert.equal(result.manualIdTokenRequired, false);
  assert.equal(result.financialRowsProcessed, false);
  refuteSecrets(JSON.stringify(result));
});

test('operator and helper sources never write tokens or call Cognito admin APIs', () => {
  const sources = [
    read('aws/origin-verify/operator-apply-gate3d.mjs'),
    read('aws/origin-verify/gate3d-lib.mjs'),
    read('aws/origin-verify/validate-gate3d.mjs'),
    read('aws/cutover/API_PERIMETER_STEP3_OPERATOR_GATE3D.md'),
  ].join('\n');
  assert.match(sources, /https:\/\/checksops.com\/prep\/auth\/login/);
  assert.match(sources, /user_roles/);
  assert.doesNotMatch(sources, /admin-set-user-password|AdminSetUserPassword|AdminCreateUser/);
  assert.doesNotMatch(sources, /writeFileSync|appendFileSync/);
  assert.doesNotMatch(sources, /spawnSync\([^\)]*PASSWORD/);
  assert.doesNotMatch(sources, /GetSecretValue/);
});
