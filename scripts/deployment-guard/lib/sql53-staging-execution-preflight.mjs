import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, errorEntry, fail, failMany, ok } from './errors.mjs';
import { repoRootFrom } from './paths.mjs';
import { validateReceiptShape } from './receipt.mjs';
import {
  AUTHORIZED_SQL53,
  classifySql53CreateLive,
  evaluateSqlExecutorAuthorization,
} from './sql-executor-auth.mjs';
import { evaluateSql53StagingApply } from './sql53-staging-apply.mjs';

const PIN_REL = 'ops/deployment-guard/sql53-staging-execution-preflight.json';
const SHA256_RE = /^[0-9a-f]{64}$/;
const FORBIDDEN_ACTIONS = new Set(['apply', 'execute', 'ensure', 'invoke', 'create_new', 'restore', 'reclaim']);

export function loadSql53ExecutionPreflight(root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, PIN_REL), 'utf8'));
}

export function hashFileSha256(root, rel) {
  return createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
}

function pinIntegrityErrors(pin, root) {
  const errors = [];
  const flags = [
    'go',
    'apply_authorized',
    'execute',
    'ensure_authorized',
    'invoke_authorized',
    'phase2_authorized',
    'receipt_issued',
  ];
  for (const flag of flags) {
    if (pin[flag] !== false) {
      errors.push(errorEntry(
        CODES.GUARD_APPLY_FORBIDDEN,
        `execution preflight pin ${flag} must remain false`,
        { [flag]: pin[flag] },
      ));
    }
  }
  if (pin.one_use_id != null) {
    errors.push(errorEntry(
      CODES.GUARD_APPLY_FORBIDDEN,
      'execution preflight pin must not issue a one_use_id',
      { one_use_id: pin.one_use_id },
    ));
  }
  if (pin.authorization !== 'source-only') {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'execution preflight must remain source-only'));
  }
  if (pin.target_environment !== 'staging' || pin.deployment_type !== 'sql-executor-invoke') {
    errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'execution preflight is staging sql-executor-invoke only'));
  }
  if (pin.commit !== AUTHORIZED_SQL53.commit || pin.invoke_auth_commit !== AUTHORIZED_SQL53.commit) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'invoke auth commit must remain the approved SQL 53 pin', {
      commit: pin.commit || null,
      invoke_auth_commit: pin.invoke_auth_commit || null,
      approved: AUTHORIZED_SQL53.commit,
    }));
  }
  if (pin.source_sha256 !== AUTHORIZED_SQL53.source_sha256) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'preflight source SHA-256 does not match the approved pin'));
  }
  if (pin.intended_replacement_sha256 !== AUTHORIZED_SQL53.intended_replacement_sha256) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'preflight intended hash does not match the approved pin'));
  }
  if (pin.absent_live_definition_sha256 !== AUTHORIZED_SQL53.absent_live_definition_sha256) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'preflight absent hash does not match the approved pin'));
  }
  const diskSha = hashFileSha256(root, pin.filename);
  if (diskSha !== pin.source_sha256) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'pinned SQL 53 file bytes do not match the approved source SHA-256', {
      disk_sha256: diskSha,
      approved: pin.source_sha256,
    }));
  }
  return errors;
}

