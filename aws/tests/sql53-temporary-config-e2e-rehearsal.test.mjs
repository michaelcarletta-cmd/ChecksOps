import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SQL53_CONFIG_AUTHORIZATION_ENV,
  SQL53_CONFIG_DEPLOYMENT_TYPE,
  SQL53_CONFIG_EXPIRY_ENV,
  SQL53_CONFIG_FUNCTION,
  applySql53TemporaryLambdaConfig,
  fingerprintSql53LambdaConfiguration,
} from '../../scripts/deployment-guard/lib/sql53-temporary-lambda-config.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';

register('./helpers/pg-ci-stub-hooks.mjs', import.meta.url);
const {
  SQL53_FUNCTION_DEF_INSPECT_SQL,
  SQL53_LEDGER_TRIGGER_INSPECT_SQL,
  SQL53_PINNED_FUNCTION_LOOKUPS,
  SQL53_REQUIRED_LEDGER_TRIGGERS,
  SQL53_REQUIRED_SETTLEMENT_COLUMNS,
  SQL53_SETTLEMENT_COLUMN_INSPECT_SQL,
  handleSql53ProductionReadonlyInspect,
  hashSql53Definition,
  hashSql53PackageMember,
} = await import('../functions/api/sql53-production-readonly-inspect.mjs');

const NOW = Date.now();
const WORKSTREAM = 'prod-sql53-temporary-config-3bc9';
const OTHER_WORKSTREAM = 'unrelated-production-workstream';
const COMMIT = 'c'.repeat(40);
const AUTH_TOKEN = 'd'.repeat(64);
const ENV = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' };
const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../functions/api');
const SECRET_BODY = 'CREATE FUNCTION public.save_claim_settlement_breakdown(uuid,uuid,jsonb) RETURNS jsonb AS $$ SELECT 1 $$';
const DEFINITION_SHA = hashSql53Definition(SECRET_BODY);

function liveJson(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

function sdkMetadata(requestId) {
  return {
    httpStatusCode: 200,
    requestId,
    attempts: 1,
    totalRetryDelay: 0,
    extendedRequestId: undefined,
  };
}

function liveShapedConfiguration(overrides = {}) {
  return {
    FunctionName: SQL53_CONFIG_FUNCTION,
    FunctionArn: 'arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api',
    Runtime: 'nodejs22.x',
    Role: 'arn:aws:iam::806168576068:role/checksops-production-api-execution',
    Handler: 'index.handler',
    CodeSize: 11124536,
    Description: 'rehearsal-only sanitized production-prep shape',
    Timeout: 45,
    MemorySize: 1024,
    LastModified: '2026-10-11T00:55:17.000+0000',
    CodeSha256: 'oQDCIRFyreTPe781aeSFLdXNfU3M2ZUQo5Wcgi0EqWI=',
    Version: '$LATEST',
    VpcConfig: {
      SubnetIds: ['subnet-aaa', 'subnet-bbb'],
      SecurityGroupIds: ['sg-aaa', 'sg-bbb'],
      VpcId: 'vpc-aaa',
      Ipv6AllowedForDualStack: false,
    },
    Environment: {
      Variables: {
        CHECKSOPS_ENV: 'production-prep',
        KEEP: 'private-setting',
        DATABASE_NAME: 'checksops',
      },
    },
    TracingConfig: { Mode: 'Active' },
    RevisionId: 'd49b27cc-3dcb-48ab-8490-206097172689',
    State: 'Active',
    LastUpdateStatus: 'Successful',
    PackageType: 'Zip',
    Architectures: ['arm64'],
    EphemeralStorage: { Size: 512 },
    SnapStart: { ApplyOn: 'None', OptimizationStatus: 'Off' },
    RuntimeVersionConfig: {
      RuntimeVersionArn: 'arn:aws:lambda:us-east-1::runtime:rehearsal',
    },
    LoggingConfig: {
      LogFormat: 'Text',
      LogGroup: '/aws/lambda/checksops-production-prep-api',
    },
    $metadata: sdkMetadata('initial'),
    ...overrides,
  };
}

function catalogClient({ missingFunction = false, missingColumn = false } = {}) {
  return {
    connected: false,
    queries: [],
    async connect() {
      this.connected = true;
    },
    async end() {
      this.connected = false;
    },
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('current_database()')) {
        return {
          rows: [{
            current_database: 'checksops',
            current_user: 'checksops',
            transaction_read_only: 'on',
            default_transaction_read_only: 'on',
          }],
        };
      }
      if (sql === SQL53_FUNCTION_DEF_INSPECT_SQL) {
        if (missingFunction && params?.[1] === 'hle_on_check_intake_insert') return { rows: [] };
        return { rows: [{ schema_name: 'public', function_name: params[1], def: SECRET_BODY }] };
      }
      if (sql === SQL53_SETTLEMENT_COLUMN_INSPECT_SQL) {
        const columns = missingColumn
          ? SQL53_REQUIRED_SETTLEMENT_COLUMNS.filter((column) => column !== 'ale_rcv')
          : [...SQL53_REQUIRED_SETTLEMENT_COLUMNS];
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      if (sql === SQL53_LEDGER_TRIGGER_INSPECT_SQL) {
        return {
          rows: SQL53_REQUIRED_LEDGER_TRIGGERS.map((row) => ({
            table_name: row.table,
            trigger_name: row.trigger,
          })),
        };
      }
      throw new Error(`unexpected sql ${sql}`);
    },
  };
}

