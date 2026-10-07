import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { main, runDiagnostic, summarizeValidation } from '../../scripts/staging-db-readonly-diagnostic.mjs';

const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const PRIVATE = 'private-response-marker';
const env = {
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: 'michaelcarletta-cmd/ChecksOps',
  CHECKSOPS_STAGING_DIAGNOSTIC_REFRESH_TOKEN: PRIVATE,
};
const jwt = (overrides = {}) => `header.${Buffer.from(JSON.stringify({
  iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_vPmQ7cL1F',
  aud: '71bb7a192cbl6o6s8m259tl589',
  token_use: 'id',
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
})).toString('base64url')}.signature`;
const validation = (overrides = {}) => ({
  service: 'checksops-api', environment: 'staging', ok: false, readOnly: true,
  writesAttempted: false, issues: [], tables: [], ...overrides,
});
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('only renews an existing staging session and GETs the existing read-only endpoint', async () => {
  const calls = [];
  const token = jwt();
  const result = await runDiagnostic({
    env,
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (calls.length === 1) {
        assert.equal(url, `${API}/auth/refresh`);
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { refreshToken: PRIVATE });
        return response({ ok: true, authentication: { idToken: token, accessToken: PRIVATE } });
      }
      assert.equal(url, `${API}/db-readonly-validate`);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.authorization, ['Bearer', token].join(' '));
      assert.equal(options.body, undefined);
      return response(validation(), 503);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.status, 'unhealthy');
  assert.doesNotMatch(JSON.stringify(result), /private-response-marker|signature/);
});

test('missing identity and wrong workflow scope fail before network access', async () => {
  for (const overrides of [
    { CHECKSOPS_STAGING_DIAGNOSTIC_REFRESH_TOKEN: undefined },
    { CHECKSOPS_STAGING_DIAGNOSTIC_REFRESH_TOKEN: ' ' },
    { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REPOSITORY: 'other/repository' },
  ]) {
    await assert.rejects(runDiagnostic({
      env: { ...env, ...overrides },
      fetchImpl: () => assert.fail('must not request any endpoint'),
    }), /staging_identity_unavailable|workflow_scope_rejected/);
  }
});

