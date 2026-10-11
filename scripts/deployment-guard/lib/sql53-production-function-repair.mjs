import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { repoRootFrom } from './paths.mjs';
import { evaluateSql53StagingApply, loadSql53Pin } from './sql53-staging-apply.mjs';

const PIN_REL = 'ops/deployment-guard/sql53-production-function-repair.json';

export function loadSql53ProductionRepairPin(root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, PIN_REL), 'utf8'));
}

function hashFileSha256(root, rel) {
  return createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
}

export function evaluateSql53ProductionFunctionRepair(input = {}, ctx = {}) {
  const root = ctx.root || input.root || repoRootFrom(import.meta.url);
  const pin = loadSql53ProductionRepairPin(root);
  const stagingPin = loadSql53Pin(root);

  if (input.apply === true || input.execute === true || input.action === 'apply') {
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'SQL 53 production function repair is evaluate-only and does not execute SQL',
      { apply_authorized: false, execute: false },
    );
  }
  if ((input.target_environment || input.environment) !== 'production') {
    return fail(CODES.INVALID_MANIFEST, 'SQL 53 production function repair requires target_environment=production');
  }
  if (pin.apply_authorized === true || pin.execute === true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 53 production function repair pin must remain evaluate-only');
  }
  if (pin.filename !== stagingPin.filename || pin.source_sha256 !== stagingPin.source_sha256) {
    return fail(CODES.SQL_COLLISION, 'production repair pin must reuse the approved SQL 53 source file and SHA-256');
  }
  if (pin.function_identity !== stagingPin.function_identity) {
    return fail(CODES.SQL_COLLISION, 'production repair pin must target only save_claim_settlement_breakdown(uuid,uuid,jsonb)');
  }
  if (hashFileSha256(root, pin.filename) !== pin.source_sha256) {
    return fail(CODES.SQL_COLLISION, 'SQL 53 source bytes do not match the approved production repair pin');
  }
  if (input.filename && input.filename !== pin.filename) {
    return fail(CODES.UNRELATED_MUTATION, 'production repair may own only the pinned settlement file');
  }

  const stagingRefuse = evaluateSql53StagingApply({
    ...input,
    target_environment: 'production',
    target_component: 'staging-sql',
    deployment_type: 'sql-apply',
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    owned_components: [pin.filename],
    apply: false,
    execute: false,
  }, { root });
  if (stagingRefuse.ok || stagingRefuse.code !== CODES.PRODUCTION_APPROVAL_REQUIRED) {
    return fail(
      CODES.PRODUCTION_APPROVAL_REQUIRED,
      'existing SQL 53 staging evaluator must continue to refuse production apply',
      { staging_code: stagingRefuse.code || null },
    );
  }

  return ok({
    sql53_function_repair_ready: true,
    apply_authorized: false,
    apply_executed: false,
    function_identity: pin.function_identity,
    filename: pin.filename,
    source_sha256: pin.source_sha256,
    intended_definition_sha256: pin.intended_definition_sha256,
    production_inspect: pin.production_inspect,
    independent_apply_authorization_required: true,
  });
}
