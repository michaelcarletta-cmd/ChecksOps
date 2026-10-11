import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  SQL53_CONFIG_AUTHORIZATION_ENV,
  SQL53_CONFIG_DEPLOYMENT_TYPE,
  SQL53_CONFIG_EXPIRY_ENV,
  SQL53_CONFIG_EXPECTED_COLUMNS,
  SQL53_CONFIG_EXPECTED_FUNCTIONS,
  SQL53_CONFIG_EXPECTED_TRIGGERS,
  SQL53_CONFIG_FUNCTION,
  applySql53TemporaryLambdaConfig,
  fingerprintSql53LambdaConfiguration,
  parseSql53InspectionResponse,
} from '../../scripts/deployment-guard/lib/sql53-temporary-lambda-config.mjs';
import { evaluateSql53TemporaryConfigPreflight } from '../../scripts/deployment-guard/lib/sql53-temporary-config-preflight.mjs';
import { evaluateDeployment } from '../../scripts/deployment-guard/lib/guard.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';

register('./helpers/pg-ci-stub-hooks.mjs', import.meta.url);
const {
  SQL53_PINNED_FUNCTION_LOOKUPS,
  SQL53_REQUIRED_LEDGER_TRIGGERS,
  SQL53_REQUIRED_SETTLEMENT_COLUMNS,
} = await import('../functions/api/sql53-production-readonly-inspect.mjs');

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const WORKSTREAM = 'sql53-config-writer-test';
const COMMIT = 'a'.repeat(40);
const AUTH_TOKEN = 'b'.repeat(64);
const ENV = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' };

function configuration(overrides = {}) {
  return {
    FunctionName: SQL53_CONFIG_FUNCTION,
    FunctionArn: 'arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api',
    Role: 'arn:aws:iam::806168576068:role/checksops-production-prep-api',
    Runtime: 'nodejs20.x',
    Handler: 'index.handler',
    CodeSha256: 'code-sha-1',
    RevisionId: 'revision-1',
    LastUpdateStatus: 'Successful',
    LastModified: '2026-10-10T11:00:00.000+0000',
    MemorySize: 1024,
    Timeout: 30,
    Environment: {
      Variables: {
        CHECKSOPS_ENV: 'production',
        AWS_LAMBDA_FUNCTION_NAME: SQL53_CONFIG_FUNCTION,
        KEEP: 'private-setting',
      },
    },
    ...overrides,
  };
}

function inspectionPayload() {
  return {
    statusCode: 200,
    body: {
      status: 'complete',
      reason: 'safe reason',
      rdsIdentifier: 'checksops-production',
      inspect: {
        readOnly: true,
        functions: SQL53_CONFIG_EXPECTED_FUNCTIONS.map((identity) => ({
          identity,
          exists: true,
          definitionSha256: 'c'.repeat(64),
          definition: 'must not be returned',
        })),
        settlementColumns: SQL53_CONFIG_EXPECTED_COLUMNS.map((column) => ({
          table: 'claim_settlements',
          column,
          exists: true,
          password: 'must not be returned',
        })),
        ledgerTriggers: SQL53_CONFIG_EXPECTED_TRIGGERS.map((trigger) => ({
          table: 'check_intake_items',
          trigger,
          exists: true,
        })),
      },
    },
  };
}

function makeHarness({
  initial = configuration(),
  invoke = async () => ({ StatusCode: 200, Payload: Buffer.from(JSON.stringify(inspectionPayload())) }),
  beforeGet = null,
  beforeUpdate = null,
} = {}) {
  const calls = [];
  const state = structuredClone(initial);
  let reads = 0;
  let updates = 0;
  const aws = {
    calls,
    state,
    async getCallerIdentity() {
      calls.push({ method: 'identity' });
      return {
        Account: '806168576068',
        Arn: 'arn:aws:sts::806168576068:assumed-role/ChecksOpsProductionSql53ConfigWriter/session-test',
      };
    },
    async getFunctionConfiguration({ functionName }) {
      calls.push({ method: 'read', functionName });
      reads += 1;
      await beforeGet?.({ state, reads, updates });
      return structuredClone(state);
    },
    async updateFunctionConfiguration(input) {
      calls.push({ method: 'update', ...structuredClone(input) });
      updates += 1;
      await beforeUpdate?.({ state, input, updates });
      if (input.functionName !== SQL53_CONFIG_FUNCTION || input.revisionId !== state.RevisionId) {
        throw new Error('RevisionId conflict');
      }
      state.Environment = { Variables: structuredClone(input.environment) };
      state.RevisionId = `revision-${updates + 1}`;
      state.LastModified = `2026-10-10T12:0${updates}:00.000+0000`;
      state.LastUpdateStatus = 'Successful';
      return structuredClone(state);
    },
    async invokeFunction(input) {
      calls.push({ method: 'invoke', ...structuredClone(input) });
      return invoke(input);
    },
  };
  return { aws, calls, state, get reads() { return reads; }, get updates() { return updates; } };
}

