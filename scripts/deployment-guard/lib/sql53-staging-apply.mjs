import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, errorEntry, fail, failMany, ok } from './errors.mjs';
import { repoRootFrom } from './paths.mjs';
import { evaluateSqlApply, hashSqlDefinition } from './sql-apply.mjs';

const SHA256_RE = /^[0-9a-f]{64}$/;
const PIN_REL = 'ops/deployment-guard/sql53-staging-authorization.json';

export function loadSql53Pin(root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, PIN_REL), 'utf8'));
}

export function hashFileSha256(root, rel) {
  return createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
}

export function isSql53StagingApply(input = {}) {
  const pin = input.pin || loadSql53Pin(input.root || repoRootFrom(import.meta.url));
  return input.filename === pin.filename || input.migration_id === pin.migration_id;
}

const liveHashOf = (input = {}) => {
  if (input.live_definition != null) return hashSqlDefinition(input.live_definition);
  if (SHA256_RE.test(String(input.live_definition_sha256 || ''))) {
    return input.live_definition_sha256;
  }
  return null;
};

export function classifySql53LivePrerequisite(input = {}, pin = loadSql53Pin(input.root)) {
  const liveHash = liveHashOf(input);
  const hasLiveHash = SHA256_RE.test(String(liveHash || ''));
  const absentHash = pin.absent_live_definition_sha256;
  const provenPresent = hasLiveHash && liveHash !== absentHash;

  if (provenPresent) {
    if (liveHash === pin.intended_definition_sha256) {
      return fail(
        CODES.UNRELATED_MUTATION,
        'settlement function already matches the intended definition; refuse replace',
        {
          function_identity: pin.function_identity,
          live_definition_sha256: liveHash,
          intended_definition_sha256: pin.intended_definition_sha256,
        },
      );
    }
    return fail(
      CODES.SQL_COLLISION,
      'settlement function exists with an unexpected definition; refuse replace',
      {
        function_identity: pin.function_identity,
        live_definition_sha256: liveHash,
        intended_definition_sha256: pin.intended_definition_sha256,
      },
    );
  }
  if (input.exists === true) {
    return fail(
      CODES.SQL_COLLISION,
      'existing settlement function did not return a definition hash; refuse apply',
      { function_identity: pin.function_identity },
    );
  }
  if (input.exists === false && liveHash === absentHash) {
    return ok({
      state: 'absent',
      apply_allowed: true,
      live_definition_sha256: absentHash,
      expected_live_definition_sha256: absentHash,
    });
  }
  return fail(
    CODES.SQL_COLLISION,
    'SQL 53 create requires exists: false and the absent-function live hash immediately before apply',
    {
      function_identity: pin.function_identity,
      exists: input.exists === true ? true : input.exists === false ? false : null,
      live_definition_sha256: liveHash,
      absent_live_definition_sha256: absentHash,
    },
  );
}

export function evaluateSql53PostApplyInspect(inspect = {}, pin = loadSql53Pin()) {
  const functions = Array.isArray(inspect.functions) ? inspect.functions : [];
  const settlement = functions.find((row) => row?.identity === pin.function_identity);
  if (settlement?.exists !== true || settlement.definitionSha256 !== pin.intended_definition_sha256) {
    return fail(
      CODES.SQL_COLLISION,
      'post-apply inspect did not observe the intended settlement function hash',
      {
        function_identity: pin.function_identity,
        expected: pin.intended_definition_sha256,
        observed: settlement?.definitionSha256 || null,
        exists: settlement?.exists === true,
      },
    );
  }
  for (const identity of pin.preserved_function_identities || []) {
    const row = functions.find((item) => item?.identity === identity);
    if (row?.exists !== true) {
      return fail(
        CODES.SQL_COLLISION,
        'post-apply inspect lost an unrelated pinned function',
        { identity },
      );
    }
  }
  return ok({
    verified: true,
    function_identity: pin.function_identity,
    definitionSha256: pin.intended_definition_sha256,
    workflow: pin.post_apply_verification.workflow,
  });
}