export function evaluateSql53StagingExecutionPreflight(input = {}, ctx = {}) {
  const root = ctx.root || input.root || repoRootFrom(import.meta.url);
  const pin = loadSql53ExecutionPreflight(root);
  const errors = pinIntegrityErrors(pin, root);

  if (
    input.apply === true
    || input.execute === true
    || input.ensure === true
    || input.invoke === true
    || input.issue_receipt === true
    || input.acquire_lease === true
    || FORBIDDEN_ACTIONS.has(String(input.action || '').trim())
  ) {
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'SQL 53 execution preflight remains independently reviewed; this package does not ensure, invoke, apply SQL, or issue a receipt',
      {
        go: false,
        apply_authorized: false,
        ensure_authorized: false,
        invoke_authorized: false,
        receipt_issued: false,
      },
    );
  }

  if ((input.target_environment || input.environment) === 'production') {
    return fail(
      CODES.PRODUCTION_APPROVAL_REQUIRED,
      'SQL 53 execution preflight is staging-only and must never target production',
    );
  }
  if ((input.target_environment || input.environment || pin.target_environment) !== 'staging') {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'SQL 53 execution preflight requires target_environment=staging'));
  }
  if ((input.target_component || input.component || pin.target_component) !== 'staging-sql') {
    errors.push(errorEntry(
      CODES.RECEIPT_MISMATCH,
      'SQL 53 execution preflight requires component=staging-sql; a Lambda or SPA receipt cannot authorize SQL',
      { target_component: input.target_component || input.component || null },
    ));
  }
  if ((input.deployment_type || pin.deployment_type) !== 'sql-executor-invoke') {
    errors.push(errorEntry(
      CODES.RECEIPT_MISMATCH,
      'SQL 53 execution preflight requires deployment_type=sql-executor-invoke; sql-apply receipts are not an escape hatch',
      { deployment_type: input.deployment_type || null },
    ));
  }
  if (input.filename && input.filename !== pin.filename) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'SQL 53 execution preflight is bound to the pinned settlement file', {
      filename: input.filename,
    }));
  }
  if (input.migration_id && input.migration_id !== pin.migration_id) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'SQL 53 execution preflight is bound to migration_id 53_claim_settlement_breakdown', {
      migration_id: input.migration_id,
    }));
  }
  if (input.source_sha256 && input.source_sha256 !== pin.source_sha256) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'SQL 53 source SHA-256 does not match the approved pin', {
      source_sha256: input.source_sha256,
      approved: pin.source_sha256,
    }));
  }
  if (input.commit && input.commit !== pin.invoke_auth_commit) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'invoke authorization commit must remain the approved SQL 53 pin', {
      commit: input.commit,
      approved: pin.invoke_auth_commit,
    }));
  }

  const owned = Array.isArray(input.owned_components) ? input.owned_components : pin.owned_components;
  if (!Array.isArray(owned) || owned.length !== 1 || owned[0] !== pin.filename) {
    errors.push(errorEntry(
      CODES.UNRELATED_MUTATION,
      'SQL 53 execution preflight may own only the pinned settlement file',
      { owned_components: owned },
    ));
  }
  const forbiddenHit = (owned || []).find((row) => (pin.forbidden_owned_components || []).includes(row));
  if (forbiddenHit) {
    errors.push(errorEntry(
      CODES.UNRELATED_MUTATION,
      'SQL 53 execution preflight must not include SQL 44, 20261007193200, or the one-writer migration',
      { forbidden: forbiddenHit },
    ));
  }

  if (input.sql_text != null || input.sql != null || input.statement != null || input.arbitrary_sql != null) {
    return fail(CODES.UNRELATED_MUTATION, 'arbitrary SQL text is forbidden; SQL 53 may apply only the pinned source file');
  }

  if (input.receipt && typeof input.receipt === 'object') {
    const shape = validateReceiptShape(input.receipt, { requireMac: true });
    if (!shape.ok) return shape;
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'this source-only preflight must not carry a live apply receipt',
    );
  }

  if (errors.length) {
    const code = errors.some((row) => row.code === CODES.GUARD_APPLY_FORBIDDEN)
      ? CODES.GUARD_APPLY_FORBIDDEN
      : errors.some((row) => row.code === CODES.SQL_COLLISION)
        ? CODES.SQL_COLLISION
        : errors.some((row) => row.code === CODES.UNRELATED_MUTATION)
          ? CODES.UNRELATED_MUTATION
          : errors[0].code;
    return failMany(errors, code);
  }

  const inspect = input.inspect || {};
  const settlement = Array.isArray(inspect.functions)
    ? inspect.functions.find((row) => row?.identity === pin.function_identity)
    : null;
  const exists = settlement ? settlement.exists === true : inspect.exists;
  const liveHash = SHA256_RE.test(String(inspect.live_definition_sha256 || ''))
    ? inspect.live_definition_sha256
    : settlement && SHA256_RE.test(String(settlement.definitionSha256 || ''))
      ? settlement.definitionSha256
      : exists === false
        ? pin.absent_live_definition_sha256
        : null;

  let liveState = null;
  if (exists === true || exists === false || liveHash) {
    liveState = classifySql53CreateLive({
      exists,
      live_definition_sha256: liveHash,
    }, AUTHORIZED_SQL53);
    if (!liveState.ok) return liveState;
  }

  const historical = pin.historical_absent_inspect || {};
  const inspectIsHistorical = input.inspect_workflow_run === historical.workflow_run
    || inspect.workflow_run === historical.workflow_run
    || input.immediately_before !== true;

  return ok({
    go: false,
    sql53_execution_preflight_ready: true,
    apply_executed: false,
    apply_authorized: false,
    ensure_authorized: false,
    invoke_authorized: false,
    receipt_issued: false,
    independent_execution_authorization_required: true,
    immediately_before_inspect: inspectIsHistorical === false && liveState?.ok === true,
    historical_inspect_is_not_immediately_before: true,
    live_executor_inspected: pin.live_executor_inspect?.completed === true,
    live_state: liveState?.details?.state || null,
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    function_identity: pin.function_identity,
    ensure_source_commit: pin.ensure_source_commit,
    invoke_auth_commit: pin.invoke_auth_commit,
    expected_live_definition_sha256: pin.absent_live_definition_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    post_apply_verification: pin.post_apply_verification,
    required_owner_approvals: pin.required_owner_approvals,
  });
}

