import { createHash, randomBytes } from 'node:crypto';
import { consumeReceiptOnce } from './consumed-receipts.mjs';
import { CODES, fail, ok } from './errors.mjs';
import { evaluateProductionGate } from './production.mjs';
import { refuseUnguardedDeploy } from '../require-guard.mjs';

export const SQL53_CONFIG_FUNCTION = 'checksops-production-prep-api';
export const SQL53_CONFIG_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api';
export const SQL53_CONFIG_ENV = 'production';
export const SQL53_CONFIG_DEPLOYMENT_TYPE = 'lambda-sql53-temporary-config';
export const SQL53_CONFIG_AUTHORIZATION_ENV = 'CHECKSOPS_SQL53_READONLY_INSPECT_AUTHORIZATION';
export const SQL53_CONFIG_EXPIRY_ENV = 'CHECKSOPS_SQL53_READONLY_INSPECT_EXPIRES_AT';
export const SQL53_CONFIG_DIAGNOSTIC = 'sql53-production-readonly-inspect';
export const SQL53_CONFIG_MAX_WINDOW_MS = 2 * 60 * 60 * 1000;
export const SQL53_CONFIG_DEFAULT_WINDOW_MS = 5 * 60 * 1000;
export const SQL53_CONFIG_ROLE_ARN = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSql53ConfigWriter';

const TRANSIENT_CONFIGURATION_KEYS = new Set([
  'LastModified',
  'LastUpdateStatus',
  'LastUpdateStatusReason',
  'LastUpdateStatusReasonCode',
  'RevisionId',
  'State',
  'StateReason',
  'StateReasonCode',
  'ResponseMetadata',
  '$metadata',
]);

export const SQL53_CONFIG_EXPECTED_FUNCTIONS = Object.freeze([
  'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)',
  'public.sync_homeowner_ledger_from_check()',
  'public.aws_can_write_claim(uuid)',
  'public.hle_on_check_intake_insert()',
]);
export const SQL53_CONFIG_EXPECTED_COLUMNS = Object.freeze([
  'replacement_cost_value',
  'recoverable_depreciation',
  'non_recoverable_depreciation',
  'deductible',
  'other_structures_rcv',
  'other_structures_recoverable_depreciation',
  'other_structures_non_recoverable_depreciation',
  'other_structures_deductible',
  'pwi_rcv',
  'pwi_recoverable_depreciation',
  'pwi_non_recoverable_depreciation',
  'personal_property_rcv',
  'personal_property_recoverable_depreciation',
  'personal_property_non_recoverable_depreciation',
  'ale_rcv',
  'ale_recoverable_depreciation',
  'ale_non_recoverable_depreciation',
]);
export const SQL53_CONFIG_EXPECTED_TRIGGERS = Object.freeze([
  'trg_sync_homeowner_ledger_ins',
  'trg_sync_homeowner_ledger_upd',
  'trg_hle_check_intake_insert',
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function configHash(configuration) {
  const stable = Object.fromEntries(
    Object.entries(configuration).filter(([key]) => !TRANSIENT_CONFIGURATION_KEYS.has(key)),
  );
  return createHash('sha256').update(stableJson(stable)).digest('hex');
}

export function fingerprintSql53LambdaConfiguration(input = {}) {
  const configuration = input.Configuration || input.configuration || input;
  const functionName = configuration.FunctionName || input.function_name || null;
  const functionArn = configuration.FunctionArn || null;
  const revisionId = configuration.RevisionId || input.revisionId || null;
  if (functionName !== SQL53_CONFIG_FUNCTION || functionArn !== SQL53_CONFIG_FUNCTION_ARN || !revisionId) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'production Lambda configuration identity or RevisionId is missing');
  }
  if (configuration.Environment?.Error) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'production Lambda environment could not be read completely');
  }
  const variables = configuration.Environment?.Variables || {};
  if (!variables || Array.isArray(variables) || typeof variables !== 'object'
    || Object.values(variables).some((value) => typeof value !== 'string')) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'production Lambda environment has an invalid shape');
  }
  return ok({
    fingerprint: {
      function_name: functionName,
      code_sha256: configuration.CodeSha256 || null,
      revision_id: revisionId,
      configuration_sha256: configHash(configuration),
    },
    configuration,
    variables,
  });
}

function fingerprintsEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