export function evaluateSql53StagingApply(input = {}, ctx = {}) {
  const root = ctx.root || input.root || repoRootFrom(import.meta.url);
  const pin = loadSql53Pin(root);
  const errors = [];

  if (input.sql_text != null || input.sql != null || input.statement != null || input.arbitrary_sql != null) {
    return fail(CODES.UNRELATED_MUTATION, 'arbitrary SQL text is forbidden; SQL 53 may apply only the pinned source file');
  }
  if (input.apply === true || input.execute === true || input.action === 'apply') {
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'SQL 53 apply remains independently reviewed; this source package does not execute SQL or issue an apply receipt',
      { apply_authorized: false, execute: false },
    );
  }
  if ((input.target_environment || input.environment) === 'production') {
    return fail(
      CODES.PRODUCTION_APPROVAL_REQUIRED,
      'SQL 53 authorization is staging-only and must never target production',
    );
  }
  if ((input.target_environment || input.environment) !== pin.target_environment) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'SQL 53 authorization requires target_environment=staging'));
  }
  if ((input.target_component || input.component) !== pin.target_component) {
    errors.push(errorEntry(
      CODES.RECEIPT_MISMATCH,
      'SQL 53 authorization requires component=staging-sql; a Lambda or SPA receipt cannot authorize SQL',
      { target_component: input.target_component || input.component || null },
    ));
  }
  if ((input.deployment_type || pin.deployment_type) !== 'sql-apply') {
    errors.push(errorEntry(
      CODES.RECEIPT_MISMATCH,
      'SQL 53 authorization requires deployment_type=sql-apply; sql-executor-invoke is not authorized by this package',
      { deployment_type: input.deployment_type || null },
    ));
  }
  if (input.filename !== pin.filename) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'SQL 53 authorization is bound to the pinned settlement file', {
      filename: input.filename || null,
    }));
  }
  if (input.migration_id !== pin.migration_id) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'SQL 53 authorization is bound to migration_id 53_claim_settlement_breakdown', {
      migration_id: input.migration_id || null,
    }));
  }
  if (input.source_sha256 !== pin.source_sha256) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'SQL 53 source SHA-256 does not match the approved pin', {
      source_sha256: input.source_sha256 || null,
      approved: pin.source_sha256,
    }));
  }
  const diskSha = hashFileSha256(root, pin.filename);
  if (diskSha !== pin.source_sha256) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'pinned SQL 53 file bytes do not match the approved source SHA-256', {
      disk_sha256: diskSha,
      approved: pin.source_sha256,
    }));
  }

  const owned = Array.isArray(input.owned_components) ? input.owned_components : [];
  if (owned.length !== 1 || owned[0] !== pin.filename) {
    errors.push(errorEntry(
      CODES.UNRELATED_MUTATION,
      'SQL 53 authorization may own only the pinned settlement file',
      { owned_components: owned },
    ));
  }
  const forbiddenHit = owned.find((row) => (pin.forbidden_owned_components || []).includes(row));
  if (forbiddenHit) {
    errors.push(errorEntry(
      CODES.UNRELATED_MUTATION,
      'SQL 53 authorization must not include SQL 44, 20261007193200, or the one-writer migration',
      { forbidden: forbiddenHit },
    ));
  }

  if (errors.length) {
    const code = errors.some((row) => row.code === CODES.SQL_COLLISION)
      ? CODES.SQL_COLLISION
      : errors.some((row) => row.code === CODES.UNRELATED_MUTATION)
        ? CODES.UNRELATED_MUTATION
        : errors[0].code;
    return failMany(errors, code);
  }

  const live = classifySql53LivePrerequisite(input, pin);
  if (!live.ok) return live;

  const expectedLive = input.expected_live_definition_sha256 || null;
  const observedLive = liveHashOf(input);
  if (!expectedLive || !observedLive) {
    return fail(
      CODES.SQL_COLLISION,
      'SQL apply requires expected and live definition hashes immediately before apply; preflight alone is not sufficient',
      { filename: pin.filename, migration_id: pin.migration_id },
    );
  }
  if (expectedLive !== pin.absent_live_definition_sha256 || observedLive !== pin.absent_live_definition_sha256) {
    return fail(
      CODES.SQL_COLLISION,
      'SQL 53 create requires the absent-function live hash immediately before apply',
      {
        expected_live_definition_sha256: expectedLive,
        live_definition_sha256: observedLive,
        absent_live_definition_sha256: pin.absent_live_definition_sha256,
      },
    );
  }

  const generic = evaluateSqlApply({
    ...input,
    target_environment: pin.target_environment,
    deployment_type: 'sql-apply',
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: expectedLive,
    live_definition_sha256: observedLive,
    owned_components: [pin.filename],
    plan: { silent_backfill: false, mutate_unrelated_data: false, mutation_scope: 'declared-objects-only' },
  });
  if (!generic.ok) return generic;

  return ok({
    sql53_authorization_ready: true,
    apply_executed: false,
    apply_authorized: false,
    independent_apply_authorization_required: true,
    executor_invoke_forbidden: true,
    live_state: live.details.state,
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    function_identity: pin.function_identity,
    expected_live_definition_sha256: pin.absent_live_definition_sha256,
    intended_definition_sha256: pin.intended_definition_sha256,
    post_apply_verification: pin.post_apply_verification,
    sql_apply: generic.details,
  });
}