test('rejected, missing, expired, production and wrong-client tokens never reach validation', async () => {
  for (const session of [
    { ok: false },
    { ok: true, authentication: { idToken: PRIVATE } },
    { ok: true, authentication: { idToken: jwt({ exp: 0 }) } },
    { ok: true, authentication: { idToken: jwt({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_h00WorYMT' }) } },
    { ok: true, authentication: { idToken: jwt({ aud: 'other-client' }) } },
    { ok: true, authentication: { idToken: jwt({ token_use: 'access' }) } },
  ]) {
    let calls = 0;
    await assert.rejects(runDiagnostic({
      env,
      fetchImpl: async () => {
        assert.equal(++calls, 1);
        return response(session);
      },
    }), /staging_identity_rejected/);
  }
});

test('summary allows only fixed labels and appropriate integer counts, never arbitrary payload fields', () => {
  const result = summarizeValidation(validation({
    currentUser: PRIVATE,
    secretDatabase: PRIVATE,
    rlsAudit: { matrix: PRIVATE },
    catalog: { publicTriggers: 164, authUidResult: PRIVATE },
    issues: [
      { kind: 'count_mismatch', severity: 'error', table: 'claims', rowCount: 179, expectedCount: 180, message: PRIVATE },
      { kind: 'trigger', severity: 'error', message: PRIVATE },
      { kind: 'permission', severity: 'error', table: 'claims', rowCount: 1, expectedCount: 180, message: PRIVATE },
      { kind: 'missing_fk', severity: 'error', restored: 3, skipped: PRIVATE },
      { kind: 'query', severity: 'error', probe: 'privileges', code: PRIVATE, message: PRIVATE },
      { kind: PRIVATE, severity: 'error', table: PRIVATE, probe: PRIVATE, message: PRIVATE },
      { kind: 'permission', severity: 'expected', message: PRIVATE },
    ],
    tables: [{ table: 'claims', present: true, countMatches: false, error: PRIVATE }],
  }), 503);
  assert.deepEqual(result.issues, [
    { kind: 'count_mismatch', severity: 'error', probe: 'restore_count', table: 'claims', actualCount: 179, expectedCount: 180 },
    { kind: 'trigger', severity: 'error', probe: 'triggers', actualCount: 164, expectedCount: 165 },
    { kind: 'permission', severity: 'error', probe: 'rls_fail_closed', table: 'claims', actualCount: 1, expectedCount: 0 },
    { kind: 'missing_fk', severity: 'error', probe: 'auth_users_fks', actualCount: 3, expectedCount: 47 },
    { kind: 'query', severity: 'error', probe: 'privileges' },
    { kind: 'unknown', severity: 'error', probe: 'unknown', table: 'unknown' },
  ]);
  assert.deepEqual(result.tableChecks, [{ table: 'claims', probe: 'table_query' }]);
  assert.doesNotMatch(JSON.stringify(result), /private-response-marker|message|currentUser|secretDatabase|rlsAudit/);
  for (const value of [PRIVATE, '123', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
    const summary = summarizeValidation(validation({
      issues: [{ kind: 'count_mismatch', severity: 'error', rowCount: value, expectedCount: value }],
    }), 503);
    assert.equal(summary.issues[0].actualCount, undefined);
    assert.equal(summary.issues[0].expectedCount, undefined);
  }
});

test('authenticated response contract fails closed for public, malformed, unsafe or inconsistent responses', () => {
  for (const body of [
    null, [], { service: 'checksops-api', status: 'unhealthy', readOnly: true },
    validation({ environment: 'production' }),
    validation({ ok: 'false' }),
    validation({ readOnly: false }),
    validation({ writesAttempted: true }),
    validation({ issues: null }),
    validation({ issues: [null] }),
    validation({ issues: [{ severity: PRIVATE }] }),
    validation({ tables: [null] }),
    validation({ issues: Array(257).fill({ severity: 'error' }) }),
  ]) {
    assert.throws(() => summarizeValidation(body, 503), /authenticated_validation_contract_rejected/);
  }
  assert.throws(() => summarizeValidation(validation(), 200), /authenticated_validation_contract_rejected/);
  assert.equal(summarizeValidation(validation({ ok: true }), 200).status, 'ok');
});

test('identifies assertion probes without printing the source messages', () => {
  const issues = [
    { kind: 'wrong_database', message: `connected to ${PRIVATE}` },
    { kind: 'permission', message: `connected as ${PRIVATE}` },
    { kind: 'permission', message: 'RLS enablement is incomplete on core tables (1/16)' },
    { kind: 'missing_relation', message: 'restore sentinel public._checksops_restore_complete is missing' },
    { kind: 'permission', message: 'USAGE denied on schema public' },
    { kind: 'permission', message: 'USAGE unexpectedly granted on schema storage' },
    { kind: 'permission', table: 'claims', message: 'SELECT denied on public.claims' },
    { kind: 'permission', table: 'claims', message: 'FORCE ROW LEVEL SECURITY is set on public.claims' },
    { kind: 'permission', table: 'claims', canInsert: true, canUpdate: true, canDelete: false, message: PRIVATE },
  ].map((item) => ({ ...item, severity: 'error' }));
  const summary = summarizeValidation(validation({ issues }), 503);
  assert.deepEqual(summary.issues.map((item) => item.probe), [
    'database_identity', 'role_identity', 'rls_enablement', 'sentinel',
    'schema_public_usage', 'schema_storage_usage', 'select_privilege', 'force_rls', 'write_privileges',
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /private-response-marker|message|canInsert|canUpdate|canDelete/);
});

test('CLI logs only safe summaries or fixed failures, and remains failing on unhealthy', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (line) => logs.push(line));
  for (const fetchImpl of [
    async () => { throw new Error(PRIVATE); },
    async () => response({ message: PRIVATE }, 401),
    async () => new Response(PRIVATE),
    async (url) => url.endsWith('/auth/refresh')
      ? response({ ok: true, authentication: { idToken: jwt() } })
      : response(validation({ issues: [{ kind: 'query', severity: 'error', message: PRIVATE }] }), 503),
    async (url) => url.endsWith('/auth/refresh')
      ? response({ ok: true, authentication: { idToken: jwt() } })
      : response({ message: PRIVATE }, 403),
  ]) {
    assert.equal(await main({ env, fetchImpl }), 1);
  }
  assert.equal(await main({
    env,
    fetchImpl: async (url) => url.endsWith('/auth/refresh')
      ? response({ ok: true, authentication: { idToken: jwt() } })
      : response(validation({ ok: true })),
  }), 0);
  assert.equal(logs.length, 6);
  assert.doesNotMatch(logs.join('\n'), /private-response-marker|signature|Bearer|stack/);
});

test('workflow is dispatch-only, main-only, protected staging, with no AWS or mutation permissions', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/staging-db-readonly-diagnostic.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\n  workflow_dispatch:\n/);
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.match(workflow, /environment: staging/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /secrets\.CHECKSOPS_STAGING_DIAGNOSTIC_REFRESH_TOKEN/);
  assert.doesNotMatch(workflow, /pull_request|inputs:|id-token:|configure-aws-credentials|role-to-assume|upload-artifact/);
  assert.ok(workflow.indexOf('Test diagnostic safety') < workflow.indexOf('secrets.'));
});