async function invokeThroughLiveIndex(event, env, clientFactory) {
  const result = await handleSql53ProductionReadonlyInspect(event, {
    env,
    loadCredentials: async () => ({
      username: 'checksops',
      host: 'checksops-production.c0fakehash.us-east-1.rds.amazonaws.com',
      password: 'unit-test-only-not-a-real-secret',
    }),
    createClient: clientFactory,
    hashMember: (name) => hashSql53PackageMember(name, API),
  });
  return liveJson(result.statusCode, result.body);
}

function makeSdkHarness({
  initial = liveShapedConfiguration(),
  invoke,
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
        UserId: 'AROAEXAMPLE:sql53-e2e-rehearsal',
        Arn: 'arn:aws:sts::806168576068:assumed-role/ChecksOpsProductionSql53ConfigWriter/sql53-e2e-rehearsal',
      };
    },
    async getFunctionConfiguration({ functionName }) {
      reads += 1;
      await beforeGet?.({ state, reads, updates });
      if (state.LastUpdateStatus === 'InProgress') {
        state.LastUpdateStatus = 'Successful';
      }
      const configuration = structuredClone(state);
      configuration.$metadata = sdkMetadata(`get-${reads}`);
      calls.push({ method: 'read', functionName, requestId: configuration.$metadata.requestId });
      return configuration;
    },
    async updateFunctionConfiguration(input) {
      updates += 1;
      calls.push({ method: 'update', ...structuredClone(input) });
      await beforeUpdate?.({ state, input, updates });
      if (input.functionName !== SQL53_CONFIG_FUNCTION || input.revisionId !== state.RevisionId) {
        throw new Error('RevisionId conflict');
      }
      state.Environment = { Variables: structuredClone(input.environment) };
      state.RevisionId = `revision-after-${updates}`;
      state.LastModified = `2026-10-11T01:4${updates}:00.000+0000`;
      state.LastUpdateStatus = 'InProgress';
      const configuration = structuredClone(state);
      configuration.$metadata = sdkMetadata(`update-${updates}`);
      return configuration;
    },
    async invokeFunction(input) {
      calls.push({ method: 'invoke', ...structuredClone(input) });
      const result = await invoke(input, state);
      return {
        StatusCode: result.StatusCode ?? 200,
        ExecutedVersion: '$LATEST',
        Payload: result.Payload instanceof Uint8Array
          ? result.Payload
          : new Uint8Array(Buffer.from(result.Payload || [])),
        FunctionError: result.FunctionError,
        $metadata: sdkMetadata(`invoke-${calls.length}`),
      };
    },
  };
  return { aws, calls, state, get reads() { return reads; }, get updates() { return updates; } };
}