export function isSql53ConfigWriterIdentity(identity) {
  const expectedArn = SQL53_CONFIG_ROLE_ARN
    .replace(':iam::', ':sts::')
    .replace(':role/', ':assumed-role/');
  const expected = new RegExp(`^${expectedArn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/[^/]+$`);
  return identity?.Account === '806168576068' && expected.test(String(identity?.Arn || ''));
}

function authorizationExpiry(input, now) {
  if (input.authorization_expires_at != null) {
    const value = String(input.authorization_expires_at);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
    const expiry = Date.parse(value);
    if (!Number.isFinite(expiry) || expiry <= now || expiry > now + SQL53_CONFIG_MAX_WINDOW_MS) return null;
    return new Date(expiry).toISOString();
  }
  const windowMs = Number(input.authorization_window_ms ?? SQL53_CONFIG_DEFAULT_WINDOW_MS);
  if (!Number.isInteger(windowMs) || windowMs <= 0 || windowMs > SQL53_CONFIG_MAX_WINDOW_MS) return null;
  return new Date(now + windowMs).toISOString();
}

function configurationWithVariables(configuration, variables) {
  return {
    ...configuration,
    Environment: {
      ...(configuration.Environment || {}),
      Variables: { ...variables },
    },
  };
}

function normalizeAdapterResult(value) {
  if (value?.ok === false) throw new Error('adapter_operation_failed');
  return value?.ok === true ? (value.details?.configuration || value.details) : value;
}

async function getConfiguration(aws) {
  const result = await aws.getFunctionConfiguration({ functionName: SQL53_CONFIG_FUNCTION });
  const configuration = normalizeAdapterResult(result);
  if (!configuration || typeof configuration !== 'object') throw new Error('configuration_read_failed');
  return configuration;
}

async function waitForUpdate(aws, { attempts = 20, delayMs = 1000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const configuration = await getConfiguration(aws);
    const status = configuration.LastUpdateStatus;
    if (!status || status === 'Successful') return configuration;
    if (status === 'Failed') throw new Error('lambda_update_failed');
    if (attempt + 1 < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('lambda_update_timeout');
}

function parseInspection(invokeResult) {
  const result = normalizeAdapterResult(invokeResult) || {};
  if (result.FunctionError) throw new Error('lambda_invocation_failed');
  let payload = result.Payload;
  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) payload = Buffer.from(payload).toString('utf8');
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw new Error('lambda_invocation_response_invalid');
    }
  }
  const body = payload?.body;
  const inspection = body?.inspect;
  if (payload?.statusCode !== 200
    || body?.status !== 'complete'
    || body?.rdsIdentifier !== 'checksops-production'
    || inspection?.readOnly !== true
    || !Array.isArray(inspection.functions) || inspection.functions.length !== 4
    || !Array.isArray(inspection.settlementColumns) || inspection.settlementColumns.length !== 17
    || !Array.isArray(inspection.ledgerTriggers) || inspection.ledgerTriggers.length !== 3) {
    throw new Error('lambda_invocation_incomplete');
  }
  const functions = inspection.functions.map((row) => {
    if (!SQL53_CONFIG_EXPECTED_FUNCTIONS.includes(row?.identity) || typeof row.exists !== 'boolean'
      || (row.exists && !/^[0-9a-f]{64}$/.test(String(row.definitionSha256 || '')))
      || (!row.exists && row.definitionSha256 !== null)) {
      throw new Error('lambda_invocation_response_invalid');
    }
    return {
      identity: row.identity,
      exists: row.exists,
      definitionSha256: row.definitionSha256,
    };
  });
  const settlementColumns = inspection.settlementColumns.map((row) => {
    if (row?.table !== 'claim_settlements' || !SQL53_CONFIG_EXPECTED_COLUMNS.includes(row.column)
      || typeof row.exists !== 'boolean') throw new Error('lambda_invocation_response_invalid');
    return { table: row.table, column: row.column, exists: row.exists };
  });
  const ledgerTriggers = inspection.ledgerTriggers.map((row) => {
    if (row?.table !== 'check_intake_items' || !SQL53_CONFIG_EXPECTED_TRIGGERS.includes(row.trigger)
      || typeof row.exists !== 'boolean') throw new Error('lambda_invocation_response_invalid');
    return { table: row.table, trigger: row.trigger, exists: row.exists };
  });
  if (new Set(functions.map((row) => row.identity)).size !== SQL53_CONFIG_EXPECTED_FUNCTIONS.length
    || new Set(settlementColumns.map((row) => row.column)).size !== SQL53_CONFIG_EXPECTED_COLUMNS.length
    || new Set(ledgerTriggers.map((row) => row.trigger)).size !== SQL53_CONFIG_EXPECTED_TRIGGERS.length) {
    throw new Error('lambda_invocation_response_incomplete');
  }
  return {
    status: 'complete',
    rdsIdentifier: 'checksops-production',
    inspect: { readOnly: true, functions, settlementColumns, ledgerTriggers },
  };
}