export function evaluateSql53FailClosedSurfaces(input = {}, ctx = {}) {
  const root = ctx.root || input.root || repoRootFrom(import.meta.url);
  const pin = loadSql53ExecutionPreflight(root);
  const apply = evaluateSql53StagingApply({
    workstream_id: input.workstream_id || 'staging-sql53-3bc9',
    branch: input.branch || 'cursor/staging-sql53-execution-preflight-3bc9',
    commit: pin.invoke_auth_commit,
    operator: input.operator || 'preflight',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-apply',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: pin.absent_live_definition_sha256,
    live_definition_sha256: pin.absent_live_definition_sha256,
    exists: false,
    apply: true,
    action: 'apply',
  }, { root });
  const expired = evaluateSqlExecutorAuthorization({
    workstream_id: 'staging-sql53-3bc9',
    branch: 'cursor/staging-sql53-execution-preflight-3bc9',
    commit: pin.invoke_auth_commit,
    operator: 'preflight',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    expected_live_definition_sha256: pin.absent_live_definition_sha256,
    one_use_id: 'sql53-preflight-expired',
    expiry: '2020-01-01T00:00:00.000Z',
    action: 'authorize',
    function_name: pin.function_name,
    build_timestamp: '2026-10-09T16:00:00.000Z',
  }, { now: Date.parse('2026-10-09T16:00:00.000Z') });
  const unrelated = evaluateSqlExecutorAuthorization({
    workstream_id: 'staging-sql53-3bc9',
    branch: 'cursor/staging-sql53-execution-preflight-3bc9',
    commit: pin.invoke_auth_commit,
    operator: 'preflight',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [pin.forbidden_owned_components[0]],
    filename: pin.forbidden_owned_components[0],
    migration_id: '44_claim_ledger_link_or_create',
    source_sha256: pin.source_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    expected_live_definition_sha256: pin.absent_live_definition_sha256,
    one_use_id: 'sql53-preflight-unrelated',
    expiry: '2026-10-09T17:00:00.000Z',
    action: 'authorize',
    function_name: pin.function_name,
    build_timestamp: '2026-10-09T16:00:00.000Z',
  }, { now: Date.parse('2026-10-09T16:00:00.000Z') });
  const collision = classifySql53CreateLive({
    exists: true,
    live_definition_sha256: '9'.repeat(64),
  });
  const alreadyIntended = classifySql53CreateLive({
    exists: true,
    live_definition_sha256: pin.intended_replacement_sha256,
  });
  const handwritten = validateReceiptShape({
    kind: 'deployment-guard-receipt',
    workstream_id: 'staging-sql53-3bc9',
    commit: pin.invoke_auth_commit,
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
  }, { requireMac: true });

  return ok({
    sql_apply_apply_forbidden: apply.code === CODES.GUARD_APPLY_FORBIDDEN,
    expired_authorization: expired.code === CODES.RECEIPT_EXPIRED,
    unrelated_migration: unrelated.code === CODES.SQL_COLLISION,
    existing_function_collision: collision.code === CODES.SQL_COLLISION,
    intended_already_present: alreadyIntended.code === CODES.UNRELATED_MUTATION,
    handwritten_receipt_forged: handwritten.code === CODES.RECEIPT_FORGED,
    fail_closed: (
      apply.code === CODES.GUARD_APPLY_FORBIDDEN
      && expired.code === CODES.RECEIPT_EXPIRED
      && unrelated.code === CODES.SQL_COLLISION
      && collision.code === CODES.SQL_COLLISION
      && alreadyIntended.code === CODES.UNRELATED_MUTATION
      && handwritten.code === CODES.RECEIPT_FORGED
    ),
  });
}
