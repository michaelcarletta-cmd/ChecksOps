#!/usr/bin/env node
/**
 * Official production SQL 53 apply entry.
 * Evaluate-only unless a valid receipt, exclusive lease, APPLY=1, and
 * independent execute authorization are all present. Never retargets the
 * staging executor or production API. Never creates Cursor OIDC access.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { consumeReceiptOnce } from './lib/consumed-receipts.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { enforceScriptGuard } from './require-guard.mjs';
import {
  SQL53_PRODUCTION_APPLY_COMPONENT,
  SQL53_PRODUCTION_APPLY_DEPLOYMENT_TYPE,
  createProductionDatabaseConnect,
  evaluateSql53ProductionApply,
  executeSql53ProductionApply,
  inspectSql53ProductionCatalog,
  loadSql53ProductionApplyPin,
  resolveProductionDatabaseAccess,
} from './lib/sql53-production-apply.mjs';

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const root = deps.root || repoRootFrom(import.meta.url);
  const { flags, opts } = parseArgs(argv);
  const input = readInput(opts, {});
  const pin = loadSql53ProductionApplyPin(root);
  const payload = {
    ...input,
    target_environment: 'production',
    target_component: SQL53_PRODUCTION_APPLY_COMPONENT,
    deployment_type: SQL53_PRODUCTION_APPLY_DEPLOYMENT_TYPE,
    filename: input.filename || pin.filename,
    migration_id: input.migration_id || pin.migration_id,
    source_sha256: input.source_sha256 || pin.source_sha256,
    apply: false,
    execute: false,
  };

  if (payload.sql_text || payload.sql || payload.statement || payload.arbitrary_sql) {
    return printResult(fail(
      CODES.UNRELATED_MUTATION,
      'arbitrary SQL text is forbidden; SQL 53 may apply only the pinned source file',
    ));
  }

  const evaluation = evaluateSql53ProductionApply(payload, { root, pin });
  if (!evaluation.ok) return printResult(evaluation);
  if (!flags.apply && opts.apply !== true && input.action !== 'apply') {
    return printResult(evaluation);
  }

  const authorized = (deps.enforceScriptGuard || enforceScriptGuard)({
    script: import.meta.url,
    workstream_id: opts['workstream-id'] || input.workstream_id,
    commit: opts.commit || input.commit,
    target_environment: 'production',
    target_component: SQL53_PRODUCTION_APPLY_COMPONENT,
    deployment_type: SQL53_PRODUCTION_APPLY_DEPLOYMENT_TYPE,
    preflight_live_fingerprint: input.preflight_live_fingerprint || input.preflight,
    receipt_path: opts.receipt || input.receipt_path,
    receipt: input.receipt,
  }, { root, env });
  if (authorized?.ok === false) return printResult(authorized);

  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY !== '1') {
    return printResult(fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'SQL 53 production apply is blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1',
    ));
  }

  if (authorized?.details?.receipt) {
    const consumed = (deps.consumeReceiptOnce || consumeReceiptOnce)(root, authorized.details.receipt, {
      actor: opts.operator || input.operator || null,
      script: 'sql53-production-apply',
    });
    if (!consumed.ok) return printResult(consumed);
  }

  const url = await (deps.resolveAccess || resolveProductionDatabaseAccess)(env, {
    harness: input.harness === true,
    getSecretValue: deps.getSecretValue,
  });
  if (!url.ok) return printResult(url);
  const connect = typeof deps.connect === 'function'
    ? deps.connect
    : createProductionDatabaseConnect(url.details?.url, { root });

  const result = await (deps.execute || executeSql53ProductionApply)({
    ...input,
    ...payload,
    action: 'apply',
    execute: true,
    authorization_phrase: input.authorization_phrase,
    one_use_id: input.one_use_id,
    harness: input.harness === true,
  }, {
    root,
    pin,
    connect,
    databaseUrl: url.details?.url || null,
    consumedPath: deps.consumedPath,
  });
  return printResult(result);
}

export { inspectSql53ProductionCatalog };

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const code = await main();
  process.exitCode = typeof code === 'number' ? code : (code ? 0 : 1);
}