async function cleanupAuthorization(aws, authorization, ctx) {
  const attempts = ctx.cleanupAttempts || 3;
  let driftDetected = false;
  let lastFailure = 'cleanup_not_verified';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let current;
    try {
      current = await getConfiguration(aws);
    } catch {
      lastFailure = 'cleanup_configuration_read_failed';
      continue;
    }
    const snapshot = fingerprintSql53LambdaConfiguration(current);
    if (!snapshot.ok) {
      lastFailure = 'cleanup_configuration_invalid';
      continue;
    }
    const currentVars = snapshot.details.variables;
    const hasAuthorization = Object.hasOwn(currentVars, SQL53_CONFIG_AUTHORIZATION_ENV);
    const hasExpiry = Object.hasOwn(currentVars, SQL53_CONFIG_EXPIRY_ENV);
    if (!hasAuthorization && !hasExpiry) {
      if (snapshot.details.fingerprint.configuration_sha256 !== authorization.expectedBaseHash) {
        driftDetected = true;
      }
      return { complete: true, drift_detected: driftDetected, attempts: attempt + 1 };
    }
    if (snapshot.details.fingerprint.configuration_sha256 !== authorization.expectedTemporaryHash) {
      driftDetected = true;
    }
    if ((hasAuthorization && currentVars[SQL53_CONFIG_AUTHORIZATION_ENV] !== authorization.token)
      || (hasExpiry && currentVars[SQL53_CONFIG_EXPIRY_ENV] !== authorization.expiresAt)) {
      driftDetected = true;
    }
    const variables = { ...currentVars };
    delete variables[SQL53_CONFIG_AUTHORIZATION_ENV];
    delete variables[SQL53_CONFIG_EXPIRY_ENV];
    const expectedHash = configHash(configurationWithVariables(current, variables));
    try {
      await aws.updateFunctionConfiguration({
        functionName: SQL53_CONFIG_FUNCTION,
        environment: variables,
        revisionId: current.RevisionId,
      });
      await waitForUpdate(aws, {
        attempts: ctx.waitAttempts || 20,
        delayMs: ctx.waitDelayMs ?? 1000,
      });
    } catch {
      lastFailure = 'cleanup_update_failed';
      continue;
    }
    try {
      const verified = await getConfiguration(aws);
      const verifiedSnapshot = fingerprintSql53LambdaConfiguration(verified);
      if (verifiedSnapshot.ok
        && !Object.hasOwn(verifiedSnapshot.details.variables, SQL53_CONFIG_AUTHORIZATION_ENV)
        && !Object.hasOwn(verifiedSnapshot.details.variables, SQL53_CONFIG_EXPIRY_ENV)
        && verifiedSnapshot.details.fingerprint.configuration_sha256 === expectedHash) {
        return { complete: true, drift_detected: driftDetected, attempts: attempt + 1 };
      }
      lastFailure = 'cleanup_verification_mismatch';
      driftDetected = true;
    } catch {
      lastFailure = 'cleanup_verification_read_failed';
    }
  }
  return {
    complete: false,
    drift_detected: driftDetected,
    attempts,
    failure: lastFailure,
  };
}

