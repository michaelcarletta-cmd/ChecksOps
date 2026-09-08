import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  mintT0IdTokenViaPasswordless,
  probeAuthenticatedReadOnlyQuery,
  promptCloudShellSecret,
  publicLoginOutcome,
  redactAuthMaterial,
  requireCloudShellTty,
  withInMemoryIdToken,
} from '../origin-verify/gate3d-lib.mjs';
import { executePrivilegedOperatorGate3dApply } from '../origin-verify/operator-apply-gate3d.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FAKE_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXN1YiIsInRva2VuX3VzZSI6ImlkIn0.signature';
const FAKE_CODE = '123456';
const FAKE_SESSION = 'cognito-session-not-a-secret-for-tests';

function refuteSecrets(text) {
  assert.doesNotMatch(text, /SecretString|HeaderValue\s*[:=]\s*["'][^"']{4,}/);
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\./);
  assert.doesNotMatch(text, /Bearer [A-Za-z0-9._-]+/);
}

test('operator path removes password env/file sources and does not require a manual ID token', () => {
  assert.equal(T0_TESTER_EMAIL, LIFECYCLE_EMAILS.freedom);
  const operatorSources = [
    read('aws/origin-verify/operator-apply-gate3d.mjs'),
    read('aws/cutover/API_PERIMETER_STEP3_OPERATOR_GATE3D.md'),
  ].join('\n');
  const lib = read('aws/origin-verify/gate3d-lib.mjs');
  assert.doesNotMatch(operatorSources, /CHECKSOPS_T0_TESTER_PASSWORD/);
  assert.doesNotMatch(operatorSources, /COGNITO_PASSWORD_FILE/);
  assert.doesNotMatch(lib, /CHECKSOPS_T0_TESTER_PASSWORD/);
  assert.doesNotMatch(lib, /COGNITO_PASSWORD_FILE/);
  assert.doesNotMatch(operatorSources, /loadT0TesterPassword|t0TesterCredentialPresent|T0_TESTER_CREDENTIAL_required/);
  assert.doesNotMatch(lib, /loadT0TesterPassword|t0TesterCredentialPresent|T0_TESTER_CREDENTIAL_required/);
  assert.doesNotMatch(operatorSources, /CHECKSOPS_GATE3D_ID_TOKEN_required/);
  assert.doesNotMatch(operatorSources, /requireLiveIdToken/);
  assert.match(read('aws/origin-verify/operator-apply-gate3d.mjs'), /manualIdTokenRequired: false/);
});

test('auth material redaction never emits JWT, Bearer, session, or code values', () => {
  const leaked = redactAuthMaterial(
    `authorization: Bearer ${FAKE_JWT} session=${FAKE_SESSION} code=${FAKE_CODE} idToken:${FAKE_JWT}`,
  );
  refuteSecrets(leaked);
  assert.doesNotMatch(leaked, /123456/);
  assert.match(leaked, /REDACTED/);
});

test('CloudShell prompt refuses non-TTY and never echoes the code', async () => {
  assert.throws(() => requireCloudShellTty({ isTTY: false }), /cloudshell_tty_required/);
  await assert.rejects(
    () => promptCloudShellSecret({ stdin: { isTTY: false } }),
    /cloudshell_tty_required/,
  );

  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  let written = '';
  const stdout = { write: (s) => { written += String(s); } };
  const pending = promptCloudShellSecret({ stdin, stdout, label: 'code: ' });
  stdin.emit('data', Buffer.from(FAKE_CODE));
  stdin.emit('data', Buffer.from('\n'));
  const value = await pending;
  assert.equal(value, FAKE_CODE);
  assert.doesNotMatch(written, /123456/);
});

test('in-memory passwordless mint uses CloudFront EMAIL_OTP then discards the token', async () => {
  let seenAuthHeader = null;
  let fetchCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = init.body ? JSON.parse(init.body) : {};
    fetchCalls.push({
      url: String(url),
      method: init.method,
      hasAuth: Boolean(init.headers?.authorization),
      hasPassword: Object.prototype.hasOwnProperty.call(parsed, 'password'),
    });
    if (String(url).endsWith('/prep/auth/passwordless/start')) {
      assert.equal(parsed.email, T0_TESTER_EMAIL);
      assert.equal(parsed.password, undefined);
      return {
        status: 200,
        headers: { get: (name) => (name === 'x-amz-cf-id' ? 'cf-test' : null) },
        text: async () => JSON.stringify({
          service: 'checksops-api',
          challenge: 'EMAIL_OTP',
          session: FAKE_SESSION,
        }),
      };
    }
    if (String(url).endsWith('/prep/auth/passwordless/verify')) {
      assert.equal(parsed.email, T0_TESTER_EMAIL);
      assert.equal(parsed.session, FAKE_SESSION);
      assert.equal(parsed.code, FAKE_CODE);
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

  const publicReport = await withInMemoryIdToken(
    async () => mintT0IdTokenViaPasswordless({
      fetchImpl,
      promptCode: async () => FAKE_CODE,
    }),
    async (idToken) => {
      assert.equal(idToken, FAKE_JWT);
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

  assert.equal(fetchCalls[0].url, 'https://checksops.com/prep/auth/passwordless/start');
  assert.equal(fetchCalls[0].hasPassword, false);
  assert.equal(fetchCalls[1].url, 'https://checksops.com/prep/auth/passwordless/verify');
  assert.equal(fetchCalls[2].url, 'https://checksops.com/prep/data/query');
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

test('operator apply mints before AWS write; login failure does not apply; later failures roll back', async () => {
  let rollbackCalls = 0;
  let applyCalls = 0;
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
    updateRequire: () => {
      applyCalls += 1;
      return { requireFlag: 'true', envKeys: ['ORIGIN_VERIFY_REQUIRE'], revisionIdUsed: '1' };
    },
    waitReady: () => {},
    sleep: async () => {},
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
  assert.equal(loginFail.mode, 'login_refused');
  assert.equal(loginFail.login.ok, false);
  assert.equal(loginFail.validation.loginOk, false);
  assert.equal(applyCalls, 0);
  assert.equal(rollbackCalls, 0);
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
  assert.equal(applyCalls, 1);
  assert.equal(rollbackCalls, 1);
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
  assert.equal(applyCalls, 2);
  assert.equal(rollbackCalls, 2);
  refuteSecrets(JSON.stringify(healthFail));
});

test('successful mocked operator apply never persists or reports the token', async () => {
  let appliedAfterMint = false;
  const result = await executePrivilegedOperatorGate3dApply({
    identity: {
      Account: '806168576068',
      Arn: 'arn:aws:sts::806168576068:assumed-role/Privileged/review',
    },
    collectPreflightFn: () => ({}),
    collectObserveFn: async () => ({}),
    evaluatePreflightFn: () => ({ ok: true, checks: {} }),
    getLambdaConfig: () => ({ Environment: { Variables: { KEEP: '1' } }, RevisionId: '9' }),
    mintLogin: async () => {
      assert.equal(appliedAfterMint, false);
      return { ok: true, status: 200, idToken: FAKE_JWT, cfId: true, reachedPrep: true };
    },
    updateRequire: () => {
      appliedAfterMint = true;
      return {
        requireFlag: 'true',
        envKeys: ['KEEP', 'ORIGIN_VERIFY_REQUIRE'],
        revisionIdUsed: '9',
      };
    },
    waitReady: () => {},
    sleep: async () => {},
    validateFn: async ({ requireMode, idToken }) => {
      assert.equal(appliedAfterMint, true);
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
  assert.equal(result.passwordlessBeforeAwsWrite, true);
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
  assert.match(sources, /https:\/\/checksops.com\/prep\/auth\/passwordless\/start/);
  assert.match(sources, /passwordless\/verify/);
  assert.match(sources, /user_roles/);
  assert.doesNotMatch(sources, /admin-set-user-password|AdminSetUserPassword|AdminCreateUser/);
  assert.doesNotMatch(sources, /writeFileSync|appendFileSync/);
  assert.doesNotMatch(sources, /spawnSync\([^\)]*PASSWORD/);
  assert.doesNotMatch(sources, /GetSecretValue/);
  assert.doesNotMatch(sources, /CHECKSOPS_T0_TESTER_PASSWORD|COGNITO_PASSWORD_FILE/);
});