function signedInput(root, liveConfiguration, overrides = {}) {
  const fingerprint = fingerprintSql53LambdaConfiguration(liveConfiguration);
  assert.equal(fingerprint.ok, true);
  const lease = acquireLease(root, {
    workstream_id: WORKSTREAM,
    component: SQL53_CONFIG_FUNCTION,
    environment: 'production',
    commit: COMMIT,
  }, NOW);
  assert.equal(lease.ok, true);
  const issued = issueReceipt(root, {
    workstream_id: WORKSTREAM,
    branch: 'cursor/sql53-config-test',
    commit: COMMIT,
    operator: 'test-operator',
    target_environment: 'production',
    target_component: SQL53_CONFIG_FUNCTION,
    deployment_type: SQL53_CONFIG_DEPLOYMENT_TYPE,
    owned_components: [SQL53_CONFIG_FUNCTION],
    preflight_live_fingerprint: fingerprint.details.fingerprint,
    lease: lease.details.lease,
  }, { now: NOW });
  assert.equal(issued.ok, true, issued.message);
  return {
    apply: true,
    receipt: issued.details.receipt,
    workstream_id: WORKSTREAM,
    commit: COMMIT,
    approval: { approved: true, workstream_id: WORKSTREAM },
    staging_acceptance: { ok: true, reference: 'staging-acceptance-test' },
    authorization_window_ms: 60_000,
    ...overrides,
  };
}

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql53-config-'));
  return root;
}

test('writer response allowlists stay aligned with the SQL53 inspection contract', () => {
  assert.deepEqual(
    SQL53_CONFIG_EXPECTED_FUNCTIONS,
    SQL53_PINNED_FUNCTION_LOOKUPS.map((row) => row.identity),
  );
  assert.deepEqual(SQL53_CONFIG_EXPECTED_COLUMNS, SQL53_REQUIRED_SETTLEMENT_COLUMNS);
  assert.deepEqual(
    SQL53_CONFIG_EXPECTED_TRIGGERS,
    SQL53_REQUIRED_LEDGER_TRIGGERS.map((row) => row.trigger),
  );
});

test('official preflight accepts only the exact production config target and matching fresh fingerprint', () => {
  const config = configuration();
  const fingerprint = fingerprintSql53LambdaConfiguration(config).details.fingerprint;
  const input = {
    workstream_id: WORKSTREAM,
    branch: 'cursor/sql53-config-test',
    commit: COMMIT,
    operator: 'test-operator',
    target_environment: 'production',
    target_component: SQL53_CONFIG_FUNCTION,
    function_name: SQL53_CONFIG_FUNCTION,
    deployment_type: SQL53_CONFIG_DEPLOYMENT_TYPE,
    owned_components: [SQL53_CONFIG_FUNCTION],
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: { ok: true, reference: 'staging-acceptance-test' },
    approval: { approved: true, workstream_id: WORKSTREAM },
    build_timestamp: new Date(NOW).toISOString(),
  };
  assert.equal(evaluateSql53TemporaryConfigPreflight(input).ok, true);
  assert.equal(evaluateDeployment(input, { skip_contracts: true }).ok, true);
  assert.equal(evaluateSql53TemporaryConfigPreflight({
    ...input,
    owned_components: [SQL53_CONFIG_FUNCTION, 'another-target'],
  }).ok, false);
  assert.equal(evaluateSql53TemporaryConfigPreflight({
    ...input,
    immediately_before_fingerprint: { ...fingerprint, revision_id: 'stale' },
  }).ok, false);
});

async function runWriter(root, input, aws, overrides = {}) {
  return applySql53TemporaryLambdaConfig(input, {
    env: ENV,
    guardRoot: root,
    aws,
    now: NOW,
    createAuthorizationToken: () => AUTH_TOKEN,
    waitAttempts: 1,
    waitDelayMs: 0,
    cleanupAttempts: 3,
    ...overrides,
  });
}