function signedInput(root, liveConfiguration, overrides = {}) {
  const fingerprint = fingerprintSql53LambdaConfiguration(liveConfiguration);
  assert.equal(fingerprint.ok, true, fingerprint.message);
  const lease = acquireLease(root, {
    workstream_id: WORKSTREAM,
    component: SQL53_CONFIG_FUNCTION,
    environment: 'production',
    commit: COMMIT,
  }, NOW);
  assert.equal(lease.ok, true, lease.message);
  const issued = issueReceipt(root, {
    workstream_id: WORKSTREAM,
    branch: 'cursor/prod-sql53-e2e-audit-3bc9',
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
    staging_acceptance: {
      ok: true,
      inherited: false,
      reference: 'prod-sql53-temporary-config-3bc9:acceptance:sql53-writer+sql53-readonly-inspect+tenant-isolation',
    },
    authorization_window_ms: 30 * 60 * 1000,
    ...overrides,
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql53-e2e-'));
}

async function runWriter(root, input, aws, overrides = {}) {
  return applySql53TemporaryLambdaConfig(input, {
    env: ENV,
    guardRoot: root,
    aws,
    now: NOW,
    createAuthorizationToken: () => AUTH_TOKEN,
    waitAttempts: 4,
    waitDelayMs: 0,
    cleanupAttempts: 3,
    ...overrides,
  });
}

function successfulLiveInvoke() {
  return async (input, state) => {
    const env = {
      ...state.Environment.Variables,
      AWS_LAMBDA_FUNCTION_NAME: SQL53_CONFIG_FUNCTION,
    };
    const payload = await invokeThroughLiveIndex(input.payload, env, () => catalogClient());
    return { Payload: Buffer.from(JSON.stringify(payload)) };
  };
}

test('SDK-shaped consecutive fingerprints stay stable across $metadata and wait for Successful', () => {
  const first = fingerprintSql53LambdaConfiguration(liveShapedConfiguration({
    $metadata: sdkMetadata('req-a'),
  }));
  const second = fingerprintSql53LambdaConfiguration(liveShapedConfiguration({
    $metadata: sdkMetadata('req-b'),
    LastModified: '2026-10-11T00:55:18.000+0000',
    LastUpdateStatus: 'Successful',
    RevisionId: 'd49b27cc-3dcb-48ab-8490-206097172689',
  }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(
    first.details.fingerprint.configuration_sha256,
    second.details.fingerprint.configuration_sha256,
  );
});

test('full writer rehearsal accepts production-prep live inspect envelope and cleans up', async () => {
  const root = tempRoot();
  try {
    const original = liveShapedConfiguration();
    const harness = makeSdkHarness({
      initial: original,
      invoke: successfulLiveInvoke(),
    });
    const result = await runWriter(root, signedInput(root, original), harness.aws);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.details.inspection.status, 'complete');
    assert.equal(result.details.inspection.rdsIdentifier, 'checksops-production');
    assert.equal(result.details.inspection.inspect.functions.length, 4);
    assert.equal(result.details.inspection.inspect.settlementColumns.length, 17);
    assert.equal(result.details.inspection.inspect.ledgerTriggers.length, 3);
    assert.deepEqual(
      result.details.inspection.inspect.functions.map((row) => row.identity),
      SQL53_PINNED_FUNCTION_LOOKUPS.map((row) => row.identity),
    );
    assert.equal(result.details.inspection.inspect.functions.every((row) => row.exists === true), true);
    assert.equal(result.details.inspection.inspect.functions[0].definitionSha256, DEFINITION_SHA);
    assert.equal(result.details.cleanup.complete, true);
    assert.equal(harness.state.Environment.Variables[SQL53_CONFIG_AUTHORIZATION_ENV], undefined);
    assert.equal(harness.state.Environment.Variables[SQL53_CONFIG_EXPIRY_ENV], undefined);
    assert.equal(harness.state.Environment.Variables.CHECKSOPS_ENV, 'production-prep');
    assert.equal(harness.state.Environment.Variables.KEEP, 'private-setting');
    assert.equal(harness.calls.some(({ method }) => method === 'invoke'), true);
    assert.equal(JSON.stringify(result).includes(AUTH_TOKEN), false);
    assert.equal(JSON.stringify(result).includes('private-setting'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rehearsal reports missing SQL53 objects as exists false without failing closed', async () => {
  const root = tempRoot();
  try {
    const original = liveShapedConfiguration();
    const harness = makeSdkHarness({
      initial: original,
      invoke: async (input, state) => {
        const env = {
          ...state.Environment.Variables,
          AWS_LAMBDA_FUNCTION_NAME: SQL53_CONFIG_FUNCTION,
        };
        const payload = await invokeThroughLiveIndex(
          input.payload,
          env,
          () => catalogClient({ missingFunction: true, missingColumn: true }),
        );
        return { Payload: Buffer.from(JSON.stringify(payload)) };
      },
    });
    const result = await runWriter(root, signedInput(root, original), harness.aws);
    assert.equal(result.ok, true, result.message);
    const missingFn = result.details.inspection.inspect.functions.find(
      (row) => row.identity === 'public.hle_on_check_intake_insert()',
    );
    const missingCol = result.details.inspection.inspect.settlementColumns.find((row) => row.column === 'ale_rcv');
    assert.equal(missingFn.exists, false);
    assert.equal(missingFn.definitionSha256, null);
    assert.equal(missingCol.exists, false);
    assert.equal(result.details.cleanup.complete, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rehearsal FunctionError, malformed body, and refused inspect still clean up', async () => {
  for (const [name, invoke] of [
    ['function-error', async () => ({
      FunctionError: 'Unhandled',
      Payload: Buffer.from('{"errorMessage":"private failure"}'),
    })],
    ['malformed-json', async () => ({
      Payload: Buffer.from('{not-json'),
    })],
    ['auth-refused', async (input, state) => {
      const env = {
        ...state.Environment.Variables,
        AWS_LAMBDA_FUNCTION_NAME: SQL53_CONFIG_FUNCTION,
      };
      delete env[SQL53_CONFIG_AUTHORIZATION_ENV];
      const payload = await invokeThroughLiveIndex(input.payload, env, () => {
        throw new Error('database must not be contacted');
      });
      return { Payload: Buffer.from(JSON.stringify(payload)) };
    }],
  ]) {
    const root = tempRoot();
    try {
      const original = liveShapedConfiguration();
      const harness = makeSdkHarness({ initial: original, invoke });
      const result = await runWriter(root, signedInput(root, original), harness.aws);
      assert.equal(result.ok, false, name);
      assert.match(result.message, /invocation or temporary configuration update failed|authorization/);
      assert.equal(result.details.cleanup.complete, true, name);
      assert.equal(harness.state.Environment.Variables[SQL53_CONFIG_AUTHORIZATION_ENV], undefined, name);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('consumed receipt cannot authorize a second rehearsal apply', async () => {
  const root = tempRoot();
  try {
    const original = liveShapedConfiguration();
    const input = signedInput(root, original);
    const first = makeSdkHarness({ initial: original, invoke: successfulLiveInvoke() });
    const firstResult = await runWriter(root, input, first.aws);
    assert.equal(firstResult.ok, true, firstResult.message);
    const second = makeSdkHarness({ initial: original, invoke: successfulLiveInvoke() });
    const secondResult = await runWriter(root, input, second.aws);
    assert.equal(secondResult.ok, false);
    assert.match(secondResult.message, /already been consumed|fresh receipt/);
    assert.equal(second.updates, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('another workstream holding the exclusive lease blocks rehearsal apply', async () => {
  const root = tempRoot();
  try {
    const original = liveShapedConfiguration();
    const input = signedInput(root, original);
    const other = acquireLease(root, {
      workstream_id: OTHER_WORKSTREAM,
      component: SQL53_CONFIG_FUNCTION,
      environment: 'production',
      commit: 'e'.repeat(40),
    }, NOW);
    assert.equal(other.ok, false);
    assert.match(String(other.message || other.code || ''), /held|LEASE_HELD|another/i);
    const leasePath = path.join(root, '.deployment-guard', 'leases', 'production::checksops-production-prep-api.json');
    fs.writeFileSync(leasePath, `${JSON.stringify({
      workstream_id: OTHER_WORKSTREAM,
      component: SQL53_CONFIG_FUNCTION,
      environment: 'production',
      acquired_at: new Date(NOW).toISOString(),
      expiry: new Date(NOW + 15 * 60 * 1000).toISOString(),
      commit: 'e'.repeat(40),
      operator: 'other-operator',
    }, null, 2)}\n`);
    const harness = makeSdkHarness({ initial: original, invoke: successfulLiveInvoke() });
    const result = await runWriter(root, input, harness.aws);
    assert.equal(result.ok, false);
    assert.match(result.message, /another workstream|active lease|LEASE_HELD|held by/i);
    assert.equal(harness.updates, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RevisionId and configuration fingerprint mismatches refuse before invoke', async () => {
  const staleRoot = tempRoot();
  const raceRoot = tempRoot();
  try {
    const original = liveShapedConfiguration();
    const staleHarness = makeSdkHarness({ initial: original, invoke: successfulLiveInvoke() });
    const staleBaseline = liveShapedConfiguration({ RevisionId: 'old-revision' });
    const stale = await runWriter(staleRoot, signedInput(staleRoot, staleBaseline), staleHarness.aws);
    assert.equal(stale.ok, false);
    assert.match(stale.message, /changed since the signed preflight/);
    assert.equal(staleHarness.updates, 0);

    const race = makeSdkHarness({
      initial: original,
      invoke: successfulLiveInvoke(),
      beforeUpdate: ({ state, updates }) => {
        if (updates === 1) state.RevisionId = 'changed-after-read';
      },
    });
    const raced = await runWriter(raceRoot, signedInput(raceRoot, original), race.aws);
    assert.equal(raced.ok, false);
    assert.equal(raced.details.cleanup.complete, true);
    assert.equal(race.calls.some(({ method }) => method === 'invoke'), false);
    assert.equal(race.state.Environment.Variables[SQL53_CONFIG_AUTHORIZATION_ENV], undefined);
  } finally {
    fs.rmSync(staleRoot, { recursive: true, force: true });
    fs.rmSync(raceRoot, { recursive: true, force: true });
  }
});
