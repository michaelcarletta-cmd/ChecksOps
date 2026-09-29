import { createHash } from 'node:crypto';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { validateWorkstreamIdentity } from './identity.mjs';

export function hashSqlDefinition(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

export function evaluateSqlCollision({
  filename,
  migration_id,
  source_sha256,
  target_environment,
  expected_live_definition_sha256,
  live_definition_sha256,
  live_definition,
}) {
  const errors = [];
  if (!filename) errors.push(errorEntry(CODES.INVALID_MANIFEST, 'SQL apply requires filename'));
  if (!migration_id) errors.push(errorEntry(CODES.INVALID_MANIFEST, 'SQL apply requires migration_id'));
  if (!/^[0-9a-f]{64}$/.test(String(source_sha256 || ''))) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'SQL apply requires source SHA256'));
  }
  if (!target_environment) errors.push(errorEntry(CODES.INVALID_MANIFEST, 'SQL apply requires target_environment'));

  const liveHash = live_definition_sha256 || (live_definition != null ? hashSqlDefinition(live_definition) : null);
  if (!expected_live_definition_sha256 || !liveHash) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'SQL apply requires expected and live definition hashes immediately before apply; preflight alone is not sufficient', {
      filename,
      migration_id,
    }));
  } else if (expected_live_definition_sha256 !== liveHash) {
    errors.push(errorEntry(CODES.SQL_COLLISION, 'live SQL/RPC definition differs from the expected baseline; never automatically replace an unexpectedly changed RPC', {
      filename,
      migration_id,
      expected_live_definition_sha256,
      live_definition_sha256: liveHash,
      target_environment,
    }));
  }
  if (errors.length) return failMany(errors, errors.some((row) => row.code === CODES.SQL_COLLISION) ? CODES.SQL_COLLISION : CODES.INVALID_MANIFEST);
  return ok({
    filename,
    migration_id,
    source_sha256,
    target_environment,
    live_definition_sha256: liveHash,
  });
}

export function evaluateSqlMutations(plan = {}) {
  if (plan.silent_backfill === true || plan.mutate_unrelated_data === true) {
    return failMany([errorEntry(
      CODES.UNRELATED_MUTATION,
      'no migration may silently backfill or mutate unrelated data',
      { silent_backfill: plan.silent_backfill === true, mutate_unrelated_data: plan.mutate_unrelated_data === true },
    )], CODES.UNRELATED_MUTATION);
  }
  return ok({ mutation_scope: plan.mutation_scope || 'declared-objects-only' });
}

export function evaluateSqlApply(input = {}) {
  const identity = validateWorkstreamIdentity({
    workstream_id: input.workstream_id,
    branch: input.branch,
    commit: input.commit,
    operator: input.operator,
    target_environment: input.target_environment,
    deployment_type: input.deployment_type || 'sql-apply',
    owned_components: input.owned_components || (input.filename ? [input.filename] : []),
    preflight_live_fingerprint: input.preflight_live_fingerprint || { sql: input.expected_live_definition_sha256 || null },
    build_timestamp: input.build_timestamp,
  });
  if (!identity.ok) return identity;

  const collision = evaluateSqlCollision(input);
  if (!collision.ok) return collision;
  const mutations = evaluateSqlMutations(input.plan || {});
  if (!mutations.ok) return mutations;
  return ok({
    sql_apply_allowed: true,
    ...collision.details,
    ...mutations.details,
  });
}