test('temporary config writer preserves all settings and cleans up after a successful direct inspect', async () => {
  const root = tempRoot();
  try {
    const original = configuration();
    const harness = makeHarness({ initial: original });
    const result = await runWriter(root, signedInput(root, original), harness.aws);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.details.inspection.status, 'complete');
    assert.equal(result.details.cleanup.complete, true);
    assert.equal(harness.updates, 2);
    assert.equal(harness.calls.filter(({ method }) => method === 'invoke').length, 1);
    const updateCalls = harness.calls.filter(({ method }) => method === 'update');
    assert.deepEqual(updateCalls[0].environment, {
      ...original.Environment.Variables,
      [SQL53_CONFIG_AUTHORIZATION_ENV]: AUTH_TOKEN,
      [SQL53_CONFIG_EXPIRY_ENV]: new Date(NOW + 60_000).toISOString(),
    });
    assert.deepEqual(updateCalls[1].environment, original.Environment.Variables);
    assert.ok(updateCalls.every((call) => call.revisionId));
    assert.deepEqual(harness.state.Environment.Variables, original.Environment.Variables);
    assert.equal(harness.state.Role, original.Role);
    assert.equal(harness.state.Runtime, original.Runtime);
    const invoke = harness.calls.find(({ method }) => method === 'invoke');
    assert.deepEqual(invoke.payload, {
      diagnostic: 'sql53-production-readonly-inspect',
      authorization: AUTH_TOKEN,
    });
    const printed = JSON.stringify(result);
    assert.equal(printed.includes(AUTH_TOKEN), false);
    assert.equal(printed.includes('private-setting'), false);
    assert.equal(printed.includes('must not be returned'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale and concurrent fingerprints prevent configuration changes and invocation', async () => {
  const staleRoot = tempRoot();
  const concurrentRoot = tempRoot();
  try {
    const original = configuration();
    const stale = makeHarness({ initial: original });
    const staleBaseline = configuration({ RevisionId: 'stale-revision' });
    const staleInput = signedInput(staleRoot, staleBaseline);
    const staleResult = await runWriter(staleRoot, staleInput, stale.aws);
    assert.equal(staleResult.ok, false);
    assert.match(staleResult.message, /changed since the signed preflight/);
    assert.equal(stale.updates, 0);
    assert.equal(stale.calls.some(({ method }) => method === 'invoke'), false);

    const concurrent = makeHarness({
      initial: original,
      beforeGet: ({ state, reads }) => {
        if (reads === 2) {
          state.RevisionId = 'concurrent-revision';
          state.Description = 'concurrent edit';
        }
      },
    });
    const concurrentResult = await runWriter(concurrentRoot, signedInput(concurrentRoot, original), concurrent.aws);
    assert.equal(concurrentResult.ok, false);
    assert.match(concurrentResult.message, /changed before the guarded update/);
    assert.equal(concurrent.updates, 0);
    assert.equal(concurrent.calls.some(({ method }) => method === 'invoke'), false);
  } finally {
    fs.rmSync(staleRoot, { recursive: true, force: true });
    fs.rmSync(concurrentRoot, { recursive: true, force: true });
  }
});

test('expired temporary authorization is refused before any AWS access', async () => {
  const root = tempRoot();
  try {
    const original = configuration();
    const harness = makeHarness({ initial: original });
    const input = signedInput(root, original, {
      authorization_expires_at: new Date(NOW - 1).toISOString(),
    });
    const result = await runWriter(root, input, harness.aws);
    assert.equal(result.ok, false);
    assert.match(result.message, /expiry is expired/);
    assert.equal(harness.calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a non-dedicated production identity cannot read or change Lambda configuration', async () => {
  const root = tempRoot();
  try {
    const original = configuration();
    const harness = makeHarness({ initial: original });
    harness.aws.getCallerIdentity = async () => {
      harness.calls.push({ method: 'identity' });
      return {
        Account: '806168576068',
        Arn: 'arn:aws:sts::806168576068:assumed-role/checksops-staging-deploy/session-test',
      };
    };
    const result = await runWriter(root, signedInput(root, original), harness.aws);
    assert.equal(result.ok, false);
    assert.match(result.message, /dedicated production execution role/);
    assert.deepEqual(harness.calls.map(({ method }) => method), ['identity']);
    assert.equal(harness.updates, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a RevisionId race at the write boundary refuses invocation', async () => {
  const root = tempRoot();
  try {
    const original = configuration();
    const harness = makeHarness({
      initial: original,
      beforeUpdate: ({ state, updates }) => {
        if (updates === 1) state.RevisionId = 'revision-changed-after-read';
      },
    });
    const result = await runWriter(root, signedInput(root, original), harness.aws);
    assert.equal(result.ok, false);
    assert.match(result.message, /invocation or temporary configuration update failed/);
    assert.equal(result.details.authorization_cleanup_verified, true);
    assert.equal(harness.calls.some(({ method }) => method === 'invoke'), false);
    assert.equal(harness.state.Environment.Variables[SQL53_CONFIG_AUTHORIZATION_ENV], undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed invocation still performs and verifies cleanup', async () => {
  const root = tempRoot();
  try {
    const original = configuration();
    const harness = makeHarness({
      initial: original,
      invoke: async () => ({
        FunctionError: 'Unhandled',
        StatusCode: 200,
        Payload: Buffer.from('{"errorMessage":"private failure"}'),
      }),
    });
    const result = await runWriter(root, signedInput(root, original), harness.aws);
    assert.equal(result.ok, false);
    assert.match(result.message, /invocation or temporary configuration update failed/);
    assert.equal(result.details.authorization_cleanup_verified, true);
    assert.equal(result.details.cleanup.complete, true);
    assert.equal(harness.state.Environment.Variables[SQL53_CONFIG_AUTHORIZATION_ENV], undefined);
    assert.equal(harness.state.Environment.Variables[SQL53_CONFIG_EXPIRY_ENV], undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('partial configuration update is cleaned even when the update call throws', async () => {
  const root = tempRoot();
  try {
    const original = configuration();
    const harness = makeHarness({
      initial: original,
      beforeUpdate: ({ state, input, updates }) => {
        if (updates === 1) {
          state.Environment = { Variables: structuredClone(input.environment) };
          state.RevisionId = 'partial-update-revision';
          throw new Error('response lost after the update applied');
        }
      },
    });
    const result = await runWriter(root, signedInput(root, original), harness.aws);
    assert.equal(result.ok, false);
    assert.equal(result.details.authorization_cleanup_verified, true);
    assert.equal(result.details.cleanup.complete, true);
    assert.equal(harness.state.Environment.Variables[SQL53_CONFIG_AUTHORIZATION_ENV], undefined);
    assert.equal(harness.state.Environment.Variables.KEEP, 'private-setting');
    assert.equal(harness.calls.some(({ method }) => method === 'invoke'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup failure is independently detected and reported fail-closed', async () => {
  const root = tempRoot();
  try {
    const original = configuration();
    const harness = makeHarness({
      initial: original,
      beforeUpdate: ({ updates }) => {
        if (updates > 1) throw new Error('cleanup refused');
      },
    });
    const result = await runWriter(root, signedInput(root, original), harness.aws);
    assert.equal(result.ok, false);
    assert.match(result.message, /cleanup is incomplete/);
    assert.equal(result.details.cleanup.complete, false);
    assert.equal(result.details.cleanup.attempts, 3);
    assert.equal(harness.state.Environment.Variables[SQL53_CONFIG_AUTHORIZATION_ENV], AUTH_TOKEN);
    assert.equal(harness.calls.filter(({ method }) => method === 'update').length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unauthorized concurrent settings drift is preserved, authorization is removed, and result fails', async () => {
  const root = tempRoot();
  try {
    const original = configuration();
    const harness = makeHarness({
      initial: original,
      invoke: async () => {
        harness.state.Description = 'concurrent change preserved';
        harness.state.Environment.Variables.OTHER = 'concurrent env change';
        harness.state.RevisionId = 'concurrent-during-invoke';
        return { StatusCode: 200, Payload: Buffer.from(JSON.stringify(inspectionPayload())) };
      },
    });
    const result = await runWriter(root, signedInput(root, original), harness.aws);
    assert.equal(result.ok, false);
    assert.match(result.message, /unexpected production Lambda configuration drift/);
    assert.equal(result.details.authorization_cleanup_verified, true);
    assert.equal(harness.state.Environment.Variables.KEEP, 'private-setting');
    assert.equal(harness.state.Environment.Variables.OTHER, 'concurrent env change');
    assert.equal(harness.state.Environment.Variables[SQL53_CONFIG_AUTHORIZATION_ENV], undefined);
    assert.equal(harness.state.Description, 'concurrent change preserved');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function liveIndexEnvelope(payload = inspectionPayload()) {
  return {
    statusCode: payload.statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload.body),
  };
}

function invokeResult(payload, extras = {}) {
  return {
    StatusCode: 200,
    Payload: Buffer.from(JSON.stringify(payload)),
    ...extras,
  };
}

test('live production index hook still stringifies the SQL53 inspect body', () => {
  const index = fs.readFileSync(path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../functions/api/index.mjs',
  ), 'utf8');
  assert.match(index, /if \(isSql53ProductionReadonlyInspectEvent\(event\)\) \{\n    const result = await handleSql53ProductionReadonlyInspect\(event\);\n    return json\(result\.statusCode, result\.body\);/);
});

test('official writer accepts object and stringified SQL53 inspect bodies', () => {
  const objectParsed = parseSql53InspectionResponse(invokeResult(inspectionPayload()));
  const stringParsed = parseSql53InspectionResponse(invokeResult(liveIndexEnvelope()));
  assert.equal(objectParsed.status, 'complete');
  assert.deepEqual(objectParsed, stringParsed);
  assert.equal(objectParsed.inspect.functions.length, 4);
  assert.equal(objectParsed.inspect.settlementColumns.length, 17);
  assert.equal(objectParsed.inspect.ledgerTriggers.length, 3);
  assert.equal(JSON.stringify(objectParsed).includes('must not be returned'), false);
});

test('official writer refuses malformed, incomplete, and unsuccessful inspect envelopes', () => {
  assert.throws(
    () => parseSql53InspectionResponse({ Payload: Buffer.from('{not-json') }),
    /lambda_invocation_response_invalid/,
  );
  assert.throws(
    () => parseSql53InspectionResponse(invokeResult({
      statusCode: 200,
      body: '{not-json',
    })),
    /lambda_invocation_response_invalid/,
  );
  assert.throws(
    () => parseSql53InspectionResponse(invokeResult({
      statusCode: 200,
      body: JSON.stringify(['not', 'an', 'object']),
    })),
    /lambda_invocation_response_invalid/,
  );
  assert.throws(
    () => parseSql53InspectionResponse({
      FunctionError: 'Unhandled',
      Payload: Buffer.from(JSON.stringify(liveIndexEnvelope())),
    }),
    /lambda_invocation_failed/,
  );
  assert.throws(
    () => parseSql53InspectionResponse(invokeResult({
      ...liveIndexEnvelope(),
      FunctionError: 'Unhandled',
    })),
    /lambda_invocation_failed/,
  );
  assert.throws(
    () => parseSql53InspectionResponse(invokeResult({
      statusCode: 403,
      body: JSON.stringify({
        status: 'refused',
        reason: 'sql53 inspect authorization is missing or invalid; database was not contacted',
        rdsIdentifier: null,
        inspect: null,
      }),
    })),
    /lambda_invocation_incomplete/,
  );
  const missingResults = inspectionPayload();
  missingResults.body.inspect.functions = missingResults.body.inspect.functions.slice(0, 2);
  assert.throws(
    () => parseSql53InspectionResponse(invokeResult(liveIndexEnvelope(missingResults))),
    /lambda_invocation_incomplete/,
  );
  const incompleteExists = inspectionPayload();
  delete incompleteExists.body.inspect.functions[0].exists;
  assert.throws(
    () => parseSql53InspectionResponse(invokeResult(liveIndexEnvelope(incompleteExists))),
    /lambda_invocation_response_invalid/,
  );
});

test('temporary config writer accepts the live stringified inspect envelope and still cleans up', async () => {
  const root = tempRoot();
  try {
    const original = configuration();
    const harness = makeHarness({
      initial: original,
      invoke: async () => invokeResult(liveIndexEnvelope()),
    });
    const result = await runWriter(root, signedInput(root, original), harness.aws);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.details.inspection.status, 'complete');
    assert.equal(result.details.inspection.inspect.functions.length, 4);
    assert.equal(result.details.cleanup.complete, true);
    assert.equal(harness.state.Environment.Variables[SQL53_CONFIG_AUTHORIZATION_ENV], undefined);
    assert.equal(harness.state.Environment.Variables[SQL53_CONFIG_EXPIRY_ENV], undefined);
    assert.equal(JSON.stringify(result).includes(AUTH_TOKEN), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