export async function applySql53TemporaryLambdaConfig(input = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const guardRoot = ctx.guardRoot;
  const aws = ctx.aws;
  const now = typeof ctx.now === 'function' ? ctx.now() : (ctx.now ?? Date.now());

  if (input.apply !== true || env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY !== '1') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL53 temporary Lambda configuration requires explicit guarded apply authorization');
  }
  if (!guardRoot || !aws?.getCallerIdentity || !aws?.getFunctionConfiguration
    || !aws?.updateFunctionConfiguration || !aws?.invokeFunction) {
    return fail(CODES.INVALID_MANIFEST, 'SQL53 temporary Lambda writer requires its production AWS adapter and guard root');
  }
  if ((input.function_name != null && input.function_name !== SQL53_CONFIG_FUNCTION)
    || (input.target_environment != null && input.target_environment !== SQL53_CONFIG_ENV)
    || (input.target_component != null && input.target_component !== SQL53_CONFIG_FUNCTION)
    || (input.deployment_type != null && input.deployment_type !== SQL53_CONFIG_DEPLOYMENT_TYPE)) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL53 temporary configuration is pinned to the production prep Lambda');
  }
  const authorized = refuseUnguardedDeploy({
    target_environment: SQL53_CONFIG_ENV,
    target_component: SQL53_CONFIG_FUNCTION,
    deployment_type: SQL53_CONFIG_DEPLOYMENT_TYPE,
    workstream_id: input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID,
    commit: input.commit || env.CHECKSOPS_COMMIT,
    receipt: input.receipt,
    receipt_path: input.receipt_path,
  }, { root: guardRoot, now, env });
  if (!authorized.ok) return authorized;
  const receipt = authorized.details.receipt;
  if (receipt.owned_components.length !== 1
    || receipt.owned_components[0] !== SQL53_CONFIG_FUNCTION
    || Object.hasOwn(receipt, 'owned_member_ops')) {
    return fail(CODES.RECEIPT_MISMATCH, 'SQL53 configuration receipt must own only the pinned production Lambda');
  }
  if (input.environment_variables || input.env || input.payload || input.event) {
    return fail(CODES.UNRELATED_MUTATION, 'caller-supplied environment variables and invoke payloads are forbidden');
  }
  if (!input.approval || !input.staging_acceptance) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL53 production configuration requires explicit approval and staging acceptance');
  }

  const expiry = authorizationExpiry(input, now);
  if (!expiry) {
    return fail(CODES.RECEIPT_EXPIRED, 'temporary SQL53 authorization expiry is expired, invalid, or exceeds two hours');
  }
  const tokenFactory = ctx.createAuthorizationToken || (() => randomBytes(32).toString('hex'));
  const token = tokenFactory();
  if (typeof token !== 'string' || token.length < 32
    || token === 'OWNER_AUTHORIZED_PRODUCTION_SQL53_READONLY_INSPECT') {
    return fail(CODES.INVALID_MANIFEST, 'temporary SQL53 authorization token generator did not produce an acceptable token');
  }

  try {
    const identity = normalizeAdapterResult(await aws.getCallerIdentity());
    if (!isSql53ConfigWriterIdentity(identity)) {
      return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL53 writer requires the dedicated production execution role');
    }
  } catch {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL53 writer could not verify the dedicated production execution identity');
  }

  let firstConfiguration;
  let firstSnapshot;
  try {
    firstConfiguration = await getConfiguration(aws);
    firstSnapshot = fingerprintSql53LambdaConfiguration(firstConfiguration);
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'failed to read fresh production Lambda configuration');
  }
  if (!firstSnapshot.ok) return firstSnapshot;
  const first = firstSnapshot.details;
  if (Object.hasOwn(first.variables, SQL53_CONFIG_AUTHORIZATION_ENV)
    || Object.hasOwn(first.variables, SQL53_CONFIG_EXPIRY_ENV)) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'temporary SQL53 authorization variables already exist; reconcile before retrying');
  }
  if (!fingerprintsEqual(receipt.preflight_live_fingerprint, first.fingerprint)) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'production Lambda changed since the signed preflight fingerprint');
  }

  let immediatelyBeforeConfiguration;
  let immediatelyBeforeSnapshot;
  try {
    immediatelyBeforeConfiguration = await getConfiguration(aws);
    immediatelyBeforeSnapshot = fingerprintSql53LambdaConfiguration(immediatelyBeforeConfiguration);
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'failed to re-read production Lambda immediately before configuration update');
  }
  if (!immediatelyBeforeSnapshot.ok) return immediatelyBeforeSnapshot;
  const immediatelyBefore = immediatelyBeforeSnapshot.details;
  if (!fingerprintsEqual(first.fingerprint, immediatelyBefore.fingerprint)) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'production Lambda configuration changed before the guarded update');
  }
  const productionGate = evaluateProductionGate({
    target_environment: SQL53_CONFIG_ENV,
    deployment_type: SQL53_CONFIG_DEPLOYMENT_TYPE,
    workstream_id: receipt.workstream_id,
    production_fingerprint: first.fingerprint,
    immediately_before_fingerprint: immediatelyBefore.fingerprint,
    staging_acceptance: input.staging_acceptance,
    approval: input.approval,
  });
  if (!productionGate.ok) return productionGate;

  const consumed = consumeReceiptOnce(guardRoot, receipt, {
    now,
    actor: input.operator || receipt.operator || env.CHECKSOPS_OPERATOR || env.USER || null,
    script: ctx.script || 'sql53-temporary-lambda-config',
  });
  if (!consumed.ok) return consumed;

  const authorization = {
    token,
    expiresAt: expiry,
    expectedBaseHash: first.fingerprint.configuration_sha256,
  };
  const temporaryVariables = {
    ...immediatelyBefore.variables,
    [SQL53_CONFIG_AUTHORIZATION_ENV]: token,
    [SQL53_CONFIG_EXPIRY_ENV]: expiry,
  };
  const expectedTemporaryHash = configHash(configurationWithVariables(immediatelyBeforeConfiguration, temporaryVariables));
  authorization.expectedTemporaryHash = expectedTemporaryHash;
  let updateAttempted = false;
  let operationFailure = null;
  let inspection = null;
  let cleanup = { complete: true, attempts: 0, drift_detected: false };
  try {
    updateAttempted = true;
    await aws.updateFunctionConfiguration({
      functionName: SQL53_CONFIG_FUNCTION,
      environment: temporaryVariables,
      revisionId: immediatelyBefore.fingerprint.revision_id,
    });
    const updatedConfiguration = await waitForUpdate(aws, {
      attempts: ctx.waitAttempts || 20,
      delayMs: ctx.waitDelayMs ?? 1000,
    });
    const updatedSnapshot = fingerprintSql53LambdaConfiguration(updatedConfiguration);
    if (!updatedSnapshot.ok
      || updatedSnapshot.details.fingerprint.configuration_sha256 !== expectedTemporaryHash) {
      throw new Error('unexpected_lambda_configuration_drift');
    }
    const clockNow = typeof ctx.now === 'function' ? ctx.now() : (ctx.now ?? Date.now());
    if (Date.parse(expiry) <= clockNow) throw new Error('authorization_expired_before_invoke');
    const invocation = await aws.invokeFunction({
      functionName: SQL53_CONFIG_FUNCTION,
      payload: {
        diagnostic: SQL53_CONFIG_DIAGNOSTIC,
        authorization: token,
      },
    });
    inspection = parseInspection(invocation);
  } catch (error) {
    operationFailure = error?.message === 'authorization_expired_before_invoke'
      ? 'temporary authorization expired before invocation'
      : error?.message === 'unexpected_lambda_configuration_drift'
        ? 'production Lambda configuration drifted before invocation'
        : 'SQL53 direct Lambda invocation or temporary configuration update failed';
  } finally {
    if (updateAttempted) {
      try {
        cleanup = await cleanupAuthorization(aws, authorization, ctx);
      } catch {
        cleanup = {
          complete: false,
          attempts: ctx.cleanupAttempts || 3,
          drift_detected: true,
          failure: 'cleanup_attempt_failed',
        };
      }
    }
  }

  if (!cleanup.complete) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'SQL53 temporary authorization cleanup is incomplete; fail closed and reconcile manually', {
      cleanup,
      invocation_attempted: !operationFailure,
    });
  }
  if (cleanup.drift_detected) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'unexpected production Lambda configuration drift was detected during SQL53 cleanup', {
      cleanup,
      authorization_cleanup_verified: true,
    });
  }
  if (operationFailure) {
    return fail(CODES.DEPLOYMENT_COLLISION, operationFailure, {
      cleanup,
      authorization_cleanup_verified: true,
      receipt_consumed: true,
    });
  }
  return ok({
    function_name: SQL53_CONFIG_FUNCTION,
    before_fingerprint: first.fingerprint,
    immediately_before_fingerprint: immediatelyBefore.fingerprint,
    cleanup,
    authorization_cleanup_verified: true,
    receipt_consumed: true,
    inspection,
  });
}
